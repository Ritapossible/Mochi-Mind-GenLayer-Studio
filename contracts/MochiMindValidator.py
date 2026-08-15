# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
MochiMind — Validator AI Intelligent Contract
=============================================

What this contract is for
-------------------------
MochiMind is a perception game: a player looks at a blurred image of a character
("Mochi") and picks the two colors that dominate it. The contract is the
*referee*. It looks at the same image the player saw and decides, by validator
consensus, which two colors actually dominate.

Why this needs GenLayer
-----------------------
"Which two colors dominate this image?" is a subjective visual judgment. There is
no deterministic API that answers it and no single party who should be trusted to
answer it. That is exactly the shape of problem GenLayer's Optimistic Democracy
exists for: several validators independently look at the same evidence, form
their own opinion, and the round only settles when their opinions agree within a
declared tolerance.

Trust boundary (this is the important part)
-------------------------------------------
  Frontend/backend owns : the UI, the blur animation, the score display, the
                          leaderboard, and *submitting* the player's two picks.
  This contract owns    : the stage registry (image URL + candidate colors), the
                          vision judgment over the real image, the validator
                          comparison rule, and the stored verdict.
  External source owns  : the raw PNG bytes, which every validator re-fetches
                          and re-examines independently.

The caller supplies ONLY `stage_id` and the player's two picks. It cannot supply
the image, the candidate colors, dominance weights, or the answer. Those live
on-chain, registered by the owner, and the verdict is derived from the actual
image pixels by a vision model at judgment time.

