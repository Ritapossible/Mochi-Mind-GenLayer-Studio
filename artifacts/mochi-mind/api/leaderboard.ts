import type { VercelRequest, VercelResponse } from "./_lib/http.js";
import { getSql, isConfigured } from "./_lib/db.js";

const BOARD_SIZE = 50;
const MAX_USERNAME = 32;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // No database provisioned yet: serve an empty board instead of a 500 so the
  // game stays playable.
  if (!isConfigured()) {
    if (req.method === "GET") {
      res.status(200).json([]);
      return;
    }
    res.status(503).json({ error: "leaderboard storage is not configured" });
    return;
  }

  try {
    const sql = getSql();

    if (req.method === "GET") {
      const rows = await sql`
        SELECT username, score, total, created_at AS date
        FROM leaderboard
        ORDER BY score DESC, created_at DESC
        LIMIT ${BOARD_SIZE}
      `;
      res.status(200).json(rows);
      return;
    }

    if (req.method === "POST") {
      const { username, score, total } = (req.body ?? {}) as Record<string, unknown>;

      if (
        typeof username !== "string" ||
        !username.trim() ||
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        typeof total !== "number" ||
        !Number.isFinite(total)
      ) {
        res.status(400).json({ error: "Invalid payload" });
        return;
      }

      // Tagged-template values are sent as bind parameters, never interpolated
      // into the SQL text.
      await sql`
        INSERT INTO leaderboard (username, score, total)
        VALUES (
          ${username.trim().slice(0, MAX_USERNAME)},
          ${Math.trunc(score)},
          ${Math.trunc(total)}
        )
      `;

      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message.slice(0, 300) });
  }
}
