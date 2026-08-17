/**
 * Read the live contract state and report why rounds are not being judged.
 *
 * Every check here is a deterministic storage read, so it needs no private key
 * and costs no gas — only GENLAYER_CONTRACT_ADDRESS.
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... pnpm --filter @workspace/scripts diagnose
 *
 * "[EXPECTED] stage N is not registered" has more than one cause, and they are
 * indistinguishable from the error alone: the stages may never have been
 * registered, or they may have been registered on a *different* deployment of
 * the contract than the address the site is pointed at.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const TOTAL_STAGES = 20;
/** Studio rate-limits a client to 30 RPC calls per minute. Stay under it. */
const RPC_PACE_MS = 2_500;

const CONTRACT = process.env.GENLAYER_CONTRACT_ADDRESS;
if (!CONTRACT) {
  console.error("Missing required environment variable: GENLAYER_CONTRACT_ADDRESS");
  process.exit(1);
}

async function main(): Promise<void> {
  // Reads still go through a client, but the account is never used to sign.
  const client = createClient({ chain: studionet, account: createAccount() });
  const address = CONTRACT as `0x${string}`;

  // Every read here takes either no args or a single stage id.
  const read = async (functionName: string, args: number[] = []) =>
    client.readContract({ address, functionName, args });

  console.log(`Contract: ${CONTRACT}`);
  console.log(`Explorer: https://explorer-studio.genlayer.com/address/${CONTRACT}\n`);

  try {
    console.log(`owner:              ${String(await read("get_owner"))}`);
  } catch (err) {
    console.error(`  Could not read get_owner — is this address a MochiMindValidator?`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const registeredRaw = String(await read("get_registered_stages"));
  console.log(`registered stages:  ${registeredRaw}`);

  let registered: number[] = [];
  try {
    const parsed = JSON.parse(registeredRaw) as unknown;
    if (Array.isArray(parsed)) registered = parsed.map(Number);
  } catch {
    /* fall through — printed raw above */
  }

  console.log(`round count:        ${String(await read("get_round_count"))}`);

  // Competitive state. Both of these are computed by the contract from signed
  // rounds it scored itself — there is no path that writes a score to it.
  try {
    console.log(`players:            ${String(await read("get_player_count"))}`);

    const board = JSON.parse(String(await read("get_leaderboard", [3]))) as Array<{
      name?: string;
      player?: string;
      score?: number;
      total?: number;
      rounds?: number;
    }>;

    if (board.length === 0) {
      console.log("leaderboard:        empty — no rounds scored yet");
    } else {
      console.log("leaderboard:");
      for (const [i, entry] of board.entries()) {
        const who = entry.name || entry.player || "?";
        console.log(
          `  ${i + 1}. ${who} — ${entry.score ?? 0}/${entry.total ?? 0} in ${entry.rounds ?? 0} rounds`,
        );
      }
    }
  } catch {
    // An older deployment predates these views. Everything above still applies.
    console.log("players:            unavailable — this deployment has no player views");
    console.log("                    (redeploy from contracts/MochiMindValidator.py)");
  }

  console.log("");

  if (registered.length === 0) {
    console.error("No stages are registered on this contract.");
    console.error("Every submit_pick and analyze_stage will revert with");
    console.error('"[EXPECTED] stage N is not registered" until you run:\n');
    console.error("  pnpm --filter @workspace/scripts register-stages\n");
    console.error("If you believe you already registered, you almost certainly");
    console.error("registered against a different deployment — check that the");
    console.error("address above matches GENLAYER_CONTRACT_ADDRESS in Vercel.");
    process.exit(1);
  }

  let judged = 0;
  const unregistered: number[] = [];
  const unjudged: number[] = [];

  for (let stageId = 1; stageId <= TOTAL_STAGES; stageId++) {
    if (!registered.includes(stageId)) {
      unregistered.push(stageId);
      continue;
    }
    // Studio allows 30 RPC calls a minute per client, and this loop alone is 20
    // of them. Without the pause the script reports a rate-limit error as
    // though the contract were broken, which is exactly the confusion it exists
    // to prevent.
    await new Promise((resolve) => setTimeout(resolve, RPC_PACE_MS));

    const verdict = String(await read("get_stage_result", [stageId]));
    if (verdict && verdict !== "{}") judged++;
    else unjudged.push(stageId);
  }

  console.log(`judged (cached):    ${judged}/${TOTAL_STAGES}`);
  if (unregistered.length) console.log(`not registered:     ${unregistered.join(", ")}`);
  if (unjudged.length) console.log(`registered, cold:   ${unjudged.join(", ")}`);

  console.log("");
  if (unregistered.length) {
    console.log("Fix: pnpm --filter @workspace/scripts register-stages");
  } else if (unjudged.length) {
    console.log("Fix: pnpm --filter @workspace/scripts warm-stages");
  } else {
    console.log("All stages registered and judged — rounds should settle instantly.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
