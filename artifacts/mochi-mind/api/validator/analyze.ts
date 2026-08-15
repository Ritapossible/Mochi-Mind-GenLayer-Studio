// Force a fresh consensus round over a stage image, ignoring any cached
// verdict. analyze_stage is owner-only, so this works only with the deployer's
// key.
//
// Like submit, this returns as soon as the transaction is broadcast — the
// round itself takes 60-120 s. Poll /api/validator/stage/:id for the result.
//
// Prefer the warm-stages script for bulk pre-computation; this endpoint is for
// re-judging a single stage after re-registering its image.

import type { VercelRequest, VercelResponse } from "../_lib/http.js";
import { broadcast, isConfigured, shortError } from "../_lib/genlayer.js";

const TOTAL_STAGES = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const stageId = Number((req.body as Record<string, unknown> | undefined)?.stageId);
  if (!Number.isInteger(stageId) || stageId < 1 || stageId > TOTAL_STAGES) {
    res.status(400).json({ error: `stageId must be 1-${TOTAL_STAGES}` });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    const txHash = await broadcast("analyze_stage", [stageId]);
    res.status(202).json({
      ready: false,
      stageId,
      txHash,
      pollUrl: `/api/validator/stage/${stageId}`,
    });
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
