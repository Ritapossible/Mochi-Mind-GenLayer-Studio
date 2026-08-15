import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Final scores, one row per completed run.
 *
 * This used to be a `leaderboard.json` file next to the api-server process.
 * That cannot work on Vercel: the function filesystem is read-only outside
 * /tmp and is discarded between invocations, so every write was either an
 * error or silently lost.
 */
export const leaderboardTable = pgTable(
  "leaderboard",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    score: integer("score").notNull(),
    total: integer("total").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The board is always read as "top N by score, newest first" — one index
  // covers that ordering so the query never sorts the whole table.
  (t) => [index("leaderboard_rank_idx").on(t.score.desc(), t.createdAt.desc())],
);

export type LeaderboardRow = typeof leaderboardTable.$inferSelect;
export type InsertLeaderboardRow = typeof leaderboardTable.$inferInsert;
