// Neon Postgres over HTTP.
//
// Vercel functions are short-lived and can start many concurrent instances, so
// a TCP pool (lib/db uses `pg`) would exhaust Postgres connections. Neon's
// serverless driver issues each query as a stateless HTTPS request instead,
// which suits this execution model.
//
// Queries are written as tagged templates rather than through Drizzle so this
// function does not have to import TypeScript across the workspace boundary —
// @workspace/db exports raw .ts, which the function bundler would not compile.
// The canonical schema still lives in lib/db/src/schema/leaderboard.ts and is
// what `pnpm --filter @workspace/db push` creates; this file only reads and
// writes the table it produces.
//
// If DATABASE_URL is unset the leaderboard degrades to empty rather than
// failing the deploy — the game itself does not depend on it.

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

export function isConfigured(): boolean {
  return Boolean(DATABASE_URL);
}

type Sql = ReturnType<typeof neon>;

let cached: Sql | null = null;

export function getSql(): Sql {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!cached) {
    cached = neon(DATABASE_URL);
  }
  return cached;
}
