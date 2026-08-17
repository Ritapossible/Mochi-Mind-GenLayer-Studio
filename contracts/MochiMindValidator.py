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
  Frontend/backend owns : the UI, the blur animation, and *relaying* the
                          player's signed round to this contract.
  This contract owns    : the stage registry (image URL + candidate colors), the
                          vision judgment over the real image, the validator
                          comparison rule, the stored verdict, **who played the
                          round**, and **every score on the leaderboard**.
  External source owns  : the raw PNG bytes, which every validator re-fetches
                          and re-examines independently.

The caller supplies ONLY `stage_id`, the player's two picks, and a signature
proving which player made them. It cannot supply the image, the candidate
colors, dominance weights, the answer, or a score.

Two earlier design corrections are recorded here because they are the whole
point of the contract's shape:

1. The client used to pass `dominance_scores` into `submit_pick`. That was not
   consensus — the client had already computed the answer and the contract only
   sorted the numbers it was handed. Dominance is now measured from the image
   pixels by a vision model at judgment time.

2. The round was correct but the *player* was not. Every transaction was signed
   by one shared server key, so `gl.message.sender_address` was the relayer on
   every round, identity was a name typed into a browser, and the leaderboard
   was a table of client-submitted scores. Now each round carries the player's
   own secp256k1 signature over (domain, player, stage, picks, nonce, name),
   verified in this contract (`_recover_signer`), replay-protected by a
   per-player nonce, and the score is derived here from the rounds themselves —
   the relayer pays the gas and can do nothing else.

See `contracts/README.md` for the full before/after.
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


# ── Player identity ───────────────────────────────────────────────────────────

# Signed into every round so a signature made for one game can never be replayed
# into another. Bump it if the message layout below ever changes.
SIGNING_DOMAIN = "MochiMind v2"

