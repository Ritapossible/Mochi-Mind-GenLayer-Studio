// Poll endpoint: deterministic storage read, no consensus round.
//
// Returns in milliseconds, which is what makes the submit-then-poll flow work
// inside Vercel's function time limit.
//
// It also carries the stage's evidence — the image URL the validators were
// pointed at and the SHA-256 of the bytes they judged — because the browser
// needs both to prove the picture it is rendering is the picture that was
// judged. See artifacts/mochi-mind/src/game/evidence.ts.

import type { VercelRequest, VercelResponse } from "../../_lib/http.js";
import {
  isConfigured,
  readStageEvidence,
  readStageVerdict,
  shortError,
  toResponse,
} from "../../_lib/genlayer.js";

const TOTAL_STAGES = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const stageId = Number(req.query.id);
  if (!Number.isInteger(stageId) || stageId < 1 || stageId > TOTAL_STAGES) {
    res.status(400).json({ error: `stage id must be 1-${TOTAL_STAGES}` });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    // Both are cheap storage reads; running them together keeps the poll to a
    // single round trip while a stage is still cold.
    const [verdict, evidence] = await Promise.all([
      readStageVerdict(stageId),
      readStageEvidence(stageId).catch(() => ({ stageId, registered: false })),
    ]);

    res.status(200).json({
      stageId,
      ready: verdict !== null,
      result: verdict ? toResponse(stageId, verdict, { cached: true }) : null,
      evidence,
    });
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
