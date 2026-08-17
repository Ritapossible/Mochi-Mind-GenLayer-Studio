import { Router, type IRouter } from "express";
import {
  analyzeStage,
  contractAddress,
  isConfigured,
  readPlayer,
  readStageEvidence,
  readStageVerdict,
  submitPick,
  type AnalyzeOutcome,
  type SignedRound,
  type StageVerdict,
} from "../lib/genlayer";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TOTAL_STAGES = 20;
const PICKS_PER_ROUND = 2;
const MAX_NAME = 32;

/**
 * A consensus round costs 60–120 s of wall clock, so two players reaching the
 * same cold stage at once should not both pay for one.
 *
 * They are queued rather than joined: each carries its own player's signature
 * and has to reach the contract as its own round, but the second waits for the
 * first, by which time the verdict is cached and the round settles quickly.
 */
const stageQueue = new Map<number, Promise<unknown>>();

function queueForStage(stageId: number, run: () => Promise<AnalyzeOutcome>): Promise<AnalyzeOutcome> {
  const prior = stageQueue.get(stageId) ?? Promise.resolve();
  const next = prior.then(run, run);
  // Swallow rejections on the queued copy only: the caller still sees the error.
  stageQueue.set(stageId, next.catch(() => undefined));
  return next;
}

/**
 * Shape-check the player's claim.
 *
 * The signature is deliberately not verified here — the contract recovers the
 * address itself, and a check in this process would prove nothing about what
 * lands on-chain.
 */
function parseSignedRound(body: Record<string, unknown>): SignedRound | null {
  const playerId = String(body.playerId ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(playerId)) return null;

  const name = String(body.name ?? "").trim();
  if (!name || name.length > MAX_NAME || /[\r\n]/.test(name)) return null;

  const nonce = Number(body.nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0) return null;

  const signature = String(body.signature ?? "").trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;

  return { playerId, name, nonce, signature };
}

function parseStageId(raw: unknown): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1 || id > TOTAL_STAGES) return null;
  return id;
}

function parsePicks(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length !== PICKS_PER_ROUND) return null;
  const picks = raw.map((p) => String(p).trim()).filter(Boolean);
  if (picks.length !== PICKS_PER_ROUND) return null;
  if (picks[0] === picks[1]) return null;
  return picks;
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, " ").slice(0, 300);
  return String(err).slice(0, 300);
}

router.get("/validator/status", (_req, res) => {
  res.json({
    configured: isConfigured(),
    contract: contractAddress() || null,
    explorer: contractAddress()
      ? `https://explorer-studio.genlayer.com/address/${contractAddress()}`
      : null,
  });
});

/**
 * Cached read — deterministic storage, no consensus round.
 *
 * Mirrors the { ready, result } envelope of the Vercel function at
 * artifacts/mochi-mind/api/validator/stage/[id].ts so the browser can poll
 * either backend with the same code.
 */
router.get("/validator/stage/:id", async (req, res) => {
  const stageId = parseStageId(req.params.id);
  if (stageId === null) {
    res.status(400).json({ error: `stage id must be 1-${TOTAL_STAGES}` });
    return;
  }
  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    // The evidence rides along so the browser can prove the image it is
    // rendering is the image the validators judged.
    const [verdict, evidence] = await Promise.all([
      readStageVerdict(stageId),
      readStageEvidence(stageId).catch(() => ({ stageId, registered: false })),
    ]);

    res.json({
      stageId,
      ready: verdict !== null,
      result: verdict
        ? toResponse(stageId, { verdict, cached: true, elapsedMs: 0 })
        : null,
      evidence,
    });
  } catch (err) {
    logger.warn({ stageId, err: shortError(err) }, "verdict read failed");
    res.status(502).json({ error: shortError(err) });
  }
});

/**
 * Relay a round. The player sends their two picks and a signature over them —
 * the image, the candidate colors, the answer and the score all live on-chain.
 */
router.post("/validator/submit", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { stageId: rawStage, picks: rawPicks } = body;

  const stageId = parseStageId(rawStage);
  if (stageId === null) {
    res.status(400).json({ error: `stageId must be 1-${TOTAL_STAGES}` });
    return;
  }

  const picks = parsePicks(rawPicks);
  if (!picks) {
    res.status(400).json({ error: `picks must be ${PICKS_PER_ROUND} distinct color names` });
    return;
  }

  const claim = parseSignedRound(body);
  if (!claim) {
    res.status(400).json({
      error: "playerId, name, nonce and signature are required to record a round",
    });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    const outcome = await queueForStage(stageId, () => submitPick(stageId, picks, claim));
    // This server is long-running, so unlike the serverless path it can wait
    // out a full consensus round and always answers ready:true.
    res.json({ ready: true, recorded: true, result: toResponse(stageId, outcome) });
  } catch (err) {
    logger.warn(
      { stageId, player: claim.playerId, err: shortError(err) },
      "submit_pick failed",
    );
    res.status(502).json({ error: shortError(err) });
  }
});

/**
 * One player's record, straight from contract storage.
 *
 * The browser needs the last nonce before signing its next round, and the
 * endgame screen shows the score the contract holds rather than the one the
 * browser counted.
 */
router.get("/player/:address", async (req, res) => {
  const address = String(req.params.address ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "address must be a 0x player address" });
    return;
  }
  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    res.json(await readPlayer(address));
  } catch (err) {
    logger.warn({ address, err: shortError(err) }, "player read failed");
    res.status(502).json({ error: shortError(err) });
  }
});

/** Force a fresh consensus round over the stage image. Useful for demos. */
router.post("/validator/analyze", async (req, res) => {
  const stageId = parseStageId((req.body as Record<string, unknown>)?.stageId);
  if (stageId === null) {
    res.status(400).json({ error: `stageId must be 1-${TOTAL_STAGES}` });
    return;
  }
  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    const outcome = await analyzeStage(stageId);
    res.json({ ready: true, result: toResponse(stageId, outcome) });
  } catch (err) {
    logger.warn({ stageId, err: shortError(err) }, "analyze_stage failed");
    res.status(502).json({ error: shortError(err) });
  }
});

function toResponse(stageId: number, outcome: AnalyzeOutcome) {
  const v: StageVerdict = outcome.verdict;
  const truth = v.final_colors.slice(0, PICKS_PER_ROUND);
  return {
    stageId,
    // What the consensus decided is actually dominant — the answer key.
    truth,
    // What the AI opponent played this round.
    picks: (v.ai_colors ?? truth).slice(0, PICKS_PER_ROUND),
    coverage: v.coverage,
    confidence: v.confidence,
    reasoning: v.consensus_reasoning,
    imageUrl: v.image_url,
    imageSha256: v.image_sha256,
    txHash: outcome.txHash ?? null,
    cached: outcome.cached,
    elapsedMs: outcome.elapsedMs,
    source: "onchain" as const,
  };
}

export default router;
