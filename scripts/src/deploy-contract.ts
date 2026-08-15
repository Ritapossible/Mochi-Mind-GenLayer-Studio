/**
 * Deploy contracts/MochiMindValidator.py to studionet.
 *
 * The deploying account becomes the contract owner, and only the owner can
 * register stages or force a re-judge. Deploying produces a NEW address —
 * nothing carries over from a previous deployment, so the stages have to be
 * registered and warmed again afterwards.
 *
 *   GENLAYER_PRIVATE_KEY=0x... pnpm --filter @workspace/scripts deploy-contract
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Missing required environment variable: GENLAYER_PRIVATE_KEY");
  process.exit(1);
}

const CONTRACT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../contracts/MochiMindValidator.py",
);

function dump(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
    2,
  );
}

async function main(): Promise<void> {
  const code = readFileSync(CONTRACT_PATH, "utf-8");
  console.log(`Deploying ${CONTRACT_PATH}`);
  console.log(`  ${code.length} bytes of source\n`);

  const account = createAccount(PRIVATE_KEY as `0x${string}`);
  const client = createClient({ chain: studionet, account });

  console.log(`Deploying as: ${String(account.address)}`);

  const txHash = await client.deployContract({ code });
  console.log(`  tx ${txHash}`);

  const receipt = await client.waitForTransactionReceipt({
    // deployContract returns a plain `0x${string}`, but waitForTransactionReceipt
    // wants the length-branded Hash. Same value, narrower type.
    hash: txHash as Parameters<typeof client.waitForTransactionReceipt>[0]["hash"],
    status: TransactionStatus.FINALIZED,
    interval: 3000,
    retries: 80,
  });

  const record = receipt as unknown as Record<string, unknown>;
  const deployed = String(record.to_address ?? record.contract_address ?? "");

  if (!deployed || deployed === "undefined") {
    console.error("\nCould not determine the deployed address. Full receipt:\n");
    console.error(dump(receipt));
    process.exit(1);
  }

  console.log(`\nstatus: ${String(record.status_name ?? record.status)}`);

  // A deploy can finalize having failed to initialise. Reading back the owner
  // proves the constructor ran and the contract is callable.
  const owner = await client.readContract({
    address: deployed as `0x${string}`,
    functionName: "get_owner",
    args: [],
  });

  console.log(`\nDeployed:  ${deployed}`);
  console.log(`Owner:     ${String(owner)}`);
  console.log(`Explorer:  https://explorer-studio.genlayer.com/address/${deployed}`);
  console.log(`\nNext:`);
  console.log(`  1. Set GENLAYER_CONTRACT_ADDRESS=${deployed} in Vercel, then redeploy`);
  console.log(`  2. pnpm --filter @workspace/scripts register-stages`);
  console.log(`  3. pnpm --filter @workspace/scripts warm-stages`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
