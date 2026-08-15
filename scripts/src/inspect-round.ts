/**
 * Run one analyze_stage round and dump the raw transaction receipt.
 *
 * warm-stages can report "finalized but stored no verdict", which means the
 * round settled without a revert we could detect and yet wrote nothing. That
 * is unfalsifiable from the outside: the reason lives in fields of the receipt
 * that the other scripts never print. This prints the whole receipt so the
 * actual failure — a consensus disagreement, an LLM error, an unreachable
 * image — identifies itself.
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... GENLAYER_PRIVATE_KEY=0x... \
 *   MOCHI_STAGE_ID=1 pnpm --filter @workspace/scripts inspect-round
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const CONTRACT = requireEnv("GENLAYER_CONTRACT_ADDRESS");
const PRIVATE_KEY = requireEnv("GENLAYER_PRIVATE_KEY");
const STAGE_ID = Number(process.env.MOCHI_STAGE_ID ?? "1");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

/** Receipts contain bigints, which JSON.stringify refuses to serialize. */
function dump(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
    2,
  );
}

async function main(): Promise<void> {
  const account = createAccount(PRIVATE_KEY as `0x${string}`);
  const client = createClient({ chain: studionet, account });
  const address = CONTRACT as `0x${string}`;

  const spec = await client.readContract({
    address,
    functionName: "get_stage",
    args: [STAGE_ID],
  });
  console.log(`Registered spec for stage ${STAGE_ID}:\n  ${String(spec)}\n`);

  console.log(`Running analyze_stage(${STAGE_ID}) ...`);
  const txHash = await client.writeContract({
    address,
    functionName: "analyze_stage",
    args: [STAGE_ID],
    value: 0n,
  });
  console.log(`  tx ${txHash}`);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: 3000,
    retries: 80,
  });

  console.log(`\n─── receipt keys ───\n${Object.keys(receipt).join(", ")}\n`);
  console.log(`─── full receipt ───\n${dump(receipt)}\n`);

  const verdict = await client.readContract({
    address,
    functionName: "get_stage_result",
    args: [STAGE_ID],
  });
  console.log(`─── stored verdict ───\n${String(verdict) || "(empty)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
