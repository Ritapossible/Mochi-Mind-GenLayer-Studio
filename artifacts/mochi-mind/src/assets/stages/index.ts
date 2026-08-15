// Stage art lives in `public/stages/` rather than being bundled through Vite.
//
// This is deliberate. The Intelligent Contract fetches these exact PNGs over
// https and shows them to a vision model — every validator re-fetches the file
// independently. That only works if the URL is stable and public, which rules
// out Vite's content-hashed asset names.
//
// If you move these files, re-register the stages on-chain (see
// `contracts/README.md`), otherwise validators will 404 and rounds will fail.

const pad = (n: number) => String(n).padStart(2, "0");

/** Path served by the app itself, e.g. `/stages/stage-01.png`. */
export function stageImagePath(stageId: number): string {
  return `/stages/stage-${pad(stageId)}.png`;
}

/** Absolute https URL — this is what gets registered on-chain. */
export function stageImageUrl(stageId: number, origin?: string): string {
  const base = (origin ?? window.location.origin).replace(/\/+$/, "");
  return `${base}${stageImagePath(stageId)}`;
}

export const STAGE_IMAGES: Record<number, string> = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [i + 1, stageImagePath(i + 1)]),
);
