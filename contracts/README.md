# MochiMind Intelligent Contract

`MochiMindValidator.py` is the on-chain referee for MochiMind. It looks at the
real stage image and decides, by validator consensus, which two colors dominate
it — and it decides who played the round and what everyone's score is.

```text
Deployed:  0x6A7d19f5e540A7b4C5d67714b4D173d223b5b1b5
Explorer:  https://explorer-studio.genlayer.com/address/0x6A7d19f5e540A7b4C5d67714b4D173d223b5b1b5
Network:   GenLayer Studio (studionet)
Owner:     0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
```

## What changed and why

The first submission of this project was rejected on two counts. Both are fixed
here.

**1. The contract source was not in the repository.** The README described
`contracts/MochiMindValidator.py` and linked a deployed address, but the file was
never committed. It is now the file next to this README.

**2. The contract was handed the answer.** The old client called:

```ts
submit_pick(stage_id, candidate_colors, dominance_scores, zone_weights)
```

where `dominance_scores` came from a `weights` table in `stages.ts`:

```ts
const wA = 44 - trickiness * 6;   // ← always the highest, always a correct color
const wB = 36 - trickiness * 4;   // ← always second, always the other correct color
const wD1 = 18 + trickiness * 22; // ← decoy
const wD2 = 14 + trickiness * 18; // ← decoy
```

The two correct colors always carried the two largest weights. Any contract
receiving that payload could return the right answer by sorting four numbers. The
LLM call was decoration; consensus had nothing to disagree about, because every
validator was reading the same client-supplied answer key. That is the pattern
GenLayer's own guidance tells you to avoid — *"the frontend already computes the
final answer and GenLayer would only rubber-stamp it."*

**Now** the client calls:

```ts
submit_pick(stage_id, player_picks, player_id, player_name, nonce, signature)
```

The image URL and the candidate colors are registered on-chain by the contract
owner. Dominance is measured by a vision model looking at the actual PNG. There
is no weights table anywhere in the repository any more.

**3. The round was judged on-chain, but the player was not.** The third review
put it exactly:

> Consensus determines the round answer, but player identity, scoring, and the
> leaderboard still rely on a shared signer and client-submitted data.

That was true. Every transaction was signed by one server key, so
`gl.message.sender_address` was the relayer on every round and the audit log
credited all of them to the same address. Identity was a Discord name typed into
a browser. The score was counted in JavaScript and POSTed to a Postgres table
that would accept any number from any caller.

Now the player signs the round, this contract verifies the signature, and the
score is something the contract computes rather than something it is told. The
two sections below are the substance of that change.

## How a round works

```
submit_pick(stage_id, picks, player_id, name, nonce, signature)
        │
        ├─ recover the signer from the round message → must equal player_id
        ├─ nonce must exceed this player's last one  → no replays
        │
        ├─ look up the stage in on-chain storage → image_url, candidate colors
        │
        ├─ LEADER      gl.nondet.web.get(image_url)      → raw PNG bytes
        │              verify PNG/JPEG magic bytes       → reject HTML error pages
        │              gl.nondet.exec_prompt(..., images=[png])
        │              normalize → coverage % per candidate, ranked
        │
        ├─ VALIDATORS  re-fetch the same image, re-run the same judgment,
        │              then compare decisions (not formatting)
        │
        ├─ consensus → final_colors  (ground truth for the round)
        ├─ derive    → ai_colors     (the opponent's move, see below)
        ├─ score     → set this stage's bit in the player's solved_mask
        └─ store     → verdict + append the round to the on-chain audit log
```

### The equivalence principle used

`gl.vm.run_nondet_unsafe` with a custom validator function. Not `strict_eq` —
two vision models will never agree on exact percentages. Not a schema check
either: a validator that only confirms the leader returned well-formed JSON is
not consensus, it is trust.

Each validator independently fetches the image and forms its own opinion, then:

- Same two colors → **agree**.
- No colors in common → **disagree**, rotate the leader.
- One color in common → agree **only if** the disputed colors' coverage estimates
  are within `COVERAGE_TOLERANCE` (10 percentage points) of each other. That is
  the explicit tolerance for "these two colors were effectively tied", which
  genuinely happens on stages like Crystal Mochi (White vs Silver).