MAX_NAME = 32
# A stage id has to fit in the solved-stages bitmask, which is what the on-chain
# score is counted from.
MAX_STAGE_ID = 255


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

    # ── Competitive state ─────────────────────────────────────────────────────
    # Keyed by lowercase player address. Every value in here is derived from
    # rounds this contract scored itself — nothing is ever submitted as a score.
    player_stats: TreeMap[str, str]
    player_nonces: TreeMap[str, u256]
    player_ids: DynArray[str]

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
    def submit_pick(
        self,
        stage_id: int,
        player_picks: list[str],
        player_id: str,
        player_name: str,
        nonce: int,
        signature: str,
    ) -> None:
        """Play one round as `player_id`, and score it on-chain.

        Authentication
        --------------
        The transaction is normally sent by a relayer that pays the gas so the
        player needs no wallet. That means `gl.message.sender_address` says
        nothing about who played, so the round carries the player's own
        signature instead:

            keccak256("\\x19Ethereum Signed Message:\\n" + len(msg) + msg)

        over the canonical message built by `_round_message`. The address
        recovered from that signature must equal `player_id`, and `nonce` must
        be strictly greater than the last nonce that player used — so the
        relayer can neither forge a round for someone else, alter the picks of a
        round it is relaying, nor replay one it has already relayed.

        The nonce is strictly-increasing rather than a counter the client has to
        match exactly, because rounds are relayed fire-and-forget: a cold stage
        takes 60–120 s to execute and the browser has moved on long before the
        transaction lands. A client that had to predict its own next counter
        value would deadlock itself. Clients use a millisecond timestamp.

        A player who signs the transaction with their own account is
        authenticated by the chain itself; in that case `player_id` must equal
        the sender and the signature is not required.

        Scoring
        -------
        The player's picks are compared here against the consensus verdict, and
        the result is folded into their on-chain record. `solved_mask` has one
        bit per stage, so replaying a stage cannot inflate a score.
        """
        sid = self._stage_key(stage_id)
        image_url, options = self._load_spec(sid)

        picks = self._clean_picks(player_picks, options)
        pid = self._clean_player_id(player_id)
        name = self._clean_name(player_name)

        if nonce < 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} nonce must be non-negative, got {nonce}")
        last_nonce = int(self.player_nonces.get(pid, u256(0)))
        if int(nonce) <= last_nonce:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} nonce {int(nonce)} was already used by {pid} "
                f"(last {last_nonce}) — this round is a replay"
            )

        auth = self._authenticate(pid, int(stage_id), picks, name, int(nonce), signature)

        cached = self.verdicts.get(sid, "")
        if cached != "":
            verdict = json.loads(str(cached))
        else:
            verdict = self._judge(sid, image_url, options)
            self._store_verdict(sid, verdict)

        final_colors = verdict.get("final_colors", [])
        ai_colors = verdict.get("ai_colors", final_colors)
        player_correct = set(picks) == set(final_colors)
        ai_correct = set(ai_colors) == set(final_colors)

        round_number = int(self.round_count) + 1
        record = {
            "round": round_number,
            "stage_id": int(stage_id),
            "player": pid,
            "player_name": name,
            "relayer": _sender_hex(),
            "auth": auth,
            "nonce": int(nonce),
            "player_picks": picks,
            "final_colors": final_colors,
            "ai_colors": ai_colors,
            "player_correct": player_correct,
            "ai_correct": ai_correct,
            "confidence": verdict.get("confidence", 0.0),
            "image_sha256": verdict.get("image_sha256", ""),
        }
        self.rounds.append(json.dumps(record, sort_keys=True))
        self.round_count = u256(round_number)

        self.player_nonces[pid] = u256(int(nonce))
        self._record_result(pid, name, int(stage_id), player_correct, ai_correct, round_number)

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
    def get_stage_evidence(self, stage_id: int) -> str:
        """Everything a client needs to prove it is showing the judged image.

        The game does not get to decide what the player is looking at. It asks
        for the evidence this contract registered — the URL the validators
        fetched — and, once a verdict exists, the SHA-256 of the exact bytes
        they judged. A client that renders anything whose digest differs is
        rendering something the contract never saw.
        """
        sid = self._stage_key(stage_id)
        raw = self.stage_specs.get(sid, "")
        if raw == "":
            return json.dumps({"stage_id": int(stage_id), "registered": False}, sort_keys=True)

        spec = json.loads(str(raw))
        evidence = {
            "stage_id": int(stage_id),
            "registered": True,
            "image_url": str(spec["image_url"]),
            "options": [str(o) for o in spec["options"]],
            "image_sha256": "",
            "image_bytes": 0,
            "judged": False,
        }

        verdict_raw = self.verdicts.get(sid, "")
        if verdict_raw != "":
            verdict = json.loads(str(verdict_raw))
            evidence["image_sha256"] = str(verdict.get("image_sha256", ""))
            evidence["image_bytes"] = int(verdict.get("image_bytes", 0))
            evidence["judged"] = True

        return json.dumps(evidence, sort_keys=True)

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

    @gl.public.view
    def get_player_nonce(self, player_id: str) -> int:
        """The last nonce this player used. The next round must sign a greater one."""
        return int(self.player_nonces.get(self._clean_player_id(player_id), u256(0)))

    @gl.public.view
    def get_player(self, player_id: str) -> str:
        """One player's record, derived entirely from rounds this contract scored."""
        pid = self._clean_player_id(player_id)
        raw = self.player_stats.get(pid, "")
        if raw == "":
            return json.dumps(
                _empty_stats(pid, int(self.player_nonces.get(pid, u256(0))), len(self.stage_ids)),
                sort_keys=True,
            )
        stats = json.loads(str(raw))
        stats["nonce"] = int(self.player_nonces.get(pid, u256(0)))
        stats["total"] = len(self.stage_ids)
        return json.dumps(stats, sort_keys=True)

    @gl.public.view
    def get_player_count(self) -> int:
        return len(self.player_ids)

    @gl.public.view
    def get_leaderboard(self, limit: int) -> str:
        """The leaderboard, computed from the round log rather than reported to it.

        Ranked by stages solved, then by fewest rounds spent solving them, then
        by address so the ordering is total and every node agrees on it.
        """
        count = len(self.player_ids)
        top = count if limit <= 0 or limit > count else int(limit)

        entries = []
        for pid in self.player_ids:
            raw = self.player_stats.get(str(pid), "")
            if raw == "":
                continue
            entries.append(json.loads(str(raw)))

        entries.sort(
            key=lambda e: (
                -int(e.get("score", 0)),
                int(e.get("rounds", 0)),
                str(e.get("player", "")),
            )
        )

        total = len(self.stage_ids)
        board = []
        for rank, entry in enumerate(entries[:top], start=1):
            entry["rank"] = rank
            entry["total"] = total
            board.append(entry)

        return json.dumps(board, sort_keys=True)

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

    # ── Player identity and scoring ───────────────────────────────────────────

    def _authenticate(
        self,
        pid: str,
        stage_id: int,
        picks: list[str],
        name: str,
        nonce: int,
        signature: str,
    ) -> str:
        """Prove the round belongs to `pid`. Returns how it was proved."""
        # A player who paid for their own transaction is already authenticated
        # by the chain — asking them for a second signature would be theatre.
        if _sender_hex() == pid:
            return "sender"

        message = _round_message(pid, stage_id, picks, name, nonce)
        recovered = _recover_signer(message, signature)
        if recovered is None:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} malformed signature for {pid} on stage {stage_id}"
            )
        if recovered != pid:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} signature does not belong to {pid} (recovered {recovered})"
            )
        return "signature"

    def _record_result(
        self,
        pid: str,
        name: str,
        stage_id: int,
        player_correct: bool,
        ai_correct: bool,
        round_number: int,
    ) -> None:
        raw = self.player_stats.get(pid, "")
        if raw == "":
            stats = _empty_stats(pid, 0, len(self.stage_ids))
            self.player_ids.append(pid)
        else:
            stats = json.loads(str(raw))

        bit = 1 << stage_id
        solved = int(stats.get("solved_mask", 0))
        ai_solved = int(stats.get("ai_solved_mask", 0))
        if player_correct:
            solved |= bit
        if ai_correct:
            ai_solved |= bit

        stats["name"] = name
        stats["player"] = pid
        stats["solved_mask"] = solved
        stats["ai_solved_mask"] = ai_solved
        # One bit per stage: replaying a stage you already solved cannot raise
        # your score, so a score is "stages solved", not "correct answers given".
        stats["score"] = _popcount(solved)
        stats["ai_score"] = _popcount(ai_solved)
        stats["rounds"] = int(stats.get("rounds", 0)) + 1
        stats["last_round"] = round_number
        stats["last_stage"] = stage_id
        stats["total"] = len(self.stage_ids)

        self.player_stats[pid] = json.dumps(stats, sort_keys=True)

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
        if stage_id > MAX_STAGE_ID:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} stage_id must be <= {MAX_STAGE_ID}, got {stage_id}"
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
            if "|" in name or "\n" in name:
                # Color names go into the signed round message field-by-field.
                raise gl.vm.UserError(f"{ERROR_EXPECTED} illegal character in color: {name}")
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

    def _clean_player_id(self, player_id: str) -> str:
        """Normalize an address to lowercase 0x-hex — the form signatures recover to."""
        pid = str(player_id).strip().lower()
        if not pid.startswith("0x") or len(pid) != 42:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} player_id must be a 0x address: {player_id}")
        for ch in pid[2:]:
            if ch not in "0123456789abcdef":
                raise gl.vm.UserError(
                    f"{ERROR_EXPECTED} player_id is not hexadecimal: {player_id}"
                )
        return pid

    def _clean_name(self, player_name: str) -> str:
        name = str(player_name).strip()
        if name == "":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} player_name must not be empty")
        if len(name) > MAX_NAME:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} player_name must be <= {MAX_NAME} characters"
            )
        if "\n" in name or "\r" in name:
            # The name is a line in the signed message. A newline inside it
            # would let a player forge the fields that follow.
            raise gl.vm.UserError(f"{ERROR_EXPECTED} player_name must be a single line")
        return name


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


