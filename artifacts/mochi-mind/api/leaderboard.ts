// The leaderboard, read from the contract.
//
// This used to be a Postgres table with an open POST endpoint: the browser
// finished a game, counted its own score, and told the server what to record.
// Any curl command could claim 20/20 under any name, and nothing on the board
// was connected to a round anyone had actually played.
//
// Now there is nothing to post to. A row exists because the contract scored a
// signed round against a consensus verdict and set that stage's bit in the
// player's mask. `get_leaderboard` ranks those records on-chain, so this
// function is a read and a rename — it cannot add, remove or adjust an entry.
//
// The old `leaderboard` table and DATABASE_URL are no longer used by the game.

import type { VercelRequest, VercelResponse } from "./_lib/http.js";
import { isConfigured, readLeaderboard, shortError } from "./_lib/genlayer.js";

const BOARD_SIZE = 50;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    res.status(410).json({
      error:
        "scores are no longer submitted. Play a signed round — the contract scores it and this board is derived from that.",
    });
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  // Not configured yet: serve an empty board rather than a 500, so the page
  // renders and the game stays playable.
  if (!isConfigured()) {
    res.status(200).json([]);
    return;
  }

  try {
    res.status(200).json(await readLeaderboard(BOARD_SIZE));
  } catch (err) {
    res.status(502).json({ error: shortError(err) });
  }
}
