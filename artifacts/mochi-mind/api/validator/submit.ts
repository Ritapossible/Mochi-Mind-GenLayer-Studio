// Play one round.
//
// Two paths, both of which finish well inside a Vercel function's budget:
//
//   warm stage — a verdict is already cached on-chain, so the answer comes
//                back from a storage read in milliseconds. The pick is still
//                broadcast so the round is recorded, but we do not wait on it.
//
//   cold stage — no verdict yet. We broadcast submit_pick and return
//                { ready: false }. A cold consensus round takes 60-120 s,
//                far longer than a function may run, so the browser polls
//                GET /api/validator/stage/:id until the verdict lands.
//
// Run `pnpm --filter @workspace/scripts warm-stages` after registering the
// stages and every stage becomes a warm stage for good.

import type { VercelRequest, VercelResponse } from "../_lib/http.js";
import {
  broadcast,
  isConfigured,
  readStageVerdict,
  shortError,
  toResponse,
} from "../_lib/genlayer.js";

const TOTAL_STAGES = 20;
const PICKS_PER_ROUND = 2;

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const stageId = parseStageId(body.stageId);
  if (stageId === null) {
    res.status(400).json({ error: `stageId must be 1-${TOTAL_STAGES}` });
    return;
  }

  const picks = parsePicks(body.picks);
  if (!picks) {
    res.status(400).json({ error: `picks must be ${PICKS_PER_ROUND} distinct color names` });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    const cached = await readStageVerdict(stageId).catch(() => null);

    // Record the round on-chain. Failing to broadcast must not cost the player
    // their answer when we already hold a consensus verdict for the stage.
    let txHash: string | null = null;
    try {
      txHash = await broadcast("submit_pick", [stageId, picks]);
    } catch (err) {
      if (!cached) throw err;
    }

    if (cached) {
      res.status(200).json({
        ready: true,
        result: toResponse(stageId, cached, { txHash, cached: true }),
      });
      return;
    }

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