Failures are classified with `[EXPECTED]` / `[EXTERNAL]` / `[TRANSIENT]` /
`[LLM_ERROR]` prefixes so validators compare error paths correctly rather than
agreeing on broken state.

### Truth vs the AI opponent

Consensus decides the truth. If the AI opponent simply reused it, the AI would
score 20/20 every game and "Human vs Validator AI" would be meaningless.

So `_derive_opponent` handicaps it in the one place a handicap is honest: when
the vision model itself measured the 2nd and 3rd colors as nearly tied
(`AMBIGUITY_GAP`, 6 points), the opponent has to commit and can commit wrongly.
The choice is derived from the image digest, not from randomness, so every
validator computes the same opponent move and the round stays deterministic once
the nondeterministic block closes.

The AI is therefore reliably right on obvious stages and beatable on ambiguous
ones — which is the game.

## Who played the round

The relayer pays the gas so nobody needs a wallet to play. That is a real
convenience and it used to cost the whole identity model: if the relayer sends
the transaction, `gl.message.sender_address` describes the relayer, and anything
the relayer says about *which player* it was relaying for is unverified.

So the round is signed by the player, in the browser, before it is handed over:

```
MochiMind v2
player:0x5002adc2641903002783cf4f80c4a41a594a1712
stage:7
picks:Gray|Blue
nonce:1767225600123
name:rita
```

signed with EIP-191 `personal_sign`, exactly as `_round_message` builds it. The
contract hashes the same text, recovers the address, and rejects the round
unless it equals `player_id`. What that buys:

| The relayer cannot | because |
|---|---|
| credit a round to a player who did not play it | it cannot produce that player's signature |
| change the picks in a round it is relaying | the picks are inside the signed text |
| rename a player, or play under someone's name | the name is inside the signed text |
| replay a round it already relayed | `nonce` must exceed that player's last one |

A player who signs the transaction themselves is authenticated by the chain
already, so if `gl.message.sender_address == player_id` no signature is
required. That is the upgrade path to real wallets, and it needs no contract
change.

### The crypto, and why it is in here

GenVM exposes no `ecrecover`, so the contract implements the two primitives
itself, at module level, in deterministic Python that runs outside every
nondeterministic block:

- `_keccak256` — Keccak-256, which is *not* `hashlib.sha3_256`; the padding byte
  differs, and getting it wrong is silent until no signature verifies
- `_ecrecover` — secp256k1 public-key recovery in Jacobian coordinates, so a
  recovery costs one modular inversion rather than one per bit

It rejects high-`s` signatures (EIP-2). Without that, `(r, n-s)` is a second
valid signature for the same round and the replay check could be walked around.

Hand-rolled crypto is worth what its test vectors are worth:

```bash
pnpm --filter @workspace/scripts sign-vectors   # sign fixtures with genlayer-js
python contracts/tests/test_signed_rounds.py    # verify them with the contract's own code
```

And it is worth checking against the deployment rather than only in the
abstract, because "does secp256k1 recovery in pure Python fit inside GenVM" is
not a question a local test can answer:

```bash
GENLAYER_CONTRACT_ADDRESS=0x... GENLAYER_PRIVATE_KEY=0x... \
pnpm --filter @workspace/scripts test-round 1
```

That plays a stage as a player nobody has ever seen, relayed by the owner key
the way the server relays, and then tries to break it. Against the deployment
above:

```text
evidence
  ok  served image is byte-identical to the judged image
signed round
  ok  round is credited to the player — player=0x0e8c1a26…
  ok  round records the relayer separately — relayer=0xaa34e14a…
  ok  round is marked signature-authenticated
  ok  player appears on the contract's leaderboard
forgery (must be rejected)
  ok  relayer cannot forge a round for another address
replay (must be rejected)
  ok  the same signed round cannot be relayed twice
```

> Reading a GenLayer receipt correctly matters here. A transaction whose call
> reverted still finalizes with `status: 7` and `result_name: MAJORITY_AGREE` —
> the validators agreed, and what they agreed on was that it failed. The outcome
> is `consensus_data.leader_receipt.execution_result`, and the reason is that
> receipt's `result.payload`, which carries the contract's own error text:
> `[EXPECTED] malformed signature for 0x1111… on stage 1`. Checking the top
> level instead reports every revert as a success. See `scripts/src/receipt.ts`.

