/**
 * End-to-end proof, against the live deployment, of the two things the last
 * review asked for.
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... \
 *   GENLAYER_PRIVATE_KEY=0x... \
 *   pnpm --filter @workspace/scripts test-round [stageId]
 *
 * It plays as a throwaway player nobody has ever seen, relayed by the owner key
 * exactly as the game's server relays, and checks:
 *
 *   evidence   the image URL the contract registered serves bytes whose SHA-256
 *              is the digest the validators recorded — the binding the browser
 *              relies on to say "this is the image that was judged"
 *   identity   the round lands credited to the *player*, not the relayer
 *   scoring    the score appears in the player's on-chain record and on the
 *              contract's leaderboard, without anything having submitted one
 *   forgery    a round the relayer signs for a player it does not control is
 *              rejected on-chain
 *   replay     re-relaying a round that already landed is rejected on-chain
 *
 * The last two are the point: they must FAIL, and the script fails if they
 * succeed.
 */

import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { createHash } from "node:crypto";

import { executionError } from "./receipt";
import { roundMessage } from "../../artifacts/mochi-mind/src/game/roundMessage";

const CONTRACT = process.env.GENLAYER_CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY;

if (!CONTRACT || !PRIVATE_KEY) {
  console.error("Set GENLAYER_CONTRACT_ADDRESS and GENLAYER_PRIVATE_KEY");
  process.exit(1);
}

const STAGE_ID = Number(process.argv[2] ?? 1);
const address = CONTRACT as `0x${string}`;

const relayer = createAccount(PRIVATE_KEY as `0x${string}`);
const client = createClient({ chain: studionet, account: relayer });

const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

/** Every argument this script passes is a number, a string, or a list of strings. */
type Arg = string | number | string[];

async function read(functionName: string, args: Arg[] = []): Promise<string> {
  return String(await client.readContract({ address, functionName, args }));
}

type Outcome = { ok: boolean; error: string };

/** Relay a round and report whether the contract accepted it. */
async function relay(args: Arg[]): Promise<Outcome> {
  try {
    const txHash = await client.writeContract({
      address,
      functionName: "submit_pick",
      args,
      value: 0n,
    });

    const receipt = (await client.waitForTransactionReceipt({
      hash: txHash as Parameters<typeof client.waitForTransactionReceipt>[0]["hash"],
      status: TransactionStatus.FINALIZED,
      // Studio allows 30 RPC calls a minute. Polling every 3 s spends 20 of them
      // on one receipt and the script starts failing on the rate limit instead
      // of on anything real.
      interval: 6000,
      retries: 60,
    })) as unknown as Record<string, unknown>;

    const reverted = executionError(receipt);
    if (reverted) return { ok: false, error: reverted };
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  console.log(`contract ${CONTRACT}`);
  console.log(`relayer  ${relayer.address}`);
  console.log(`stage    ${STAGE_ID}\n`);

  // ── Evidence ───────────────────────────────────────────────────────────────
  console.log("evidence");
  const evidence = JSON.parse(await read("get_stage_evidence", [STAGE_ID])) as {
    registered: boolean;
    image_url?: string;
    options?: string[];
    image_sha256?: string;
    judged?: boolean;
  };

  check("stage is registered", evidence.registered === true);
  if (!evidence.registered || !evidence.image_url) {
    console.log("\nRegister the stages first: pnpm --filter @workspace/scripts register-stages");
    process.exit(1);
  }

  console.log(`         url     ${evidence.image_url}`);
  console.log(`         options ${(evidence.options ?? []).join(", ")}`);
  check("stage has a consensus verdict", evidence.judged === true,
    evidence.judged ? "" : "run warm-stages, or this round will run a cold consensus round");

  const response = await fetch(evidence.image_url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log(`         served  ${digest} (${bytes.length} bytes)`);
  console.log(`         judged  ${evidence.image_sha256 || "(none yet)"}`);

  if (evidence.image_sha256) {
    check(
      "served image is byte-identical to the judged image",
      digest === evidence.image_sha256.toLowerCase(),
    );
  }

  // ── A player nobody has seen before ────────────────────────────────────────
  const player = createAccount(generatePrivateKey());
  const playerId = player.address.toLowerCase();
  const name = `e2e-${playerId.slice(2, 8)}`;
  const picks = (evidence.options ?? []).slice(0, 2);

  console.log(`\nplayer   ${playerId} ("${name}")`);
  console.log(`picks    ${picks.join(", ")}\n`);

  const before = JSON.parse(await read("get_player", [playerId])) as { rounds: number };
  check("player has no prior record", Number(before.rounds) === 0);

  // ── A signed round ─────────────────────────────────────────────────────────
  console.log("\nsigned round");
  const nonce = Date.now();
  const message = roundMessage({ player: playerId, stageId: STAGE_ID, picks, name, nonce });
  const signature = await player.signMessage({ message });

  const accepted = await relay([STAGE_ID, picks, playerId, name, nonce, signature]);
  check("contract accepted the signed round", accepted.ok, accepted.error);

  if (accepted.ok) {
    const roundCount = Number(await read("get_round_count"));
    const record = JSON.parse(await read("get_round", [roundCount - 1])) as Record<string, unknown>;

    check("round is credited to the player", String(record.player) === playerId,
      `player=${String(record.player)}`);
    check("round records the relayer separately",
      String(record.relayer).toLowerCase() === relayer.address.toLowerCase(),
      `relayer=${String(record.relayer)}`);
    check("round is marked signature-authenticated", String(record.auth) === "signature");
    check("round carries the judged image digest", String(record.image_sha256).length === 64);

    const after = JSON.parse(await read("get_player", [playerId])) as {
      rounds: number; score: number; name: string; total: number;
    };
    console.log(
      `         record  ${after.name} — ${after.score}/${after.total} over ${after.rounds} round(s)`,
    );
    check("player's on-chain record advanced", Number(after.rounds) === 1);
    check("display name is bound to the address", after.name === name);

    const board = JSON.parse(await read("get_leaderboard", [50])) as Array<{ player: string }>;
    check(
      "player appears on the contract's leaderboard",
      board.some((e) => e.player === playerId),
      `${board.length} entries`,
    );
  }

  // ── Forgery: the relayer plays as a player it cannot sign for ───────────────
  console.log("\nforgery (must be rejected)");
  const victim = createAccount(generatePrivateKey()).address.toLowerCase();
  const forged = await relay([STAGE_ID, picks, victim, "impostor", Date.now(), signature]);
  check("relayer cannot forge a round for another address", !forged.ok);

  // ── Replay: the same signed round, sent twice ──────────────────────────────
  console.log("\nreplay (must be rejected)");
  const replayed = await relay([STAGE_ID, picks, playerId, name, nonce, signature]);
  check("the same signed round cannot be relayed twice", !replayed.ok);

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
