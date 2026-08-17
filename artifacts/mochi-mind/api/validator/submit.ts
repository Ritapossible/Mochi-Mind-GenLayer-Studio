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
//
// This function is a relayer. It pays the gas so the player needs no wallet,
// and that is the whole of its authority: the round arrives already signed by
// the player's key, and the contract recovers the address itself. Everything
// checked here is a shape check to avoid spending gas on a round the contract
// is certain to reject — none of it is trusted on-chain.

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
const MAX_NAME = 32;
/** 65 bytes: r, s, v. */
const SIGNATURE_HEX_LENGTH = 132;

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

type SignedRound = {
  playerId: string;
  name: string;
  nonce: number;
  signature: string;
};

/**
 * Shape-check the player's claim.
 *
 * The signature is deliberately not verified here. Doing so would prove nothing
 * the contract does not prove for itself, and would invite the assumption that
 * a round is trustworthy because this server said so.
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
  if (signature.length !== SIGNATURE_HEX_LENGTH) return null;

  return { playerId, name, nonce, signature };
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
    const cached = await readStageVerdict(stageId).catch(() => null);

    // Record the round on-chain. Failing to broadcast must not cost the player
    // their answer when we already hold a consensus verdict for the stage.
    let txHash: string | null = null;
    try {
      txHash = await broadcast("submit_pick", [
        stageId,
        picks,
        claim.playerId,
        claim.name,
        claim.nonce,
        claim.signature,
      ]);
    } catch (err) {
      if (!cached) throw err;
    }

    if (cached) {
      res.status(200).json({
        ready: true,
        // A verdict we could serve, but a round we could not relay, is not a
        // scored round — the endgame reads its score from the contract, so say so.
        recorded: txHash !== null,
        result: toResponse(stageId, cached, { txHash, cached: true }),
      });
      return;
    }

    res.status(202).json({
      ready: false,
      recorded: txHash !== null,
      stageId,
      txHash,
      pollUrl: `/api/validator/stage/${stageId}`,
    });
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