The fixtures are signed by the same `signMessage` call the game makes, over
messages built by the game's own message builder, so a drift between the
browser and the contract is a failing test instead of a game where every round
is rejected. The suite also covers the keccak edge cases, tampered and
truncated signatures, the malleable high-`s` variant, and the newline injection
that a name like `rita\nnonce:0` would otherwise allow.

### What this does not claim

Two limits, stated rather than glossed over:

- **The signed message does not name the contract.** It carries the domain
  `MochiMind v2`, not an address, so a round signed against one deployment of
  this contract would verify against another. Within a deployment the nonce
  prevents replay. The consequence is bounded — a replayed round still has that
  player's picks, and it is still scored by the contract against its own
  verdict, so nothing can be fabricated — but a fresh deployment can inherit a
  round from an old one. Adding the address to the message closes it, at the
  cost of the client having to read the domain from the contract before signing.
- **The player's key lives in `localStorage`.** It is a game identity, never a
  wallet: it holds no funds and signs nothing but round messages. Clearing site
  data loses the identity and the score attached to it, and anything that can
  run script on the page can sign rounds as that player. The upgrade path is the
  sender branch in `_authenticate` — connect a real wallet, send the transaction
  yourself, and the chain authenticates you with no contract change.

## Where a score comes from

Nothing writes a score. `submit_pick` compares the player's picks to the
consensus verdict and sets one bit per stage in that player's `solved_mask`:

```python
stats["score"] = _popcount(solved)
```

Score is therefore *stages solved*, not answers given — replaying a stage you
already solved cannot raise it, and neither can playing the same stage a hundred
times. `get_leaderboard` ranks those records on-chain by score, then by fewest
rounds, then by address, so the ordering is total and every node agrees on it.

The API server reads that board and renames the fields. It has no write path to
it, and the old `POST /api/leaderboard` now answers `410 Gone`.

## Binding the image to the evidence

`get_stage_evidence(stage_id)` returns the URL the validators were pointed at,
the candidate colors, and — once a verdict exists — the SHA-256 of the exact
bytes they judged:

```json
{
  "stage_id": 7,
  "registered": true,
  "image_url": "https://your-app.vercel.app/stages/stage-07.png",
  "options": ["Gray", "Blue", "White", "Black"],
  "image_sha256": "9f2c…",
  "image_bytes": 118422,
  "judged": true
}
```

The game fetches those bytes from that URL, hashes them in the browser with
WebCrypto, renders *the bytes it hashed*, and shows the result on the image:
**Evidence verified · 9f2c…** — or a mismatch warning, which is deliberately not
hidden. See `artifacts/mochi-mind/src/game/evidence.ts`. The candidate colors
come from the same read, because those are the only names `submit_pick` accepts.

## Contract API

| Method | Kind | Purpose |
|---|---|---|
| `register_stage(stage_id, image_url, options)` | write, owner | Pin one stage's image and candidate colors |
| `register_stages(specs_json)` | write, owner | Same, in bulk — all 20 in one transaction |
| `analyze_stage(stage_id)` | write, owner | Force a fresh consensus round over the image |
| `submit_pick(stage_id, picks, player_id, name, nonce, signature)` | write | Play a signed round; scores it against the verdict |
| `transfer_ownership(new_owner)` | write, owner | Hand over admin |
| `get_stage_result(stage_id)` | view | Cached verdict JSON for a stage |
| `get_last_result()` | view | Most recent verdict JSON |
| `get_stage(stage_id)` | view | Registered image URL + candidate colors |
| `get_stage_evidence(stage_id)` | view | Image URL + SHA-256 the client binds the display to |
| `get_registered_stages()` | view | JSON array of registered stage ids |
| `get_round_count()` / `get_round(i)` | view | On-chain audit log of played rounds |
| `get_player(player_id)` | view | One player's record, derived from their rounds |
| `get_player_nonce(player_id)` | view | Last nonce used; the next round must exceed it |
| `get_player_count()` | view | How many players have a record |
| `get_leaderboard(limit)` | view | Ranked player records, computed on-chain |
| `get_owner()` | view | Current owner address |

Verdict shape:

