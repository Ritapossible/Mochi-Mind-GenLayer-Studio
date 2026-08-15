// Minimal request/response types for Vercel's Node runtime.
//
// These are declared locally rather than imported from @vercel/node on
// purpose: the package is needed only for two type aliases, and adding a
// dependency whose exact version cannot be verified offline risks breaking
// `pnpm install` at deploy time for no runtime benefit. Vercel supplies the
// actual implementations; this only describes the shape our handlers use.

import type { IncomingMessage, ServerResponse } from "node:http";

export type VercelRequest = IncomingMessage & {
  /** Route and search params, e.g. `id` from api/validator/stage/[id].ts */
  query: Record<string, string | string[] | undefined>;
  /** JSON bodies are parsed by the runtime before the handler runs. */
  body: unknown;
};

export type VercelResponse = ServerResponse & {
  status(statusCode: number): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: unknown): VercelResponse;
};
