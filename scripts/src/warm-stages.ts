/**
 * Pre-compute the consensus verdict for every registered stage.
 *
 * A cold stage costs a full consensus round: the leader fetches the image and
 * runs the vision model, then every validator independently repeats the work.
 * That is 60–120 s — longer than a Vercel serverless function is allowed to
 * run. Once a stage has a verdict the contract short-circuits to the cached one
 * and `submit_pick` answers immediately, which is what keeps the deployed game
 * inside its time budget.
 *
 * So: run this once after registering the stages, and again after
 * re-registering any stage (re-registration deliberately clears the old
 * verdict, since it was formed over a different image).
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... \
 *   GENLAYER_PRIVATE_KEY=0x... \
 *   pnpm --filter @workspace/scripts warm-stages
 *
 * The key must belong to the account that deployed the contract — analyze_stage
 * is owner-only. This runs on your machine, not in CI, so it has no timeout.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

import { executionError } from "./receipt";

const TOTAL_STAGES = 20;

const CONTRACT = requireEnv("GENLAYER_CONTRACT_ADDRESS");
const PRIVATE_KEY = requireEnv("GENLAYER_PRIVATE_KEY");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function hasVerdict(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw || raw === "{}") return false;
  try {
    const parsed = JSON.parse(raw) as { final_colors?: unknown };
    return Array.isArray(parsed.final_colors) && parsed.final_colors.length >= 2;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const account = createAccount(PRIVATE_KEY as `0x${string}`);
  const client = createClient({ chain: studionet, account });

  const address = CONTRACT as `0x${string}`;
  let warmed = 0;
  let skipped = 0;
  const failed: number[] = [];

  console.log(`Warming ${TOTAL_STAGES} stages on ${CONTRACT}`);
  console.log("A cold stage takes 60-120 s; already-judged stages are skipped.\n");

  for (let stageId = 1; stageId <= TOTAL_STAGES; stageId++) {
    const label = `stage ${String(stageId).padStart(2, "0")}`;

    const existing = await client
      .readContract({ address, functionName: "get_stage_result", args: [stageId] })
      .catch(() => null);

    if (hasVerdict(existing)) {
      console.log(`  skip ${label}  already judged`);
      skipped++;
      continue;
    }

    const started = Date.now();
    try {
      const txHash = await client.writeContract({
        address,
        functionName: "analyze_stage",
        args: [stageId],
        // genlayer-js 1.1.8 types `value` as required even though it defaults
        // to 0n at runtime. Judging a stage transfers nothing.
        value: 0n,
      });

      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.FINALIZED,
        // Studio allows 30 RPC calls a minute per client. Polling a 60-120 s
        // round every 3 s spends 20-40 of them on one receipt, so the script
        // starts reporting rate-limit errors as though the round had failed.
        interval: 6000,
        retries: 60,
      });

      // Finalized can still mean reverted — an unregistered stage fails here.
      const reverted = executionError(receipt);
      if (reverted) {
        throw new Error(
          `reverted on-chain: ${reverted} (is the stage registered? run register-stages first)`,
        );
      }

      const verdict = await client.readContract({
        address,
        functionName: "get_stage_result",
        args: [stageId],
      });

      if (!hasVerdict(verdict)) {
        throw new Error("finalized but stored no verdict");
      }

      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`  ok   ${label}  ${seconds}s  tx ${txHash}`);
      warmed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL ${label}  ${message.replace(/\s+/g, " ").slice(0, 200)}`);
      failed.push(stageId);
    }
  }

  console.log(`\nWarmed ${warmed}, skipped ${skipped}, failed ${failed.length}`);
  console.log(`Explorer: https://explorer-studio.genlayer.com/address/${CONTRACT}`);

  if (failed.length > 0) {
    console.error(
      `\nStages ${failed.join(", ")} have no verdict. Players hitting them will wait\n` +
        `through a live consensus round. Common causes: the stage was never\n` +
        `registered, or its image URL is unreachable.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
