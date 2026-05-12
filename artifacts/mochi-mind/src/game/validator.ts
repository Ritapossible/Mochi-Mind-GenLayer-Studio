// MochiMind — Validator AI powered by GenLayer Studio on-chain AI.
//
// Contract: 0x2Ce9ec4668DA02893D6B6bB5128c77Ef3c40B7ee (GenLayer Studio)
//
// WHY writeContract, not readContract:
//   select_dominant_colors() calls gl.nondet.exec_prompt() internally.
//   Non-deterministic operations require the full GenLayer consensus round
//   (multiple AI validators must agree). A plain gen_call / readContract
//   cannot run the LLM validators — it fails with "execution failed".
//   Solution:
//     1. writeContract → submit_pick()  (triggers AI consensus)
//     2. waitForTransactionReceipt     (wait for FINALIZED consensus)
//     3. readContract → get_last_result() (deterministic storage read)
//
// Spender wallet covers gas so players never need a wallet.
// Falls back to local 3-validator consensus ONLY if Studio is unreachable
// or the transaction times out.

import type { Address } from "viem";
import type { Stage } from "./stages";

export const VALIDATOR_CONTRACT_ADDRESS: Address =
  (import.meta.env.VITE_STUDIO_CONTRACT as Address | undefined) ??
  "0x2Ce9ec4668DA02893D6B6bB5128c77Ef3c40B7ee";

const SPENDER_PK = import.meta.env.VITE_SPENDER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

export type ValidatorPick = {
  picks: [string, string];
  scores: Record<string, number>;
  source: "onchain" | "local-consensus";
  reasoning?: string;
  validators?: Array<{ name: string; colors: string[]; confidence: number }>;
  txHash?: string;
};

// ─── Local Consensus Fallback ─────────────────────────────────────────────────

function runSimulatedValidator(
  name: string,
  colors: string[],
  baseScores: Record<string, number>,
  strategy: "visual" | "perceived" | "identity",
): { name: string; colors: string[]; confidence: number } {
  const scored: Record<string, number> = {};
  for (const c of colors) {
    const base = baseScores[c] ?? 10;
    let score = base;
    if (strategy === "visual") {
      score = base * 1.1 + (Math.random() - 0.5) * base * 0.18;
    } else if (strategy === "perceived") {
      score = Math.pow(base, 1.15) + (Math.random() - 0.5) * base * 0.22;
    } else {
      score = base + (Math.random() - 0.5) * base * 0.35;
    }
    scored[c] = Math.max(1, score);
  }
  const ranked = Object.entries(scored)
    .sort(([, a], [, b]) => b - a)
    .map(([c]) => c);
  const vals = Object.values(scored).sort((a, b) => b - a);
  const gap = vals.length >= 3 ? ((vals[1] - vals[2]) / vals[1]) * 100 : 75;
  return { name, colors: ranked.slice(0, 2), confidence: Math.min(99, Math.max(40, Math.round(gap))) };
}

export function validatorAnalyzeLocal(stage: Stage): ValidatorPick {
  const colors = stage.options.map((o) => o.name);
  const baseScores: Record<string, number> = {};
  for (const opt of stage.options) {
    baseScores[opt.name] = Math.round(stage.weights[opt.name] ?? 10);
  }
  const vision = runSimulatedValidator("Vision Validator", colors, baseScores, "visual");
  const perception = runSimulatedValidator("Perception Validator", colors, baseScores, "perceived");
  const identity = runSimulatedValidator("Identity Validator", colors, baseScores, "identity");
  const scoreMap: Record<string, number> = {};
  for (const v of [vision, perception, identity]) {
    for (const c of v.colors) scoreMap[c] = (scoreMap[c] ?? 0) + v.confidence;
  }
  const ranked = Object.entries(scoreMap).sort(([, a], [, b]) => b - a).map(([c]) => c);
  return {
    picks: [ranked[0], ranked[1]],
    scores: baseScores,
    source: "local-consensus",
    reasoning: "Local AI consensus via 3 simulated validators (Vision, Perception, Identity).",
    validators: [vision, perception, identity],
  };
}

// ─── GenLayer Studio On-Chain Validation ─────────────────────────────────────

/**
 * Build a genlayer-js client using the spender account.
 * createAccount() from genlayer-js creates a viem-compatible local account.
 */
async function buildClient() {
  if (!SPENDER_PK) {
    throw new Error(
      "VITE_SPENDER_PRIVATE_KEY is not set. Cannot call on-chain contract.",
    );
  }
  const [{ createClient, createAccount }, { studionet }] = await Promise.all([
    import("genlayer-js"),
    import("genlayer-js/chains"),
  ]);
  const account = createAccount(SPENDER_PK);
  return createClient({ chain: studionet, account });
}

