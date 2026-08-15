/**
 * Register the 20 MochiMind stages on the deployed Intelligent Contract.
 *
 * The contract will not judge a stage it does not know about. Registration is
 * what pins, on-chain, which image each stage refers to and which colors are
 * candidates — so a player cannot later point the validators at a different
 * picture or smuggle in their own answer set.
 *
 * Run once after deploying, and again whenever the image host changes.
 *
 *   GENLAYER_CONTRACT_ADDRESS=0x... \
 *   GENLAYER_PRIVATE_KEY=0x... \
 *   MOCHI_IMAGE_BASE_URL=https://your-app.vercel.app \
 *   pnpm --filter @workspace/scripts register-stages
 *
 * The key must belong to the account that deployed the contract — register_stage
 * is owner-only.
 */

import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

// Mirrors artifacts/mochi-mind/src/game/stages.ts. Kept as plain data so this
// script has no dependency on the frontend build.
const STAGE_OPTIONS: Record<number, string[]> = {
  1: ["Yellow", "Orange", "Pink", "Red"],
  2: ["Green", "Brown", "Yellow", "Blue"],
  3: ["Blue", "Cyan", "White", "Green"],
  4: ["Pink", "White", "Purple", "Cyan"],
  5: ["Red", "Orange", "Brown", "Yellow"],
  6: ["Purple", "Gold", "Blue", "Silver"],
  7: ["Gray", "Blue", "White", "Black"],
  8: ["Neon Green", "Black", "Yellow", "Purple"],
  9: ["Pink", "Red", "White", "Magenta"],
  10: ["White", "Cyan", "Blue", "Silver"],
  11: ["Black", "Purple", "Blue", "Gray"],
  12: ["Indigo", "Silver", "Purple", "Blue"],
  13: ["Pink", "Cyan", "White", "Magenta"],
  14: ["Beige", "Gold", "Orange", "Brown"],
  15: ["White", "Silver", "Cyan", "Lavender"],
  16: ["Electric Blue", "Yellow", "White", "Cyan"],
  17: ["Black", "White", "Purple", "Gray"],
  18: ["Lavender", "White", "Blue", "Pink"],
  19: ["Purple", "Silver", "White", "Indigo"],
  20: ["Purple", "White", "Blue", "Lavender"],
};

const CONTRACT = requireEnv("GENLAYER_CONTRACT_ADDRESS");
const PRIVATE_KEY = requireEnv("GENLAYER_PRIVATE_KEY");
const IMAGE_BASE = requireEnv("MOCHI_IMAGE_BASE_URL").replace(/\/+$/, "");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function imageUrl(stageId: number): string {
  return `${IMAGE_BASE}/stages/stage-${String(stageId).padStart(2, "0")}.png`;
}

/** Fail early rather than registering URLs the validators cannot reach. */
async function checkReachable(url: string): Promise<void> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    throw new Error("did not return a PNG or JPEG (check for an HTML error page)");
  }
}

async function main(): Promise<void> {
  const specs = Object.entries(STAGE_OPTIONS).map(([id, options]) => ({
    stage_id: Number(id),
    image_url: imageUrl(Number(id)),
    options,
  }));

  console.log(`Verifying ${specs.length} stage images under ${IMAGE_BASE} ...`);
  const failures: string[] = [];
  for (const spec of specs) {
    try {
      await checkReachable(spec.image_url);
      console.log(`  ok   stage ${spec.stage_id}  ${spec.image_url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL stage ${spec.stage_id}  ${spec.image_url} — ${message}`);
      failures.push(spec.image_url);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} image(s) unreachable. Validators fetch these URLs independently,\n` +
        `so registering them now would make every round fail. Fix hosting first.`,
    );
    process.exit(1);
  }

  const account = createAccount(PRIVATE_KEY as `0x${string}`);
  const client = createClient({ chain: studionet, account });

  console.log(`\nRegistering ${specs.length} stages on ${CONTRACT} ...`);
  const txHash = await client.writeContract({
    address: CONTRACT as `0x${string}`,
    functionName: "register_stages",
    args: [JSON.stringify(specs)],
    // genlayer-js 1.1.8 types `value` as required even though it defaults to 0n
    // at runtime. Registering stages transfers nothing, so pass 0 explicitly.
    value: 0n,
  });

  console.log(`  tx ${txHash}`);
  await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: 3000,
    retries: 40,
  });

  const registered = await client.readContract({
    address: CONTRACT as `0x${string}`,
    functionName: "get_registered_stages",
    args: [],
  });

  console.log(`\nDone. Registered stages: ${String(registered)}`);
  console.log(
    `Explorer: https://explorer-studio.genlayer.com/address/${CONTRACT}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