```json
{
  "stage_id": 20,
  "final_colors": ["Purple", "White"],
  "ai_colors": ["Purple", "Lavender"],
  "coverage": { "Purple": 44.1, "White": 31.7, "Lavender": 15.2, "Blue": 9.0 },
  "confidence": 16.5,
  "consensus_reasoning": "Purple covers the body, white the face and belly.",
  "image_url": "https://your-app.vercel.app/stages/stage-20.png",
  "image_sha256": "…",
  "image_bytes": 136107,
  "source": "onchain-vision"
}
```

## Caching

A verdict is computed once per stage and reused. A consensus round costs 60–120 s
on Studio; making every player wait through one for an image that has already
been judged would be unplayable, and re-judging an unchanged PNG adds nothing.

- `submit_pick` uses the cached verdict when there is one, and still records the
  round in the on-chain log.
- `analyze_stage` always runs a fresh round — use it to demo consensus.
- `register_stage` clears the cached verdict, because the evidence changed.

## Deploying

### Prerequisites

```bash
npm install -g genlayer
genlayer network set studionet
```

The GenLayer Skills plugin automates most of this if you prefer:

```bash
claude /plugin marketplace add genlayerlabs/skills
claude /plugin install genlayer-dev@genlayerlabs
```

### 1. Host the stage images first

The contract fetches `<base>/stages/stage-NN.png` over https, and every
validator fetches it independently. The URLs must be public, un-authenticated
and stable. They are served from `artifacts/mochi-mind/public/stages/`, so
deploying the frontend is what publishes them.

Verify one is reachable before going further:

```bash
curl -I https://your-app.vercel.app/stages/stage-01.png
```

### 2. Lint and test

```bash
genvm-lint check contracts/MochiMindValidator.py
pnpm --filter @workspace/scripts sign-vectors
python contracts/tests/test_signed_rounds.py
```

The second and third commands check the signature verification before it is
deployed: fresh signatures from the game client, verified by the contract's own
keccak and recovery code. Contracts are immutable — a bug here would mean
redeploying and re-registering every stage.

### 3. Deploy

```bash
genlayer deploy --contract contracts/MochiMindValidator.py
```

Note the deployed address. The account you deploy from becomes the owner and is
the only account that can register stages.

Or paste the file into [studio.genlayer.com](https://studio.genlayer.com) and
deploy from there.

> Studio validators must be configured with a **vision-capable model**
> (GPT-5, Claude Sonnet). A text-only validator cannot see the image and every
> round will fail.

### 4. Register the stages

```bash
GENLAYER_CONTRACT_ADDRESS=0xYourNewAddress \
GENLAYER_PRIVATE_KEY=0xYourDeployerKey \
MOCHI_IMAGE_BASE_URL=https://your-app.vercel.app \
pnpm --filter @workspace/scripts register-stages
```

The script fetches every image first and refuses to register anything if one is
unreachable or returns HTML instead of a PNG — registering a bad URL would make
every round for that stage fail on-chain.

### 5. Point the API server at it

Set on the api-server deployment:

```env
GENLAYER_CONTRACT_ADDRESS=0xYourNewAddress
GENLAYER_PRIVATE_KEY=0xTheDeployerKey
```

> **Use the deployer (owner) key here.** `analyze_stage` is owner-only, so the
> `/api/validator/analyze` endpoint only works when the api-server signs as the
> owner. `submit_pick` is callable by anyone, so gameplay would still work with a
> separate spender key — but the analyze endpoint would return
> `[EXPECTED] owner only`. If you would rather keep the deployer key offline, call
> `transfer_ownership` to hand admin to the api-server's account after registering
> the stages.

and on the frontend:

```env
VITE_API_BASE_URL=https://your-api-server-host
```

Then check it end to end:

```bash
curl https://your-api-server-host/api/validator/status
curl -X POST https://your-api-server-host/api/validator/analyze \
  -H 'Content-Type: application/json' -d '{"stageId":1}'
```

The second call runs a real consensus round and takes 60–120 s.

## Key handling

`GENLAYER_PRIVATE_KEY` is a server-side variable and must never be given a
`VITE_` prefix. Anything prefixed `VITE_` is inlined into the browser bundle by
Vite and is public. The previous version read `VITE_SPENDER_PRIVATE_KEY` in the
browser, which published the spender key to every visitor; that path is gone.

Use a throwaway account funded only for gas.
