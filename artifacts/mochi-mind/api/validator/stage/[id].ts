// Poll endpoint: deterministic storage read, no consensus round.
//
// Returns in milliseconds, which is what makes the submit-then-poll flow work
// inside Vercel's function time limit.

import type { VercelRequest, VercelResponse } from "../../_lib/http.js";
import {
  isConfigured,
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
    const verdict = await readStageVerdict(stageId);
    res.status(200).json({
      stageId,
      ready: verdict !== null,
      result: verdict ? toResponse(stageId, verdict, { cached: true }) : null,
    });
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
