import { Router, type IRouter } from "express";
import {
  analyzeStage,
  contractAddress,
  isConfigured,
  readStageVerdict,
  submitPick,
  type AnalyzeOutcome,
  type StageVerdict,
} from "../lib/genlayer";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TOTAL_STAGES = 20;
const PICKS_PER_ROUND = 2;

/**
 * A consensus round costs 60–120 s of wall clock. Two players hitting the same
 * stage at the same moment should share one round rather than start two, so
 * in-flight requests are keyed by stage and joined.
 */
const inFlight = new Map<number, Promise<AnalyzeOutcome>>();

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

/** Cached read — deterministic storage, no consensus round. */
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
    const verdict = await readStageVerdict(stageId);
    res.json({ stageId, verdict, cached: verdict !== null });
  } catch (err) {
    logger.warn({ stageId, err: shortError(err) }, "verdict read failed");
    res.status(502).json({ error: shortError(err) });
  }
});

/**
 * Play a round. The player sends only their two picks — the image, the
 * candidate colors and the answer all live on-chain.
 */
router.post("/validator/submit", async (req, res) => {
  const { stageId: rawStage, picks: rawPicks } = req.body as Record<string, unknown>;

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

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    let pending = inFlight.get(stageId);
    if (!pending) {
      pending = submitPick(stageId, picks).finally(() => inFlight.delete(stageId));
      inFlight.set(stageId, pending);
    }

    const outcome = await pending;
    res.json(toResponse(stageId, outcome));
  } catch (err) {
    logger.warn({ stageId, err: shortError(err) }, "submit_pick failed");
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
    res.json(toResponse(stageId, outcome));
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
