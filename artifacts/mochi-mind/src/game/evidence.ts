// Bind the image on screen to the image the contract judged.
//
// The game used to render `/stages/stage-NN.png` from its own bundle and assert
// in the README that this was the same file the validators fetched. Nothing
// checked it. Swap the deployed PNG, or point the contract at a different URL,
// and the player would be guessing at one image while consensus judged another
// — with no way to tell from the screen.
//
// So the picture is no longer taken on trust:
//
//   1. ask the contract what evidence it registered for the stage
//      (`get_stage_evidence` → image_url, options, image_sha256)
//   2. fetch those exact bytes from that exact URL
//   3. hash them here, in the browser, with WebCrypto
//   4. compare against the digest the validators computed over the bytes they
//      judged, and render the bytes we just hashed — not a bundled copy
//
// A mismatch is shown to the player rather than hidden. The point is that the
// claim "you are looking at what the validators looked at" is checkable, and
// this is the check.

import { stageImagePath } from "@/assets/stages";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

/** What `get_stage_evidence` returns, once the API has shaped it. */
export type StageEvidence = {
  stageId: number;
  registered: boolean;
  imageUrl?: string;
  options?: string[];
  /** SHA-256 of the bytes the validators judged. Empty until a verdict exists. */
  imageSha256?: string;
  judged?: boolean;
};

export type EvidenceStatus =
  /** Displayed bytes hash to the digest the contract stored. */
  | "verified"
  /** The contract has a digest and the displayed bytes do not match it. */
  | "mismatch"
  /** URL came from the contract, but no verdict exists yet to compare against. */
  | "unjudged"
  /** Could not reach the contract's evidence — showing the bundled image. */
  | "unbound";

export type EvidenceBinding = {
  status: EvidenceStatus;
  /** What to render. A blob of the fetched bytes whenever we have them. */
  src: string;
  /** The URL the evidence actually came from, for display and for the explorer. */
  sourceUrl: string;
  /** Digest of the bytes on screen. */
  sha256?: string;
  /** Digest the contract recorded for this stage. */
  contractSha256?: string;
  /** Candidate colors as registered on-chain, in registration order. */
  options?: string[];
  detail?: string;
};

/**
 * Hash the bytes, or return null if this context cannot.
 *
 * `crypto.subtle` only exists in a secure context — https, or localhost. Open
 * the dev server over a LAN IP and it is undefined, which must degrade to "not
 * bound" rather than throwing and leaving the card stuck on a spinner.
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

async function fetchEvidence(stageId: number): Promise<StageEvidence | null> {
  try {
    const res = await fetch(`${API_BASE}/api/validator/stage/${stageId}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { evidence?: StageEvidence };
    return data.evidence?.registered ? data.evidence : null;
  } catch {
    return null;
  }
}

function unbound(stageId: number, detail: string): EvidenceBinding {
  return {
    status: "unbound",
    src: stageImagePath(stageId),
    sourceUrl: stageImagePath(stageId),
    detail,
  };
}

/**
 * Resolve the image for a stage, bound to the contract's evidence where possible.
 *
 * Never throws and never leaves the player staring at a blank card: if the
 * contract cannot be reached the bundled PNG is shown, clearly labelled as not
 * bound to any on-chain evidence.
 */
export async function bindStageImage(stageId: number): Promise<EvidenceBinding> {
  const evidence = await fetchEvidence(stageId);
  if (!evidence?.imageUrl) {
    return unbound(stageId, "the contract's registered image could not be read");
  }

  let bytes: ArrayBuffer;
  try {
    // No-store: a cached copy would be hashed instead of what is served now,
    // which is exactly the substitution this check exists to catch.
    const res = await fetch(evidence.imageUrl, { cache: "no-store" });
    if (!res.ok) {
      return unbound(stageId, `registered image returned HTTP ${res.status}`);
    }
    bytes = await res.arrayBuffer();
  } catch {
    // Cross-origin without CORS headers, offline, blocked — all land here.
    return unbound(stageId, "registered image could not be fetched from the browser");
  }

  const sha256 = await sha256Hex(bytes);
  if (sha256 === null) {
    return unbound(stageId, "this browser cannot hash the image (needs https or localhost)");
  }

  const src = URL.createObjectURL(new Blob([bytes]));
  const shared = {
    src,
    sourceUrl: evidence.imageUrl,
    sha256,
    contractSha256: evidence.imageSha256 || undefined,
    options: evidence.options,
  };

  if (!evidence.imageSha256) {
    return {
      ...shared,
      status: "unjudged",
      detail: "this stage has no consensus verdict yet, so there is no digest to compare",
    };
  }

  if (evidence.imageSha256.toLowerCase() !== sha256) {
    return {
      ...shared,
      status: "mismatch",
      detail: "the image being served is not the image the validators judged",
    };
  }

  return { ...shared, status: "verified" };
}

/** Release the blob URL a binding created. Safe to call on any binding. */
export function releaseBinding(binding: EvidenceBinding | null): void {
  if (binding?.src.startsWith("blob:")) URL.revokeObjectURL(binding.src);
}

export function shortDigest(hex?: string): string {
  if (!hex) return "—";
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}
