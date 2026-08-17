// The leaderboard, read from the contract.
//
// This route used to keep `leaderboard.json` next to the process and accept a
// POST of `{ username, score, total }` from anyone who could reach it. A score
// was whatever the caller said it was, and no row was tied to a round that had
// been played.
//
// Now it mirrors the serverless function: `get_leaderboard` ranks player
// records the contract built from signed rounds it scored itself, and there is
// nothing to post to.

import { Router, type IRouter } from "express";
import { isConfigured, readLeaderboard } from "../lib/genlayer";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const BOARD_SIZE = 50;

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, " ").slice(0, 300);
  return String(err).slice(0, 300);
}

router.get("/leaderboard", async (_req, res) => {
  // Not configured yet: an empty board keeps the page rendering.
  if (!isConfigured()) {
    res.json([]);
    return;
  }

  try {
    res.json(await readLeaderboard(BOARD_SIZE));
  } catch (err) {
    logger.warn({ err: shortError(err) }, "leaderboard read failed");
    res.status(502).json({ error: shortError(err) });
  }
});

router.post("/leaderboard", (_req, res) => {
  res.status(410).json({
    error:
      "scores are no longer submitted. Play a signed round — the contract scores it and this board is derived from that.",
  });
});

export default router;