def _sender_hex() -> str:
    """The transaction sender as lowercase 0x-hex, the form addresses compare in.

    `as_hex` is checksummed, and nothing guarantees it carries the 0x prefix, so
    both are normalized rather than assumed — a mismatch here would silently
    send a self-sent round down the signature path instead of recognising the
    sender, and would write a differently-formatted address into the audit log.
    """
    raw = str(gl.message.sender_address.as_hex).strip().lower()
    return raw if raw.startswith("0x") else "0x" + raw


def _sha256(data: bytes) -> str:
    if not _HAS_HASHLIB:
        return ""
    return hashlib.sha256(data).hexdigest()


def _popcount(mask: int) -> int:
    return bin(int(mask)).count("1")


def _empty_stats(pid: str, nonce: int, total: int) -> dict:
    return {
        "player": pid,
        "name": "",
        "solved_mask": 0,
        "ai_solved_mask": 0,
        "score": 0,
        "ai_score": 0,
        "rounds": 0,
        "last_round": 0,
        "last_stage": 0,
        "nonce": nonce,
        "total": total,
    }


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


# ── Signed rounds: message, keccak-256, secp256k1 recovery ────────────────────
#
# All of this is plain deterministic Python running outside any nondeterministic
# block, so every validator computes the same address from the same signature.
#
# There is no ecrecover host function to call, so the two primitives Ethereum
# signing needs are implemented here: keccak-256 (which is *not* hashlib's
# sha3_256 — different padding) and secp256k1 public-key recovery. They are
# exercised against signatures produced by the browser client in
# `contracts/tests/test_signed_rounds.py`.