/**
 * Parse whatever readContract returns for get_last_result:
 * Could be a string (JSON), a Map, or a plain object.
 */
function parseLastResult(raw: unknown): { colors: string[]; reasoning?: string } {
  let str: string;

  if (typeof raw === "string") {
    str = raw;
  } else if (raw instanceof Map) {
    str = (raw.get("last_result") as string | undefined) ?? JSON.stringify(Object.fromEntries(raw));
  } else if (raw && typeof raw === "object") {
    // Maybe already decoded as object
    const r = raw as Record<string, unknown>;
    if (r["final_colors"]) {
      return {
        colors: r["final_colors"] as string[],
        reasoning: r["consensus_reasoning"] as string | undefined,
      };
    }
    str = JSON.stringify(raw);
  } else {
    throw new Error(`Unexpected get_last_result type: ${typeof raw}`);
  }

  // Parse JSON string
  const parsed: Record<string, unknown> = JSON.parse(str);
  const colors =
    (parsed["final_colors"] as string[] | undefined) ??
    (parsed["colors"] as string[] | undefined) ??
    [];
  const reasoning =
    (parsed["consensus_reasoning"] as string | undefined) ??
    (parsed["reasoning"] as string | undefined);
  return { colors, reasoning };
}

async function validatorAnalyzeOnChain(stage: Stage): Promise<ValidatorPick> {
  // Build argument arrays for submit_pick(stage_id, candidate_colors, dominance_scores, zone_weights)
  const candidate_colors = stage.options.map((o) => o.name);
  const dominance_scores: Record<string, number> = {};
  for (const opt of stage.options) {
    dominance_scores[opt.name] = Math.round(stage.weights[opt.name] ?? 10);
  }
  const zone_weights: Record<string, Record<string, number>> = {};

  const { TransactionStatus, ExecutionResult } = await import("genlayer-js/types");
  const client = await buildClient();

  // Step 1 — submit_pick goes through full GenLayer AI consensus
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = await (client as any).writeContract({
    address: VALIDATOR_CONTRACT_ADDRESS,
    functionName: "submit_pick",
    args: [BigInt(stage.id), candidate_colors, dominance_scores, zone_weights],
  });

  console.info(
    `[MochiMind] submit_pick tx submitted  stage=${stage.id}  hash=${txHash}`,
  );

  // Step 2 — wait for GenLayer consensus (5 AI validators must agree)
  // interval: 3 s, retries: 80 → up to ~4 min before giving up
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const receipt = await (client as any).waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
    interval: 3000,
    retries: 80,
  });

  // Step 3 — check execution didn't error
  if (receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error(
      `Contract execution failed for stage ${stage.id}. receipt=${JSON.stringify(receipt.txExecutionResultName)}`,
    );
  }

  // Step 4 — read the stored JSON result (purely deterministic — no AI calls)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawResult = await (client as any).readContract({
    address: VALIDATOR_CONTRACT_ADDRESS,
    functionName: "get_last_result",
    args: [],
  });

  const { colors, reasoning } = parseLastResult(rawResult);

  if (!Array.isArray(colors) || colors.length < 2) {
    throw new Error(
      `Contract returned fewer than 2 colors from get_last_result. Got: ${JSON.stringify(colors)}`,
    );
  }

  return {
    picks: [colors[0], colors[1]],
    scores: dominance_scores,
    source: "onchain",
    reasoning,
    txHash: String(txHash),
  };
}

function shortError(err: unknown): string {
  if (!err) return "unknown";
  const e = err as Record<string, unknown>;
  const m = e["shortMessage"] ?? e["details"] ?? e["message"] ?? e["cause"];
  if (typeof m === "string" && m) return m.replace(/\s+/g, " ").substring(0, 200);
  try {
    return JSON.stringify(err).substring(0, 200);
  } catch {
    return String(err).substring(0, 200);
  }
}

export async function validatorAnalyze(stage: Stage): Promise<ValidatorPick> {
  try {
    const result = await validatorAnalyzeOnChain(stage);
    console.info(
      `[MochiMind] GenLayer Studio ✓  stage=${stage.id}  picks=${result.picks.join(",")}`,
    );
    return result;
  } catch (err) {
    console.warn(
      `[MochiMind] Studio unavailable (stage ${stage.id}) → ${shortError(err)} — running local consensus`,
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
