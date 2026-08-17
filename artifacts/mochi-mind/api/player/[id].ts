// One player's authenticated record, straight from contract storage.
//
// Serves two purposes:
//
//   - the browser needs the player's last on-chain nonce before signing the
//     next round, because the contract requires a strictly greater one
//   - the endgame screen shows the score the *contract* holds for this player,
//     not the one the browser has been counting locally
//
// Everything here is a deterministic view call. There is no write path: a score
// cannot be submitted, only earned by a signed round the contract scored.

import type { VercelRequest, VercelResponse } from "../_lib/http.js";
import { isConfigured, readPlayer, shortError } from "../_lib/genlayer.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const raw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const address = String(raw ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "id must be a 0x player address" });
    return;
  }

  if (!isConfigured()) {
    res.status(503).json({ error: "GenLayer is not configured on this server" });
    return;
  }

  try {
    res.status(200).json(await readPlayer(address));
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
