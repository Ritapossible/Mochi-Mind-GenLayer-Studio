// MochiMind — Validator AI client.
//
// The browser no longer talks to GenLayer directly and no longer holds a
// signing key. It posts the player's two picks to our API server, which owns
// the key and drives the Intelligent Contract:
//
//   browser ──POST /api/validator/submit──> api-server ──> GenLayer Studio
//
// The contract does the work that matters: it fetches the stage PNG over https,
// shows it to a vision model, and has every validator independently re-fetch and
// re-judge before the round settles. Nothing about the answer originates here.
//
// Contract: contracts/MochiMindValidator.py

import type { Stage } from "./stages";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

/** A consensus round is 60–120 s on Studio. Give it room, then fall back. */
const REQUEST_TIMEOUT_MS = 180_000;

export type ValidatorPick = {
  /** What the AI opponent played. */
  picks: [string, string];
  /** Ground truth for the round, as decided by validator consensus. */
  truth: [string, string];
  source: "onchain" | "local-consensus";
  reasoning?: string;
  /** Per-color surface coverage the vision model measured, 0–100. */
  coverage?: Record<string, number>;
  /** How far the 2nd place color beat the 3rd. Low means a genuinely close call. */
  confidence?: number;
  txHash?: string;
  imageUrl?: string;
};

type SubmitResponse = {
  stageId: number;
  truth: string[];
  picks: string[];
  coverage?: Record<string, number>;
  confidence?: number;
  reasoning?: string;
  imageUrl?: string;
  txHash?: string | null;
  cached?: boolean;
  elapsedMs?: number;
};

function pair(colors: string[] | undefined, fallback: [string, string]): [string, string] {
  if (!Array.isArray(colors) || colors.length < 2) return fallback;
  return [colors[0], colors[1]];
}

// ─── Offline fallback ─────────────────────────────────────────────────────────

/**
 * Used only when the API server or Studio is unreachable, so the game stays
 * playable in local dev. This path is labelled "offline" in the UI and is NOT
 * consensus — it falls back to the stage's local answer and gives the opponent a
 * difficulty-scaled chance of missing the second color.
 */
export function validatorAnalyzeLocal(stage: Stage): ValidatorPick {
  const truth = stage.correct;
  const decoys = stage.options.map((o) => o.name).filter((n) => !truth.includes(n));

  // Harder stages trip the offline opponent more often.
  const missChance = 0.1 + stage.difficulty * 0.08;
  const missed = decoys.length > 0 && Math.random() < missChance;
  const picks: [string, string] = missed
    ? [truth[0], decoys[Math.floor(Math.random() * decoys.length)]]
    : [truth[0], truth[1]];

  return {
    picks,
    truth,
    source: "local-consensus",
    reasoning: "Offline fallback — GenLayer Studio was unreachable, so this round was not judged on-chain.",
  };
}

// ─── On-chain path ────────────────────────────────────────────────────────────

async function validatorAnalyzeOnChain(
  stage: Stage,
  playerPicks: string[],
): Promise<ValidatorPick> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/api/validator/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageId: stage.id, picks: playerPicks }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as SubmitResponse;
    const truth = pair(data.truth, stage.correct);

    return {
      picks: pair(data.picks, truth),
      truth,
      source: "onchain",
      reasoning: data.reasoning,
      coverage: data.coverage,
      confidence: data.confidence,
      txHash: data.txHash ?? undefined,
      imageUrl: data.imageUrl,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, " ").slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Play one round. `playerPicks` is sent to the contract so the round is recorded
 * on-chain; when the player times out with no picks we fall back to a read-only
 * analysis so the reveal still happens.
 */
export async function validatorAnalyze(
  stage: Stage,
  playerPicks: string[] = [],
): Promise<ValidatorPick> {
  // The contract requires exactly two distinct picks. A timed-out player has
  // none, so pad with the first two options — the round still gets judged, and
  // an empty player pick can never match the verdict anyway.
  const picks =
    playerPicks.length === 2
      ? playerPicks
      : stage.options.slice(0, 2).map((o) => o.name);

  try {
    const result = await validatorAnalyzeOnChain(stage, picks);
    console.info(
      `[MochiMind] GenLayer ✓ stage=${stage.id} truth=${result.truth.join(",")} ai=${result.picks.join(",")}`,
    );
    return result;
  } catch (err) {
    console.warn(
      `[MochiMind] on-chain round failed (stage ${stage.id}) → ${shortError(err)} — using offline fallback`,
    );
    return validatorAnalyzeLocal(stage);
  }
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

export type RoundResult =
  | "perfect-match"
  | "player-wins"
  | "validator-wins"
  | "shared-misread";

export function isExactMatch(picks: string[], correct: [string, string]): boolean {
  if (picks.length !== 2) return false;
  const a = new Set(picks);
  return a.has(correct[0]) && a.has(correct[1]);
}

export function scoreRound(
  playerPicks: string[],
  validatorPicks: [string, string],
  correct: [string, string],
): { player: 0 | 1; validator: 0 | 1; result: RoundResult } {
  const p = isExactMatch(playerPicks, correct) ? 1 : 0;
  const v = isExactMatch(validatorPicks, correct) ? 1 : 0;
  let result: RoundResult;
  if (p && v) result = "perfect-match";
  else if (p && !v) result = "player-wins";
  else if (!p && v) result = "validator-wins";
  else result = "shared-misread";
  return { player: p as 0 | 1, validator: v as 0 | 1, result };
}

export function endgameTitle(
  playerScore: number,
  validatorScore: number,
  total: number,
): string {
  const ratio = playerScore / total;
  if (playerScore >= validatorScore && ratio >= 0.9) return "True Color Master";
  if (playerScore > validatorScore) return "Validator Rival";
  if (playerScore === validatorScore) return "Mochi Reader";
  if (ratio >= 0.5) return "Blur Breaker";
  return "Apprentice of Mochi";
}
