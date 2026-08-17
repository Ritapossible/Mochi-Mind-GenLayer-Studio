// Server-side GenLayer client.
//
// The signing key lives here and only here. It used to be read in the browser
// as `VITE_SPENDER_PRIVATE_KEY`, which meant it shipped inside the JS bundle and
// anyone could extract it. Contract calls now go through this module.

import { logger } from "./logger";

export type StageVerdict = {
  stage_id: number;
  /** Ground truth decided by validator consensus over the real image. */
  final_colors: string[];
  /** The AI opponent's move — same round, handicapped on ambiguous stages. */
  ai_colors: string[];
  coverage: Record<string, number>;
  confidence: number;
  consensus_reasoning: string;
  image_url: string;
  image_sha256: string;
  image_bytes: number;
  source: string;
};

export type AnalyzeOutcome = {
  verdict: StageVerdict;
  txHash?: string;
  cached: boolean;
  elapsedMs: number;
};

/** The evidence registry entry for a stage: what the validators were pointed at. */
export type StageEvidence = {
  stageId: number;
  registered: boolean;
  imageUrl?: string;
  options?: string[];
  imageSha256?: string;
  imageBytes?: number;
  judged?: boolean;
};

/** One player's record, as the contract computed it from their signed rounds. */
export type PlayerRecord = {
  player: string;
  name: string;
  score: number;
  aiScore: number;
  rounds: number;
  total: number;
  nonce: number;
  lastRound: number;
  lastStage: number;
  rank?: number;
};

/** A round the player signed and this server only relays. */
export type SignedRound = {
  playerId: string;
  name: string;
  nonce: number;
  signature: string;
};

const CONTRACT_ADDRESS = process.env.GENLAYER_CONTRACT_ADDRESS ?? "";
const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY ?? "";
const RPC_URL = process.env.GENLAYER_RPC_URL ?? "";

// A full consensus round on Studio is 60–120 s: the leader fetches the image,
// runs the vision model, then every validator repeats the work independently.
const RECEIPT_INTERVAL_MS = 3_000;
const RECEIPT_RETRIES = 80;

export function isConfigured(): boolean {
  return Boolean(CONTRACT_ADDRESS && PRIVATE_KEY);
}

export function contractAddress(): string {
  return CONTRACT_ADDRESS;
}

type GenLayerClient = {
  writeContract(args: Record<string, unknown>): Promise<string>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
  waitForTransactionReceipt(args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

let clientPromise: Promise<GenLayerClient> | null = null;

async function getClient(): Promise<GenLayerClient> {
  if (!isConfigured()) {
    throw new Error(
      "GenLayer is not configured. Set GENLAYER_CONTRACT_ADDRESS and GENLAYER_PRIVATE_KEY.",
    );
  }

  if (!clientPromise) {
    clientPromise = (async () => {
      const [{ createClient, createAccount }, chains] = await Promise.all([
        import("genlayer-js"),
        import("genlayer-js/chains"),
      ]);

      const chain = (chains as Record<string, unknown>).studionet;
      const account = createAccount(PRIVATE_KEY as `0x${string}`);

      const config: Record<string, unknown> = { chain, account };
      if (RPC_URL) config.endpoint = RPC_URL;

      return createClient(config) as unknown as GenLayerClient;
    })().catch((err) => {
      clientPromise = null; // let the next request retry
      throw err;
    });
  }

  return clientPromise;
}

/** get_last_result / get_stage_result return a JSON string; be liberal in parsing it. */
function parseVerdict(raw: unknown): StageVerdict | null {
  let text: string;

  if (typeof raw === "string") {
    text = raw;
  } else if (raw instanceof Map) {
    text = String(raw.get("last_result") ?? JSON.stringify(Object.fromEntries(raw)));
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.final_colors)) return obj as unknown as StageVerdict;
    text = JSON.stringify(obj);
  } else {
    return null;
  }

  if (!text || text === "{}") return null;

  try {
    const parsed = JSON.parse(text) as StageVerdict;
    return Array.isArray(parsed.final_colors) && parsed.final_colors.length >= 2 ? parsed : null;
  } catch {
    return null;
  }
}

/** Deterministic storage read — no consensus round, returns in milliseconds. */
export async function readStageVerdict(stageId: number): Promise<StageVerdict | null> {
  const client = await getClient();
  const raw = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_stage_result",
    args: [stageId],
  });
  return parseVerdict(raw);
}

/**
 * The contract's revert reason, or null if the transaction executed cleanly.
 *
 * A GenLayer transaction whose contract call reverted finalizes exactly like
 * one that worked — `status: 7` (FINALIZED), `result_name: "MAJORITY_AGREE"`,
 * because the validators did agree: they agreed it failed. The outcome is in
 * the leader receipt inside `consensus_data`, and the reason is the contract's
 * own `gl.vm.UserError` text:
 *
 *   execution_result  "ERROR"
 *   result.payload    "[EXPECTED] signature does not belong to 0x…"
 *
 * This used to compare `receipt.txExecutionResultName`, a key that does not
 * exist on a receipt, so a rejected round was reported to the browser as a
 * successful one.
 */
function executionError(receipt: unknown): string | null {
  const data = (receipt as { consensus_data?: { leader_receipt?: unknown } } | null)
    ?.consensus_data?.leader_receipt;
  const leader = (Array.isArray(data) ? data[0] : data) as
    | { execution_result?: string; result?: { status?: string; payload?: unknown } }
    | undefined;

  if (!leader || typeof leader !== "object") return null;

  const failed =
    leader.execution_result === "ERROR" || leader.result?.status === "rollback";
  if (!failed) return null;

  const payload = leader.result?.payload;
  return typeof payload === "string" && payload.trim()
    ? payload.trim()
    : "contract execution reverted";
}

