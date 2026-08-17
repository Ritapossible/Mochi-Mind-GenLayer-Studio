// The exact text a player signs to authorise one round.
//
// This file is the client half of a byte-for-byte contract:
// `_round_message` in contracts/MochiMindValidator.py builds the same string
// from the values it received, hashes it with EIP-191, and recovers the signing
// address. If the two ever disagree by so much as a space, every round is
// rejected on-chain with "signature does not belong to ...".
//
// `scripts/src/sign-vectors.ts` imports this module to generate the fixtures
// that contracts/tests/test_signed_rounds.py checks the Python side against, so
// a drift between the two is a test failure rather than a broken game.

/** Bumped whenever the layout below changes. Must match SIGNING_DOMAIN. */
export const SIGNING_DOMAIN = "MochiMind v2";

export const MAX_NAME_LENGTH = 32;

export type RoundClaim = {
  /** Player address, lowercase 0x-hex. */
  player: string;
  stageId: number;
  /** The two picks, in submission order. */
  picks: string[];
  /** Display name, already trimmed to MAX_NAME_LENGTH. */
  name: string;
  /** Strictly greater than the player's last on-chain nonce. */
  nonce: number;
};

/**
 * One field per line, domain first, in a fixed order.
 *
 * The contract rejects "\n" inside a name and "|" or "\n" inside a color name,
 * which is what stops a crafted name from impersonating the lines below it.
 */
export function roundMessage(claim: RoundClaim): string {
  return [
    SIGNING_DOMAIN,
    `player:${claim.player.toLowerCase()}`,
    `stage:${claim.stageId}`,
    `picks:${claim.picks.join("|")}`,
    `nonce:${claim.nonce}`,
    `name:${claim.name}`,
  ].join("\n");
}

/** Trim a display name to something the contract will accept. */
export function normalizeName(raw: string): string {
  const cleaned = raw.replace(/[\r\n]/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
  return cleaned || "Anonymous";
}
