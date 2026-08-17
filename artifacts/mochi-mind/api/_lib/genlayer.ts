// Server-side GenLayer client for the Vercel functions.
//
// The signing key lives here and only here. It must never be exposed to the
// browser: anything named VITE_* is inlined into the JS bundle at build time
// and is readable by every visitor. This module runs only on the server, so
// GENLAYER_PRIVATE_KEY stays server-side.
//
// Directories under api/ that start with "_" are not turned into routes by
// Vercel, so this file is importable but not reachable over HTTP.

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

const CONTRACT_ADDRESS = process.env.GENLAYER_CONTRACT_ADDRESS ?? "";
const PRIVATE_KEY = process.env.GENLAYER_PRIVATE_KEY ?? "";
const RPC_URL = process.env.GENLAYER_RPC_URL ?? "";

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

export async function getClient(): Promise<GenLayerClient> {
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

/** get_stage_result returns a JSON string; be liberal in parsing it. */
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
  return client.readContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName,
    args,
  });
}

/** Deterministic storage read — no consensus round, returns in milliseconds. */
export async function readStageVerdict(stageId: number): Promise<StageVerdict | null> {
  const client = await getClient();
  const raw = await client.readContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName: "get_stage_result",
    args: [stageId],
  });
  return parseVerdict(raw);
}

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

type RawEvidence = {
  stage_id?: number;
  registered?: boolean;
  image_url?: string;
  options?: string[];
  image_sha256?: string;
  image_bytes?: number;
  judged?: boolean;
};

/**
 * Read what the contract registered as the evidence for a stage.
 *
 * This is what lets the browser prove the picture on screen is the picture the
 * validators judged: the URL they fetched, and the SHA-256 of the bytes they
 * saw. Both come from contract storage, never from the client or this server.
 */
export async function readStageEvidence(stageId: number): Promise<StageEvidence> {
  const parsed = parseJsonRead(await readView("get_stage_evidence", [stageId])) as RawEvidence | null;

  if (!parsed || !parsed.registered) {
    return { stageId, registered: false };
  }

  return {
    stageId,
    registered: true,
    imageUrl: parsed.image_url,
    options: Array.isArray(parsed.options) ? parsed.options : undefined,
    imageSha256: parsed.image_sha256 || undefined,
    imageBytes: parsed.image_bytes,
    judged: Boolean(parsed.judged),
  };
}

/** One player's record, as the contract computed it from their rounds. */
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

type RawPlayer = {
  player?: string;
  name?: string;
  score?: number;
  ai_score?: number;
  rounds?: number;
  total?: number;
  nonce?: number;
  last_round?: number;
  last_stage?: number;
  rank?: number;
};

function toPlayerRecord(raw: RawPlayer, fallbackAddress: string): PlayerRecord {
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
  const parsed = parseJsonRead(await readView("get_player", [address])) as RawPlayer | null;
  return toPlayerRecord(parsed ?? {}, address);
}

/**
 * The leaderboard, computed by the contract from its own round log.
 *
 * Nothing is posted to this board. A score exists because the contract scored a
 * signed round against a consensus verdict and set a bit for that stage.
 */
export async function readLeaderboard(limit: number): Promise<PlayerRecord[]> {
  const parsed = parseJsonRead(await readView("get_leaderboard", [limit]));
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => toPlayerRecord(entry as RawPlayer, ""));
}

/**
 * Broadcast a write and return as soon as the node accepts it.
 *
 * Deliberately does NOT wait for finalization. A cold consensus round takes
 * 60–120 s on Studio, which is longer than a Vercel function may run, so the
 * caller polls GET /api/validator/stage/:id for the verdict instead.
 */
export async function broadcast(
  functionName: string,
  args: unknown[],
): Promise<string> {
  const client = await getClient();
  return client.writeContract({
    address: CONTRACT_ADDRESS as `0x${string}`,
    functionName,
    args,
    // genlayer-js 1.1.8 types `value` as required even though it defaults to
    // 0n at runtime. These calls transfer nothing, so pass 0 explicitly.
    value: 0n,
  });
}

/** Shape a raw verdict into the response the browser expects. */
export function toResponse(
  stageId: number,
  verdict: StageVerdict,
  extra: { txHash?: string | null; cached: boolean } = { cached: true },
) {
  const picksPerRound = 2;
  const truth = verdict.final_colors.slice(0, picksPerRound);
  return {
    stageId,
    // What the consensus decided is actually dominant — the answer key.
    truth,
    // What the AI opponent played this round.
    picks: (verdict.ai_colors ?? truth).slice(0, picksPerRound),
    coverage: verdict.coverage,
    confidence: verdict.confidence,
    reasoning: verdict.consensus_reasoning,
    imageUrl: verdict.image_url,
    imageSha256: verdict.image_sha256,
    txHash: extra.txHash ?? null,
    cached: extra.cached,
    source: "onchain" as const,
  };
}

export function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, " ").slice(0, 300);
  return String(err).slice(0, 300);
}
