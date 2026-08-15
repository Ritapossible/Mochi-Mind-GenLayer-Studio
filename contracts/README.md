# MochiMind Intelligent Contract

`MochiMindValidator.py` is the on-chain referee for MochiMind. It looks at the
real stage image and decides, by validator consensus, which two colors dominate
it.

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
submit_pick(stage_id, player_picks)
```

That is the whole payload: which stage, and the player's guess. The image URL and
the candidate colors are registered on-chain by the contract owner. Dominance is
measured by a vision model looking at the actual PNG. There is no weights table
anywhere in the repository any more.

## How a round works

```
submit_pick(stage_id, player_picks)
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

## Contract API

| Method | Kind | Purpose |
|---|---|---|
| `register_stage(stage_id, image_url, options)` | write, owner | Pin one stage's image and candidate colors |
| `register_stages(specs_json)` | write, owner | Same, in bulk — all 20 in one transaction |
| `analyze_stage(stage_id)` | write, owner | Force a fresh consensus round over the image |
| `submit_pick(stage_id, player_picks)` | write | Play a round; uses the cached verdict if one exists |
| `transfer_ownership(new_owner)` | write, owner | Hand over admin |
| `get_stage_result(stage_id)` | view | Cached verdict JSON for a stage |
| `get_last_result()` | view | Most recent verdict JSON |
| `get_stage(stage_id)` | view | Registered image URL + candidate colors |
| `get_registered_stages()` | view | JSON array of registered stage ids |
| `get_round_count()` / `get_round(i)` | view | On-chain audit log of played rounds |
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

### 2. Lint

```bash
genvm-lint check contracts/MochiMindValidator.py
```

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
