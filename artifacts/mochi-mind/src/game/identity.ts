// Player identity.
//
// Before this, a "player" was a Discord name typed into a box and kept in
// localStorage, and every round was signed by the server's shared key — so the
// on-chain round log said `player: <server address>` for everybody, and the
// leaderboard was a table of scores the browser had posted about itself.
//
// Now the browser holds its own secp256k1 key and signs each round. The server
// relays the signature and pays the gas; the contract recovers the address and
// refuses the round if it does not match. The relayer cannot forge a round for
// a player, cannot change the picks in one it is relaying, and cannot replay
// one, because the nonce must strictly increase.
//
// This key is a game identity, not a wallet. It never holds funds and never
// signs a transaction — only the round message in ./roundMessage. Clearing site
// data loses the identity and, with it, the on-chain score attached to it.

import { createAccount, generatePrivateKey } from "genlayer-js";
import { normalizeName, roundMessage, type RoundClaim } from "./roundMessage";

const KEY_STORAGE = "mochimind_identity_key";
/** Kept under the original key so existing players keep their name. */
const NAME_STORAGE = "mochimind_discord";
const NONCE_STORAGE = "mochimind_last_nonce";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export type Identity = {
  /** Lowercase 0x-hex. This is who the contract credits the round to. */
  address: string;
  name: string;
};

type Account = ReturnType<typeof createAccount>;

let account: Account | null = null;

function isPrivateKey(value: string | null): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Load the player's key, generating one the first time they play. */
function getAccount(): Account {
  if (account) return account;

  const stored = localStorage.getItem(KEY_STORAGE);
  const privateKey = isPrivateKey(stored) ? stored : generatePrivateKey();
  if (privateKey !== stored) {
    localStorage.setItem(KEY_STORAGE, privateKey);
  }

  account = createAccount(privateKey);
  return account;
}

export function getIdentity(): Identity {
  return {
    address: getAccount().address.toLowerCase(),
    name: normalizeName(localStorage.getItem(NAME_STORAGE) ?? ""),
  };
}

export function setDisplayName(raw: string): string {
  const name = normalizeName(raw);
  localStorage.setItem(NAME_STORAGE, name);
  return name;
}

export function hasChosenName(): boolean {
  return Boolean(localStorage.getItem(NAME_STORAGE));
}

// ─── Nonce ────────────────────────────────────────────────────────────────────
//
// The contract only requires the nonce to be greater than the last one that
// player used, which is what makes fire-and-forget relaying possible: a cold
// round takes 60–120 s to land, and the player is three stages further on by
// then. A millisecond timestamp is naturally increasing; the local counter and
// the on-chain value are both taken into account so a clock that jumps
// backwards, or a second tab, cannot produce a stale one.

function localLastNonce(): number {
  const raw = Number(localStorage.getItem(NONCE_STORAGE) ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

async function chainLastNonce(address: string): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/api/player/${address}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as { nonce?: number };
    return Number.isFinite(data.nonce) ? Number(data.nonce) : 0;
  } catch {
    return 0;
  }
}

async function nextNonce(address: string): Promise<number> {
  const [onChain, local] = [await chainLastNonce(address), localLastNonce()];
  const nonce = Math.max(Date.now(), onChain + 1, local + 1);
  localStorage.setItem(NONCE_STORAGE, String(nonce));
  return nonce;
}

// ─── Signing ──────────────────────────────────────────────────────────────────

export type SignedRound = {
  playerId: string;
  name: string;
  nonce: number;
  signature: string;
  /** Exactly what was signed — handy when debugging a rejected round. */
  message: string;
};

/**
 * Sign one round. `picks` must be the same strings, in the same order, that get
 * posted to the API: the contract rebuilds this message from what it received
 * and compares the recovered address, so any divergence fails the round.
 */
export async function signRound(stageId: number, picks: string[]): Promise<SignedRound> {
  const signer = getAccount();
  const identity = getIdentity();
  const claim: RoundClaim = {
    player: identity.address,
    stageId,
    picks,
    name: identity.name,
    nonce: await nextNonce(identity.address),
  };

  const message = roundMessage(claim);
  const signature = await signer.signMessage({ message });

  return {
    playerId: claim.player,
    name: claim.name,
    nonce: claim.nonce,
    signature,
    message,
  };
}

// ─── On-chain record ──────────────────────────────────────────────────────────

export type PlayerRecord = {
  player: string;
  name: string;
  /** Stages solved, counted from the contract's solved-stage bitmask. */
  score: number;
  aiScore: number;
  rounds: number;
  total: number;
  nonce: number;
};

/** Read this player's authenticated record back from the contract. */
export async function fetchPlayerRecord(address: string): Promise<PlayerRecord | null> {
  try {
    const res = await fetch(`${API_BASE}/api/player/${address}`);
    if (!res.ok) return null;
    return (await res.json()) as PlayerRecord;
  } catch {
    return null;
  }
}