def _round_message(pid: str, stage_id: int, picks: list[str], name: str, nonce: int) -> str:
    """The exact text the player signs. The client builds this byte-for-byte.

    One field per line, in a fixed order, with the domain first so a signature
    made for MochiMind cannot be lifted into another application. Newlines and
    "|" are rejected inside names and color names, so no field can impersonate
    another.
    """
    return (
        f"{SIGNING_DOMAIN}\n"
        f"player:{pid}\n"
        f"stage:{stage_id}\n"
        f"picks:{'|'.join(picks)}\n"
        f"nonce:{nonce}\n"
        f"name:{name}"
    )


_KECCAK_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]

_KECCAK_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]

_MASK64 = (1 << 64) - 1
_KECCAK_RATE = 136  # bytes absorbed per permutation for keccak-256


def _rotl64(value: int, shift: int) -> int:
    shift %= 64
    if shift == 0:
        return value & _MASK64
    return ((value << shift) | (value >> (64 - shift))) & _MASK64


def _keccak_f(state: list) -> None:
    for rnd in range(24):
        # theta
        c = [
            state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
            for x in range(5)
        ]
        d = [c[(x - 1) % 5] ^ _rotl64(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                state[x + 5 * y] ^= d[x]

        # rho + pi
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl64(state[x + 5 * y], _KECCAK_ROT[x][y])

        # chi
        for x in range(5):
            for y in range(5):
                state[x + 5 * y] = b[x + 5 * y] ^ (
                    (~b[(x + 1) % 5 + 5 * y] & _MASK64) & b[(x + 2) % 5 + 5 * y]
                )

        # iota
        state[0] ^= _KECCAK_RC[rnd]


def _keccak256(data: bytes) -> bytes:
    """Keccak-256 as Ethereum uses it: pad10*1 with the 0x01 domain byte."""
    state = [0] * 25

    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % _KECCAK_RATE != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80

    for offset in range(0, len(padded), _KECCAK_RATE):
        block = padded[offset:offset + _KECCAK_RATE]
        for i in range(_KECCAK_RATE // 8):
            state[i] ^= int.from_bytes(bytes(block[i * 8:i * 8 + 8]), "little")
        _keccak_f(state)

    out = bytearray()
    for i in range(4):  # 4 lanes = 32 bytes of output
        out += state[i].to_bytes(8, "little")
    return bytes(out)


_SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
_SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_SECP256K1_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
_SECP256K1_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8


def _jac_double(pt):
    """Point doubling in Jacobian coordinates — no modular inverse per step."""
    x, y, z = pt
    if y == 0 or z == 0:
        return (0, 0, 0)
    ysq = (y * y) % _SECP256K1_P
    s = (4 * x * ysq) % _SECP256K1_P
    m = (3 * x * x) % _SECP256K1_P  # a = 0 on secp256k1, so no a*z^4 term
    nx = (m * m - 2 * s) % _SECP256K1_P
    ny = (m * (s - nx) - 8 * ysq * ysq) % _SECP256K1_P
    nz = (2 * y * z) % _SECP256K1_P
    return (nx, ny, nz)


def _jac_add(p1, p2):
    if p1[2] == 0:
        return p2
    if p2[2] == 0:
        return p1

    x1, y1, z1 = p1
    x2, y2, z2 = p2
    z1z1 = (z1 * z1) % _SECP256K1_P
    z2z2 = (z2 * z2) % _SECP256K1_P
    u1 = (x1 * z2z2) % _SECP256K1_P
    u2 = (x2 * z1z1) % _SECP256K1_P
    s1 = (y1 * z2 * z2z2) % _SECP256K1_P
    s2 = (y2 * z1 * z1z1) % _SECP256K1_P

    if u1 == u2:
        if s1 != s2:
            return (0, 0, 0)  # P + (-P) = infinity
        return _jac_double(p1)

    h = (u2 - u1) % _SECP256K1_P
    r = (s2 - s1) % _SECP256K1_P
    hh = (h * h) % _SECP256K1_P
    hhh = (h * hh) % _SECP256K1_P
    u1hh = (u1 * hh) % _SECP256K1_P
    nx = (r * r - hhh - 2 * u1hh) % _SECP256K1_P
    ny = (r * (u1hh - nx) - s1 * hhh) % _SECP256K1_P
    nz = (h * z1 * z2) % _SECP256K1_P
    return (nx, ny, nz)


def _jac_mul(pt, k: int):
    k %= _SECP256K1_N
    result = (0, 0, 0)
    addend = pt
    while k:
        if k & 1:
            result = _jac_add(result, addend)
        addend = _jac_double(addend)
        k >>= 1
    return result


def _to_affine(pt):
    x, y, z = pt
    if z == 0:
        return None
    zinv = pow(z, _SECP256K1_P - 2, _SECP256K1_P)  # Fermat inverse, one per recovery
    zinv2 = (zinv * zinv) % _SECP256K1_P
    return ((x * zinv2) % _SECP256K1_P, (y * zinv2 % _SECP256K1_P * zinv) % _SECP256K1_P)


def _ecrecover(msg_hash: bytes, signature: bytes):
    """Recover the signing address from a 65-byte (r, s, v) signature.

    Returns lowercase 0x-hex, or None if the signature is malformed, off-curve,
    or high-s. Rejecting high-s matters: without it the same round could be
    replayed under a second, equally valid signature.
    """
    if len(signature) != 65:
        return None

    r = int.from_bytes(signature[0:32], "big")
    s = int.from_bytes(signature[32:64], "big")
    v = signature[64]
    if v >= 27:
        v -= 27
    if v != 0 and v != 1:
        return None
    if r <= 0 or r >= _SECP256K1_N or s <= 0 or s >= _SECP256K1_N:
        return None
    if s > _SECP256K1_N // 2:  # EIP-2 low-s only
        return None

    # Rebuild R from its x coordinate: y^2 = x^3 + 7, pick the root whose parity
    # matches the recovery id.
    alpha = (pow(r, 3, _SECP256K1_P) + 7) % _SECP256K1_P
    beta = pow(alpha, (_SECP256K1_P + 1) // 4, _SECP256K1_P)
    if (beta * beta) % _SECP256K1_P != alpha:
        return None  # x was not on the curve
    y = beta if (beta % 2 == v % 2) else (_SECP256K1_P - beta) % _SECP256K1_P

    # Q = r^-1 (sR - eG)
    e = int.from_bytes(msg_hash, "big") % _SECP256K1_N
    point = _jac_add(
        _jac_mul((r, y, 1), s),
        _jac_mul((_SECP256K1_GX, _SECP256K1_GY, 1), (_SECP256K1_N - e) % _SECP256K1_N),
    )
    point = _jac_mul(point, pow(r, _SECP256K1_N - 2, _SECP256K1_N))

    affine = _to_affine(point)
    if affine is None:
        return None

    px, py = affine
    digest = _keccak256(px.to_bytes(32, "big") + py.to_bytes(32, "big"))
    return "0x" + digest[12:].hex()


def _recover_signer(message: str, signature_hex: str):
    """Recover the address that produced an EIP-191 `personal_sign` signature."""
    text = str(signature_hex).strip()
    if text.startswith("0x") or text.startswith("0X"):
        text = text[2:]
    if len(text) != 130:
        return None
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        return None

    body = message.encode("utf-8")
    prefix = b"\x19Ethereum Signed Message:\n" + str(len(body)).encode("ascii")
    return _ecrecover(_keccak256(prefix + body), raw)
