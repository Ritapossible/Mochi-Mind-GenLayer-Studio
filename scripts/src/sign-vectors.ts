/**
 * Generate the signature fixtures the contract's crypto is tested against.
 *
 *   pnpm --filter @workspace/scripts sign-vectors
 *
 * The contract verifies rounds with a keccak-256 and a secp256k1 recovery it
 * implements itself, because there is no ecrecover to call from GenVM. Code
 * like that is worth exactly as much as its test vectors, so these are produced
 * the same way a real round is: by the browser's own message builder
 * (`artifacts/mochi-mind/src/game/roundMessage.ts`) and a real signature from
 * genlayer-js — the same `signMessage` the game calls.
 *
 * `contracts/tests/test_signed_rounds.py` then feeds them to the Python side
 * and checks that it recovers the address that signed each one. If the two
 * message builders ever drift apart, that test fails instead of every round
 * failing on-chain.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAccount, generatePrivateKey } from "genlayer-js";
import {
  normalizeName,
  roundMessage,
  SIGNING_DOMAIN,
} from "../../artifacts/mochi-mind/src/game/roundMessage";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(HERE, "..", "..", "contracts", "tests", "round_vectors.json");

type Vector = {
  description: string;
  address: string;
  stageId: number;
  picks: string[];
  name: string;
  nonce: number;
  message: string;
  signature: string;
};

/** Cases chosen to cover what a real round can contain, not just the happy path. */
const CASES: Array<{ description: string; stageId: number; picks: string[]; name: string; nonce: number }> = [
  { description: "first round, plain name", stageId: 1, picks: ["Yellow", "Orange"], name: "rita", nonce: 0 },
  { description: "millisecond-timestamp nonce", stageId: 7, picks: ["Gray", "Blue"], name: "RitaCryptoTips", nonce: 1_767_225_600_123 },
  { description: "color name containing a space", stageId: 8, picks: ["Neon Green", "Black"], name: "player-two", nonce: 42 },
  { description: "picks in reverse order", stageId: 8, picks: ["Black", "Neon Green"], name: "player-two", nonce: 43 },
  { description: "unicode display name", stageId: 20, picks: ["Purple", "White"], name: "リタ 🍡", nonce: 99 },
  { description: "name at the 32-character limit", stageId: 15, picks: ["White", "Silver"], name: "x".repeat(32), nonce: 7 },
  { description: "anonymous player", stageId: 3, picks: ["Blue", "Cyan"], name: "Anonymous", nonce: 1 },
  { description: "highest stage id", stageId: 20, picks: ["Purple", "Lavender"], name: "edge", nonce: 2 ** 40 },
];

async function main(): Promise<void> {
  const vectors: Vector[] = [];

  for (const testCase of CASES) {
    const account = createAccount(generatePrivateKey());
    const player = account.address.toLowerCase();
    const name = normalizeName(testCase.name);

    const message = roundMessage({
      player,
      stageId: testCase.stageId,
      picks: testCase.picks,
      name,
      nonce: testCase.nonce,
    });

    vectors.push({
      description: testCase.description,
      address: player,
      stageId: testCase.stageId,
      picks: testCase.picks,
      name,
      nonce: testCase.nonce,
      message,
      signature: await account.signMessage({ message }),
    });
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify({ domain: SIGNING_DOMAIN, vectors }, null, 2)}\n`,
    "utf-8",
  );

  console.log(`Wrote ${vectors.length} vectors to ${OUT_FILE}`);
  console.log("Verify the contract side with:  python contracts/tests/test_signed_rounds.py");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