This is a deliberate correction of an earlier design in which the client passed
`dominance_scores` into the contract. That was not consensus — the client had
already computed the answer and the contract only sorted the numbers it was
handed. See `contracts/README.md` for the full before/after.
"""

from genlayer import *

import json

try:  # hashlib is used only for the audit trail, never as a consensus gate
    import hashlib

    _HAS_HASHLIB = True
except Exception:  # pragma: no cover - defensive, runner should provide it
    _HAS_HASHLIB = False


# ── Error classification ──────────────────────────────────────────────────────
# Prefixes let the validator know how to compare a failure. See
# https://docs.genlayer.com/developers/intelligent-contracts/features/error-handling

ERROR_EXPECTED = "[EXPECTED]"  # business logic, deterministic — must match exactly
ERROR_EXTERNAL = "[EXTERNAL]"  # 4xx from the image host — must match exactly
ERROR_TRANSIENT = "[TRANSIENT]"  # 5xx / network — agree if both hit it
ERROR_LLM = "[LLM_ERROR]"  # model misbehaved — always disagree, rotate leader


# ── Consensus tuning ──────────────────────────────────────────────────────────

# Two validators looking at the same blurred image will not produce identical
# coverage percentages. They do not need to. They need to agree on the *decision*
# (which two colors win) or, when they disagree, to disagree only by an amount
# that is explainable as estimation noise.
COVERAGE_TOLERANCE = 10.0  # percentage points

# Below this gap between the 2nd and 3rd ranked colors, a stage is a genuine
# coin-flip and the AI opponent is allowed to get it wrong. See _derive_opponent.
AMBIGUITY_GAP = 6.0  # percentage points

MIN_OPTIONS = 3
MAX_OPTIONS = 8
PICKS_PER_ROUND = 2
MAX_IMAGE_BYTES = 6 * 1024 * 1024

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


class MochiMindValidator(gl.Contract):
    # ── Storage ───────────────────────────────────────────────────────────────
    owner: Address

    # stage_id -> JSON {"image_url": str, "options": [str, ...]}
    # Registered by the owner. This is the contract's evidence registry: a player
    # cannot point the validators at an image of their choosing.
    stage_specs: TreeMap[u256, str]
    stage_ids: DynArray[u256]

    # stage_id -> JSON verdict produced by validator consensus over the image.
    verdicts: TreeMap[u256, str]

    # Append-only audit log of played rounds, JSON per entry.
    rounds: DynArray[str]
    round_count: u256

    # Most recent verdict, kept as a convenience read for the game client.
    last_result: str

    def __init__(self) -> None:
        self.owner = gl.message.sender_address
        self.last_result = "{}"

    # ── Admin: evidence registry ──────────────────────────────────────────────

    @gl.public.write
    def register_stage(self, stage_id: int, image_url: str, options: list[str]) -> None:
        """Register the image and candidate colors for one stage. Owner only.

        `image_url` must be a publicly reachable https URL serving the raw PNG or
        JPEG the player is shown. Every validator fetches it independently, so it
        has to be stable and un-authenticated.
        """
        self._only_owner()

        sid = self._stage_key(stage_id)
        url = image_url.strip()
        if not url.startswith("https://"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} image_url must be https: {url}")

        names = self._clean_options(options)

        spec = json.dumps({"image_url": url, "options": names}, sort_keys=True)
        if self.stage_specs.get(sid, "") == "":
            self.stage_ids.append(sid)
        self.stage_specs[sid] = spec

        # Re-registering a stage invalidates any verdict formed over the old image.
        self.verdicts[sid] = ""

    @gl.public.write
    def register_stages(self, specs_json: str) -> None:
        """Bulk-register stages from a JSON array. Owner only.

        Shape: [{"stage_id": 1, "image_url": "https://...", "options": ["Yellow", ...]}, ...]
        Registering all 20 stages in one transaction instead of 20.
        """
        self._only_owner()

        try:
            entries = json.loads(specs_json)
        except Exception as exc:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} specs_json is not valid JSON: {exc}")

        if not isinstance(entries, list) or len(entries) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} specs_json must be a non-empty array")

        for entry in entries:
            if not isinstance(entry, dict):
                raise gl.vm.UserError(f"{ERROR_EXPECTED} each spec must be an object")

            # Read every key defensively. A missing key would raise a bare
            # KeyError, which becomes an unrecoverable VMError instead of a
            # comparable UserError.
            for key in ("stage_id", "image_url", "options"):
                if key not in entry:
                    raise gl.vm.UserError(f"{ERROR_EXPECTED} spec is missing '{key}'")

            try:
                raw_id = int(entry["stage_id"])
            except (ValueError, TypeError):
                raise gl.vm.UserError(
                    f"{ERROR_EXPECTED} stage_id is not an integer: {entry['stage_id']}"
                )

            sid = self._stage_key(raw_id)
            url = str(entry["image_url"]).strip()
            if not url.startswith("https://"):
                raise gl.vm.UserError(f"{ERROR_EXPECTED} image_url must be https: {url}")
            names = self._clean_options(entry["options"])

            spec = json.dumps({"image_url": url, "options": names}, sort_keys=True)
            if self.stage_specs.get(sid, "") == "":
                self.stage_ids.append(sid)
            self.stage_specs[sid] = spec
            self.verdicts[sid] = ""

    @gl.public.write
    def transfer_ownership(self, new_owner: str) -> None:
        self._only_owner()
        self.owner = Address(new_owner)

    # ── Core: judge the image ─────────────────────────────────────────────────

    @gl.public.write
    def analyze_stage(self, stage_id: int) -> None:
        """Run a fresh validator-consensus vision judgment over a stage image. Owner only.

        Always re-runs the nondeterministic block and overwrites any cached
        verdict. This is the method to call when you want to watch the consensus
        round happen.

        Owner-gated deliberately: it is the one method that forces an
        unconditional consensus round, so leaving it open would let anyone burn
        validator time and fees on demand, and flip a stage's verdict underneath
        players who are mid-round. Players do not need it — `submit_pick` still
        runs a real round for any stage that has no cached verdict yet.
        """
        self._only_owner()

        sid = self._stage_key(stage_id)
        image_url, options = self._load_spec(sid)
        verdict = self._judge(sid, image_url, options)
        self._store_verdict(sid, verdict)

    @gl.public.write
    def submit_pick(self, stage_id: int, player_picks: list[str]) -> None:
        """Play one round: score the player's two picks against the contract's verdict.

        Uses the cached verdict for the stage if one exists, otherwise runs a
        consensus round first. The player supplies only their guess.
        """
        sid = self._stage_key(stage_id)
        image_url, options = self._load_spec(sid)

        picks = self._clean_picks(player_picks, options)

        cached = self.verdicts.get(sid, "")
        if cached != "":
            verdict = json.loads(str(cached))
        else:
            verdict = self._judge(sid, image_url, options)
            self._store_verdict(sid, verdict)

        final_colors = verdict.get("final_colors", [])
        ai_colors = verdict.get("ai_colors", final_colors)

        record = {
            "round": int(self.round_count) + 1,
            "stage_id": int(stage_id),
            "player": gl.message.sender_address.as_hex,
            "player_picks": picks,
            "final_colors": final_colors,
            "ai_colors": ai_colors,
            "player_correct": set(picks) == set(final_colors),
            "ai_correct": set(ai_colors) == set(final_colors),
            "confidence": verdict.get("confidence", 0.0),
            "image_sha256": verdict.get("image_sha256", ""),
        }
        self.rounds.append(json.dumps(record, sort_keys=True))
        self.round_count = u256(int(self.round_count) + 1)

    # ── Reads ─────────────────────────────────────────────────────────────────

    @gl.public.view
    def get_last_result(self) -> str:
        return str(self.last_result)

    @gl.public.view
    def get_stage_result(self, stage_id: int) -> str:
        return str(self.verdicts.get(self._stage_key(stage_id), ""))

    @gl.public.view
    def get_stage(self, stage_id: int) -> str:
        return str(self.stage_specs.get(self._stage_key(stage_id), ""))

    @gl.public.view
    def get_registered_stages(self) -> str:
        return json.dumps(sorted(int(sid) for sid in self.stage_ids))

    @gl.public.view
    def get_round_count(self) -> int:
        return int(self.round_count)

    @gl.public.view
    def get_round(self, index: int) -> str:
        if index < 0 or index >= len(self.rounds):
            return ""
        return str(self.rounds[index])

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    # ── Nondeterministic judgment ─────────────────────────────────────────────

    def _judge(self, sid: u256, image_url: str, options: list[str]) -> dict:
        """Fetch the image, ask a vision model to rank the colors, reach consensus.

        `image_url` and `options` arrive as plain in-memory values — storage must
        not be read from inside a nondeterministic block.
        """
        prompt = self._build_prompt(options)

        def leader_fn() -> str:
            image_bytes = _fetch_image(image_url)
            raw = gl.nondet.exec_prompt(
                prompt,
                images=[image_bytes],
                response_format="json",
            )
            # Whatever a nondeterministic block returns is calldata encoded, and
            # calldata has no float type — returning the verdict dict directly
            # crashed the leader with
            #   TypeError: not calldata encodable 22.0: float  (key 'confidence')
            # which made every validator disagree, so the round settled without
            # ever storing a verdict. Coverage percentages and the confidence
            # gap are inherently fractional, so the verdict crosses the boundary
            # as JSON text and is parsed back into a dict below.
            return json.dumps(_normalize(raw, options, image_bytes), sort_keys=True)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            # The validator does NOT inspect the leader's answer for shape and
            # call it a day. It re-fetches the same image, forms its own opinion,
            # and compares the decision.
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)

            mine = json.loads(leader_fn())
            theirs = json.loads(str(leaders_res.calldata))
            return _agree(theirs, mine, options)

        verdict = json.loads(gl.vm.run_nondet_unsafe(leader_fn, validator_fn))

        # Everything below is deterministic post-processing of the consensus
        # result, so every node computes the same thing without another round.
        verdict["stage_id"] = int(sid)
        verdict["image_url"] = image_url
        verdict["source"] = "onchain-vision"
        verdict["ai_colors"] = _derive_opponent(verdict, options)
        return verdict

    def _build_prompt(self, options: list[str]) -> str:
        names = ", ".join(options)
        return (
            "You are judging which colors dominate a single character image.\n"
            "\n"
            "The image shows a round character called Mochi, possibly blurred.\n"
            "Estimate what percentage of the CHARACTER's visible surface each\n"
            "candidate color covers.\n"
            "\n"
            "Rules:\n"
            "- Judge only from the image itself. You have no other information.\n"
            "- Ignore the background and any canvas outside the character.\n"
            "- Weigh large flat regions; ignore thin outlines and tiny accents.\n"
            "- Give every candidate a number. The numbers should sum to about 100.\n"
            "- Use the candidate names exactly as written.\n"
            "\n"
            f"Candidate colors: {names}\n"
            "\n"
            'Respond ONLY with JSON: {"coverage": {"<color>": <number 0-100>}, '
            '"reasoning": "<one sentence, max 200 characters>"}'
        )

    def _store_verdict(self, sid: u256, verdict: dict) -> None:
        encoded = json.dumps(verdict, sort_keys=True)
        self.verdicts[sid] = encoded
        self.last_result = encoded

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _only_owner(self) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} owner only")

    def _stage_key(self, stage_id: int) -> u256:
        """Validate a caller-supplied stage id before converting it.

        `u256(-1)` raises outside the UserError channel, which the runtime turns
        into an unrecoverable VMError rather than a business-logic failure the
        validators can compare. Every public entry point that accepts a
        `stage_id` goes through here.
        """
        if stage_id < 0:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} stage_id must be non-negative, got {stage_id}"
            )
        return u256(stage_id)

    def _load_spec(self, sid: u256) -> tuple[str, list[str]]:
        raw = self.stage_specs.get(sid, "")
        if raw == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} stage {int(sid)} is not registered")
        spec = json.loads(str(raw))
        return str(spec["image_url"]), [str(o) for o in spec["options"]]

    def _clean_options(self, options) -> list[str]:
        names: list[str] = []
        for opt in options:
            name = str(opt).strip()
            if name == "":
                raise gl.vm.UserError(f"{ERROR_EXPECTED} empty color name")
            if name in names:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} duplicate color: {name}")
            names.append(name)
        if len(names) < MIN_OPTIONS or len(names) > MAX_OPTIONS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} need {MIN_OPTIONS}-{MAX_OPTIONS} colors, got {len(names)}"
            )
        return names

    def _clean_picks(self, player_picks, options: list[str]) -> list[str]:
        picks: list[str] = []
        for p in player_picks:
            name = str(p).strip()
            if name in picks:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} duplicate pick: {name}")
            if name not in options:
                raise gl.vm.UserError(f"{ERROR_EXPECTED} '{name}' is not a candidate this stage")
            picks.append(name)
        if len(picks) != PICKS_PER_ROUND:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} need exactly {PICKS_PER_ROUND} picks, got {len(picks)}"
            )
        return picks


# ── Module-level pure helpers ─────────────────────────────────────────────────
# Kept outside the class so they can run inside nondeterministic blocks without
# touching contract storage.


def _fetch_image(url: str) -> bytes:
    """Fetch the stage image and prove it really is an image before judging it."""
    res = gl.nondet.web.get(url)

    status = getattr(res, "status_code", None)
    if status is None:
        status = getattr(res, "status", None)
    if status is None:
        # Unknown response shape. Fail closed — assuming success here would hand
        # an unchecked body to the vision model as if it were evidence.
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} could not read response status for {url}")
    status = int(status)

    if 400 <= status < 500:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} image fetch returned {status} for {url}")
    if status >= 500:
        raise gl.vm.UserError(f"{ERROR_TRANSIENT} image host returned {status} for {url}")

    body = res.body
    if not body:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} empty body for {url}")
    if len(body) > MAX_IMAGE_BYTES:
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} image too large ({len(body)} bytes) for {url}")

    # A 200 that returns an HTML error page is worse than a 404 — it would be
    # handed to the vision model as if it were evidence. Check the magic bytes.
    if not (body.startswith(PNG_MAGIC) or body.startswith(JPEG_MAGIC)):
        raise gl.vm.UserError(f"{ERROR_EXTERNAL} not a PNG or JPEG: {url}")

    return body


def _sha256(data: bytes) -> str:
    if not _HAS_HASHLIB:
        return ""
    return hashlib.sha256(data).hexdigest()


def _coerce_pct(raw) -> float:
    """LLMs return 41, 41.0, '41', '41%', ' 41 '. Accept all of them."""
    text = str(raw).strip().rstrip("%").strip()
    try:
        value = float(text)
    except (ValueError, TypeError):
        raise gl.vm.UserError(f"{ERROR_LLM} non-numeric coverage: {raw}")
    if value < 0.0:
        return 0.0
    if value > 100.0:
        return 100.0
    return value


def _normalize(raw, options: list[str], image_bytes: bytes) -> dict:
    """Turn a loose LLM response into the fixed decision record we compare on."""
    if not isinstance(raw, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} expected a JSON object, got {type(raw)}")

    coverage_raw = raw.get("coverage")
    if not isinstance(coverage_raw, dict):
        # Key aliasing — models like to rename this field.
        for alt in ("colors", "percentages", "scores", "distribution"):
            if isinstance(raw.get(alt), dict):
                coverage_raw = raw[alt]
                break
    if not isinstance(coverage_raw, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} missing 'coverage'. Keys: {list(raw.keys())}")

    # Match model keys back to the registered candidate names, case-insensitively.
    lookup = {name.lower(): name for name in options}
    coverage: dict = {name: 0.0 for name in options}
    matched = 0
    for key, value in coverage_raw.items():
        canonical = lookup.get(str(key).strip().lower())
        if canonical is None:
            continue  # model invented a color that is not a candidate — ignore it
        coverage[canonical] = _coerce_pct(value)
        matched += 1

    if matched < PICKS_PER_ROUND:
        raise gl.vm.UserError(
            f"{ERROR_LLM} only {matched} candidate colors scored; need at least {PICKS_PER_ROUND}"
        )

    total = sum(coverage.values())
    if total <= 0.0:
        raise gl.vm.UserError(f"{ERROR_LLM} all coverage values are zero")

    # Normalize to percentages so leader and validator are compared on the same
    # scale even if one of them ignored the "sum to 100" instruction.
    coverage = {name: round(value * 100.0 / total, 2) for name, value in coverage.items()}

    ranked = sorted(options, key=lambda name: (-coverage[name], name))
    final_colors = ranked[:PICKS_PER_ROUND]

    # Confidence = how clearly the 2nd place beat the 3rd. A small gap means the
    # stage is genuinely ambiguous, which the UI surfaces to the player.
    if len(ranked) > PICKS_PER_ROUND:
        confidence = round(coverage[ranked[1]] - coverage[ranked[2]], 2)
    else:
        confidence = 100.0

    reasoning = str(raw.get("reasoning", raw.get("explanation", "")))[:200]

    return {
        "final_colors": final_colors,
        "coverage": coverage,
        "confidence": confidence,
        "consensus_reasoning": reasoning,
        "image_sha256": _sha256(image_bytes),
        "image_bytes": len(image_bytes),
    }


def _derive_opponent(verdict: dict, options: list[str]) -> list[str]:
    """Work out what the AI *opponent* answers, as distinct from the truth.

    The consensus verdict is the ground truth — if the opponent simply reused it,
    the AI would score 20/20 every game and there would be no contest. So the
    opponent is handicapped in the one place a handicap is honest: when the
    vision model itself measured two colors as nearly tied, the opponent has to
    commit to one of them and can commit wrongly.

    The choice is derived from the image digest rather than from randomness, so
    every validator computes the same opponent move and the round stays
    deterministic after the nondeterministic block closes.
    """
    coverage = verdict.get("coverage", {})
    ranked = sorted(options, key=lambda name: (-float(coverage.get(name, 0.0)), name))

    if len(ranked) < 3:
        return ranked[:PICKS_PER_ROUND]

    gap = float(coverage.get(ranked[1], 0.0)) - float(coverage.get(ranked[2], 0.0))
    if gap >= AMBIGUITY_GAP:
        # Clear-cut stage — the opponent sees it as plainly as the consensus did.
        return [ranked[0], ranked[1]]

    seed = str(verdict.get("image_sha256", "")) or str(verdict.get("image_bytes", 0))
    flip = sum(ord(ch) for ch in seed) % 2
    return [ranked[0], ranked[2] if flip == 1 else ranked[1]]


def _agree(theirs: dict, mine: dict, options: list[str]) -> bool:
    """Decide whether the leader's judgment and ours are the same decision.

    Exact agreement on two colors would be too strict — several stages pair
    near-identical colors (White/Silver, Purple/Lavender) and honest validators
    will order them differently. Exact agreement on percentages would be
    absurd. So we compare the decision, and allow it to differ only when the
    numbers say the two colors were effectively tied.
    """
    their_colors = theirs.get("final_colors")
    my_colors = mine.get("final_colors")

    if not isinstance(their_colors, list) or len(their_colors) != PICKS_PER_ROUND:
        return False
    if not isinstance(my_colors, list) or len(my_colors) != PICKS_PER_ROUND:
        return False

    # The leader must have picked from the registered candidates, not invented one.
    for color in their_colors:
        if color not in options:
            return False

    if set(their_colors) == set(my_colors):
        return True

    # Decisions differ. Accept only if they overlap and the disputed colors were
    # a photo finish for both of us.
    if len(set(their_colors) & set(my_colors)) == 0:
        return False

    their_cov = theirs.get("coverage", {})
    my_cov = mine.get("coverage", {})
    if not isinstance(their_cov, dict) or not isinstance(my_cov, dict):
        return False

    for color in set(their_colors) ^ set(my_colors):
        if color not in their_cov or color not in my_cov:
            return False
        if abs(float(their_cov[color]) - float(my_cov[color])) > COVERAGE_TOLERANCE:
            return False

    return True


def _handle_leader_error(leaders_res, leader_fn) -> bool:
    """Compare failures. Deterministic errors must match; LLM errors never agree."""
    leader_msg = getattr(leaders_res, "message", "") or ""
    try:
        leader_fn()
        return False  # we succeeded where the leader failed — disagree
    except gl.vm.UserError as exc:
        validator_msg = getattr(exc, "message", "") or str(exc)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False