/** Parse a JSON string returned by a view method, whatever wrapper it arrives in. */
function parseJsonRead(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;

  const text = String(raw);
  if (!text || text === "{}") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readView(functionName: string, args: unknown[]): Promise<unknown> {
  const client = await getClient();
  return client.readContract({ address: CONTRACT_ADDRESS, functionName, args });
}

/**
 * Read what the contract registered as the evidence for a stage.
 *
 * The URL the validators fetched and the SHA-256 of the bytes they judged. The
 * browser needs both to prove the image on screen is the image that was judged.
 */
export async function readStageEvidence(stageId: number): Promise<StageEvidence> {
  const parsed = parseJsonRead(await readView("get_stage_evidence", [stageId])) as
    | Record<string, unknown>
    | null;

  if (!parsed || !parsed.registered) return { stageId, registered: false };

  return {
    stageId,
    registered: true,
    imageUrl: parsed.image_url as string | undefined,
    options: Array.isArray(parsed.options) ? (parsed.options as string[]) : undefined,
    imageSha256: (parsed.image_sha256 as string) || undefined,
    imageBytes: Number(parsed.image_bytes ?? 0),
    judged: Boolean(parsed.judged),
  };
}

function toPlayerRecord(raw: Record<string, unknown>, fallbackAddress: string): PlayerRecord {
  return {
    player: String(raw.player ?? fallbackAddress).toLowerCase(),
    name: String(raw.name ?? ""),
    score: Number(raw.score ?? 0),
    aiScore: Number(raw.ai_score ?? 0),
    rounds: Number(raw.rounds ?? 0),
    total: Number(raw.total ?? 0),
    nonce: Number(raw.nonce ?? 0),
    lastRound: Number(raw.last_round ?? 0),
    lastStage: Number(raw.last_stage ?? 0),
    ...(raw.rank === undefined ? {} : { rank: Number(raw.rank) }),
  };
}

export async function readPlayer(address: string): Promise<PlayerRecord> {
  const parsed = parseJsonRead(await readView("get_player", [address])) as
    | Record<string, unknown>
    | null;
  return toPlayerRecord(parsed ?? {}, address);
}

/**
 * The leaderboard, computed by the contract from its own round log.
 *
 * Nothing is posted to this board: a score exists because the contract scored a
 * signed round against a consensus verdict.
 */
export async function readLeaderboard(limit: number): Promise<PlayerRecord[]> {
  const parsed = parseJsonRead(await readView("get_leaderboard", [limit]));
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => toPlayerRecord(entry as Record<string, unknown>, ""));
}

export async function readStageSpec(stageId: number): Promise<unknown> {
  const client = await getClient();
  const raw = await client.readContract({
    address: CONTRACT_ADDRESS,
    functionName: "get_stage",
    args: [stageId],
  });
  if (typeof raw === "string" && raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Relay one signed round on-chain.
 *
 * `submit_pick` is a write because the contract may need to run a
 * nondeterministic block (fetch the image, run the vision model, reach
 * consensus). A plain read cannot do that. If the stage already has a verdict
 * the contract short-circuits to the cached one and the transaction finalizes
 * quickly.
 *
 * This server signs the *transaction* — it pays the gas — but not the round.
 * The round carries the player's own signature, which the contract verifies, so
 * relaying is all the authority this key confers.
 */
export async function submitPick(
  stageId: number,
  picks: string[],
  round: SignedRound,
): Promise<AnalyzeOutcome> {
  const started = Date.now();
  const client = await getClient();

  const before = await readStageVerdict(stageId).catch(() => null);

  const { TransactionStatus } = await import("genlayer-js/types");

  const txHash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "submit_pick",
    args: [stageId, picks, round.playerId, round.name, round.nonce, round.signature],
  });

  logger.info({ stageId, txHash, player: round.playerId }, "submit_pick submitted");

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: RECEIPT_INTERVAL_MS,
    retries: RECEIPT_RETRIES,
  });

  const reverted = executionError(receipt);
  if (reverted) {
    throw new Error(`Contract rejected the round for stage ${stageId}: ${reverted}`);
  }

  const verdict = await readStageVerdict(stageId);
  if (!verdict) {
    throw new Error(`Stage ${stageId} finalized but returned no verdict`);
  }

  return {
    verdict,
    txHash,
    cached: before !== null,
    elapsedMs: Date.now() - started,
  };
}

/** Force a fresh consensus round over the image, ignoring any cached verdict. */
export async function analyzeStage(stageId: number): Promise<AnalyzeOutcome> {
  const started = Date.now();
  const client = await getClient();

  const { TransactionStatus } = await import("genlayer-js/types");

  const txHash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "analyze_stage",
    args: [stageId],
  });

  logger.info({ stageId, txHash }, "analyze_stage submitted");

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: RECEIPT_INTERVAL_MS,
    retries: RECEIPT_RETRIES,
  });

  const reverted = executionError(receipt);
  if (reverted) {
    throw new Error(`analyze_stage failed for stage ${stageId}: ${reverted}`);
  }

  const verdict = await readStageVerdict(stageId);
  if (!verdict) {
    throw new Error(`Stage ${stageId} finalized but returned no verdict`);
  }

  return { verdict, txHash, cached: false, elapsedMs: Date.now() - started };
}
