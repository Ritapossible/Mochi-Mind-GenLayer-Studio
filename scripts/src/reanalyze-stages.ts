/**
 * Force a fresh consensus judgment on stages that already hold a verdict.
 *
 * `warm-stages` deliberately skips any stage that has been judged, so it cannot
 * be used to correct one. This can: `analyze_stage` always re-runs the
 * nondeterministic block and overwrites the cached verdict.
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... \
 *   GENLAYER_PRIVATE_KEY=0x... \
 *   STAGES=4,5,9,10,12,13,19 \
 *   pnpm --filter @workspace/scripts reanalyze-stages
 *
 * The key must belong to the account that deployed the contract — analyze_stage
 * is owner-only.
 *
 * The judgment is a vision model reaching validator consensus, not a setter:
 * you cannot tell it what to answer, and re-running a stage may return what it
 * returned before. This prints the verdict on both sides of the call so a
 * no-op re-roll is visible rather than silent. Stages left unchanged after a
 * few attempts are telling you the image itself reads that way to the
 * validators, and the honest fix is the image or the candidate colors, not
 * another round.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

import { executionError } from "./receipt";

const CONTRACT = requireEnv("GENLAYER_CONTRACT_ADDRESS");
const PRIVATE_KEY = requireEnv("GENLAYER_PRIVATE_KEY");
const STAGES = parseStages(requireEnv("STAGES"));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function parseStages(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error(`STAGES did not contain any stage ids: ${raw}`);
    process.exit(1);
  }
  return ids;
}

/** `final_colors` as a printable pair, or null when the stage is unjudged. */
function verdictOf(raw: unknown): { colors: string[]; coverage: unknown } | null {
  if (typeof raw !== "string" || !raw || raw === "{}") return null;
  try {
    const parsed = JSON.parse(raw) as { final_colors?: unknown; coverage?: unknown };
    if (!Array.isArray(parsed.final_colors)) return null;
    return { colors: parsed.final_colors as string[], coverage: parsed.coverage };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const account = createAccount(PRIVATE_KEY as `0x${string}`);
  const client = createClient({ chain: studionet, account });
  const address = CONTRACT as `0x${string}`;

  const read = (stageId: number) =>
    client.readContract({ address, functionName: "get_stage_result", args: [stageId] });

  console.log(`Re-judging ${STAGES.length} stage(s) on ${CONTRACT}`);
  console.log("Each stage is a full consensus round: 60-120 s.\n");

  const changed: number[] = [];
  const unchanged: number[] = [];
  const failed: number[] = [];

  for (const stageId of STAGES) {
    const label = `stage ${String(stageId).padStart(2, "0")}`;
    const before = verdictOf(await read(stageId).catch(() => null));
    console.log(`${label} before  ${before ? before.colors.join(" + ") : "(unjudged)"}`);

    const started = Date.now();
    try {
      const txHash = await client.writeContract({
        address,
        functionName: "analyze_stage",
        args: [stageId],
        // genlayer-js 1.1.8 types `value` as required though it defaults to 0n.
        value: 0n,
      });

      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.FINALIZED,
        // Studio allows 30 RPC calls a minute per client; a 6 s interval keeps
        // one receipt from spending the whole budget.
        interval: 6000,
        retries: 60,
      });

      const reverted = executionError(receipt);
      if (reverted) {
        console.log(`${label} FAILED   ${reverted}\n`);
        failed.push(stageId);
        continue;
      }

      const after = verdictOf(await read(stageId).catch(() => null));
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`${label} after   ${after ? after.colors.join(" + ") : "(unjudged)"}  (${secs} s)`);
      console.log(`${label} coverage ${JSON.stringify(after?.coverage ?? null)}\n`);

      const same =
        before !== null &&
        after !== null &&
        [...before.colors].sort().join("|") === [...after.colors].sort().join("|");
      (same ? unchanged : changed).push(stageId);
    } catch (err) {
      console.log(`${label} FAILED   ${err instanceof Error ? err.message : String(err)}\n`);
      failed.push(stageId);
    }
  }

  console.log(`changed:   ${changed.join(", ") || "none"}`);
  console.log(`unchanged: ${unchanged.join(", ") || "none"}`);
  console.log(`failed:    ${failed.join(", ") || "none"}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
