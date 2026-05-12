# MochiMind

> “See what AI sees… or better.”

MochiMind is a GenLayer-powered multiplayer visual reasoning mini-game where players compete against Validator AI to identify Mochi’s dominant colors across evolving stages.

Built with GenLayer Intelligent Contracts, MochiMind combines:
- AI validator reasoning
- subjective consensus
- visual intuition
- on-chain intelligent execution
- replayable multiplayer gameplay

---

# Live Concept

Each round:

```text
Blur → Predict → Validator AI Analyzes → Reveal → Score
```

Players are shown a blurred Mochi character and must choose the **2 dominant colors** from 3 available options.

At the same time, Validator AI performs its own reasoning on-chain using GenLayer Intelligent Contracts.

The game then reveals:
- the real dominant colors
- the player’s result
- the Validator AI result
- final scores

After 20 stages, players discover Mochi’s true original identity.

Final Truth:
```text
Purple + White
```

---

# Why MochiMind Exists

MochiMind was designed specifically for the GenLayer mini-game ecosystem to demonstrate:

- Intelligent Contracts
- subjective AI reasoning
- Optimistic Democracy consensus
- multiplayer replayability
- AI vs human intuition

Instead of traditional deterministic gameplay, MochiMind turns **perception itself** into the game mechanic.

---

# Core Features

## Human vs Validator AI

Players compete directly against Validator AI reasoning.

The AI validator analyzes:
- visual dominance
- color weighting
- identity significance
- surface distribution
- perception cues

---

## GenLayer Intelligent Contract Integration

MochiMind uses a real deployed GenLayer Intelligent Contract with:

- `gl.nondet.exec_prompt()`
- AI-powered subjective reasoning
- on-chain consensus execution
- validator agreement flow
- GenVM execution

---

## 20 Evolution Stages

Each Mochi evolution changes:
- dominant colors
- surface balance
- visual structure
- emotional appearance

Stages include:
- Sunrise Mochi
- Toxic Mochi
- Cosmic Mochi
- Forest Mochi
- Shadow Mochi
- Neon Mochi
- Ember Mochi
- Frost Mochi
- and more

---

## Replayable Gameplay

The game is designed to:
- feel fast
- remain replayable
- encourage memory strategy
- reward visual intuition

---

# Tech Stack

## Frontend
- React
- TypeScript
- TailwindCSS
- Framer Motion
- Glassmorphism UI
- Responsive mobile-first design

---

## Backend
- Node.js
- Express
- GenLayer SDK integration

---

## Blockchain / AI Layer
- GenLayer Intelligent Contracts
- GenVM
- Optimistic Democracy Consensus
- AI Validator Reasoning
- `gl.nondet.exec_prompt()`

---

# Intelligent Contract

## Contract Address

```text
0x2Ce9ec4668DA02893D6B6bB5128c77Ef3c40B7ee
```

## Explorer

[GenLayer Studio Explorer Contract](https://explorer-studio.genlayer.com/address/0x2Ce9ec4668DA02893D6B6bB5128c77Ef3c40B7ee)

---

# How The Validator AI Works

The Validator AI receives:
- candidate colors
- dominance scores
- zone weights

The GenLayer Intelligent Contract then:
1. Executes AI reasoning using `gl.nondet.exec_prompt()`
2. Determines dominant colors
3. Stores consensus result on-chain
4. Returns validator reasoning

Example response:

```json
{
  "final_colors": ["Purple", "White"],
  "consensus_reasoning": "Purple and White dominate the visual mass."
}
```

---

# GenLayer Integration

MochiMind uses real GenLayer intelligent execution.

The project demonstrates:
- subjective AI consensus
- non-deterministic execution
- validator agreement
- intelligent contract storage
- AI-native blockchain gameplay

Built using:
- GenLayer Studio
- GenVM
- Intelligent Contracts SDK

Learn more about GenLayer:

- [GenLayer Official Website](https://www.genlayer.com/)
- [GenLayer Studio Docs](https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio)

---

# Project Structure

```bash
MochiMind/
│
├── client/
│   ├── components/
│   ├── pages/
│   ├── assets/
│   └── game/
│
├── server/
│   ├── routes/
│   ├── validator/
│   └── api/
│
├── contracts/
│   └── MochiMindValidator.py
│
├── public/
│
└── README.md
```

---

# Smart Contract Flow

## Deploy Contract

Deploy through:
- GenLayer Studio

Reference:
- [Deploying Contracts in GenLayer Studio](https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio/loading-contract)

---

## Execute AI Validation

Frontend calls:

```python
submit_pick()
```

The Intelligent Contract:
- performs AI reasoning
- reaches validator consensus
- stores result

Then:

```python
get_last_result()
```

returns the final validator decision.

---

# Installation

## Clone Repository

```bash
git clone https://github.com/Ritapossible/Mochi-Mind-GenLayer-Studio.git
```

---

## Install Dependencies

```bash
npm install
```

---

## Run Development Server

```bash
npm run dev
```

---

# Environment Variables

```env
GENLAYER_RPC_URL=
GENLAYER_PRIVATE_KEY=
GENLAYER_CONTRACT_ADDRESS=
```

---

# Example Gameplay Flow

```text
Stage Starts
      ↓
Blurred Mochi Appears
      ↓
Player Picks 2 Colors
      ↓
Validator AI Executes On-chain
      ↓
Consensus Result Returns
      ↓
Blur Fades
      ↓
Winner Decided
      ↓
Next Stage Unlocks
```

---

# Design Philosophy

MochiMind was designed around one core question:

> “Can humans still outperform AI in visual intuition?”

The game transforms:
- perception
- memory
- intuition
- identity recognition

into an on-chain competitive experience.

---

# GenLayer Concepts Demonstrated

MochiMind demonstrates several major GenLayer concepts:

| Feature | Usage |
|---|---|
| Intelligent Contracts | AI reasoning inside contracts |
| Non-deterministic execution | `gl.nondet.exec_prompt()` |
| Optimistic Democracy | validator agreement |
| Subjective consensus | color perception |
| AI-native blockchain logic | gameplay execution |

---

# Performance

Typical validator execution time:

```text
~30–40 seconds
```

This includes:
- AI prompt execution
- validator consensus
- on-chain agreement
- GenVM processing

---

# Future Improvements

- Multiplayer live rooms
- XP leaderboard system
- Weekly tournaments
- NFT Mochi skins
- Wallet progression
- Ranked AI difficulty
- Spectator mode
- Daily challenge mode

---

# Screenshots

```md
![Landing Page](.\screenshots\landingpage.png)
![Gameplay](.\screenshots\gameplay.png)
![Validator AI](.\screenshots\validator.png)
```

---

# Inspiration

MochiMind is inspired by GenLayer’s vision for:
- subjective consensus
- AI-native contracts
- programmable reasoning
- intelligent multiplayer systems

---

# Acknowledgements

Built for the GenLayer Mini-Games ecosystem.

Powered by:
- [GenLayer](https://www.genlayer.com/)
- [GenLayer Studio](https://docs.genlayer.com/developers/intelligent-contracts/tools/genlayer-studio)

---

# License

MIT License

---

# Author

RitaCryptoTips

X:
[@RitaCryptoTips](https://x.com/RitaCryptoTips)
````7
