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
 * Play one round on-chain.
 *
 * `submit_pick` is a write because the contract may need to run a
 * nondeterministic block (fetch the image, run the vision model, reach
 * consensus). A plain read cannot do that. If the stage already has a verdict
 * the contract short-circuits to the cached one and the transaction finalizes
 * quickly.
 */
export async function submitPick(stageId: number, picks: string[]): Promise<AnalyzeOutcome> {
  const started = Date.now();
  const client = await getClient();

  const before = await readStageVerdict(stageId).catch(() => null);

  const { TransactionStatus, ExecutionResult } = await import("genlayer-js/types");

  const txHash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName: "submit_pick",
    args: [stageId, picks],
  });

  logger.info({ stageId, txHash }, "submit_pick submitted");

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: RECEIPT_INTERVAL_MS,
    retries: RECEIPT_RETRIES,
  });

  if (receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error(
      `Contract execution failed for stage ${stageId}: ${JSON.stringify(receipt.txExecutionResultName)}`,
    );
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

  const { TransactionStatus, ExecutionResult } = await import("genlayer-js/types");

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

  if (receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error(
      `analyze_stage failed for stage ${stageId}: ${JSON.stringify(receipt.txExecutionResultName)}`,
    );
  }

  const verdict = await readStageVerdict(stageId);
  if (!verdict) {
    throw new Error(`Stage ${stageId} finalized but returned no verdict`);
  }

  return { verdict, txHash, cached: false, elapsedMs: Date.now() - started };
}
