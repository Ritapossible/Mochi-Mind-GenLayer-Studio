// MochiMind stage data — 20 stages of color-identification.
// Each stage: 2 correct dominant colors + 2 decoy colors = 4 candidate options.
// Validator AI uses weighted dominance scores to "see" the image.

export type ColorSwatch = {
  name: string;
  hex: string;
};

export type Stage = {
  id: number;
  name: string;
  hint: string;
  // 4 candidate options shown to the player (2 correct + 2 decoys, shuffled)
  options: ColorSwatch[];
  // Correct answer (subset of options.name, length 2)
  correct: [string, string];
  // Hidden weighted dominance scores used by Validator AI.
  weights: Record<string, number>;
  difficulty: 1 | 2 | 3 | 4 | 5;
  quote?: string;
};

// Color palette
const C = {
  Yellow: "#FACC15",
  Orange: "#FB923C",
  Pink: "#F472B6",
  Green: "#22C55E",
  Brown: "#92400E",
  Blue: "#3B82F6",
  Cyan: "#22D3EE",
  White: "#F8FAFC",
  Purple: "#A855F7",
  Red: "#EF4444",
  Gold: "#F5C518",
  Gray: "#94A3B8",
  "Neon Green": "#39FF14",
  Black: "#0B0B0F",
  Indigo: "#6366F1",
  Silver: "#CBD5E1",
  Magenta: "#E11D74",
  Beige: "#E8D5B7",
  "Electric Blue": "#0EA5FF",
  Lavender: "#C4B5FD",
};

const sw = (n: keyof typeof C): ColorSwatch => ({ name: n, hex: C[n] });

// Deterministic seeded shuffle so the option order stays stable per stage
// across renders, but each stage scatters its correct answers differently.
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed * 9301 + 49297;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mk(
  id: number,
  name: string,
  hint: string,
  correct: [keyof typeof C, keyof typeof C],
  decoys: [keyof typeof C, keyof typeof C],
  difficulty: Stage["difficulty"],
  // Closer to 0.5 means decoy weights approach correct weights (AI may slip).
  trickiness = 0.25,
  quote?: string,
): Stage {
  const [a, b] = correct;
  const [d1, d2] = decoys;
  const wA = 44 - trickiness * 6;
  const wB = 36 - trickiness * 4;
  const wD1 = 18 + trickiness * 22;
  const wD2 = 14 + trickiness * 18;
  const weights: Record<string, number> = {
    [a]: +wA.toFixed(1),
    [b]: +wB.toFixed(1),
    [d1]: +wD1.toFixed(1),
    [d2]: +wD2.toFixed(1),
  };
  const options = shuffle([sw(a), sw(b), sw(d1), sw(d2)], id);
  return { id, name, hint, options, correct: [a, b], weights, difficulty, quote };
}

export const STAGES: Stage[] = [
  mk(1, "Sunrise Mochi", "Warm light over the horizon.", ["Yellow", "Orange"], ["Pink", "Red"], 1, 0.15),
  mk(2, "Forest Mochi", "Hidden in the canopy.", ["Green", "Brown"], ["Yellow", "Blue"], 1, 0.2),
  mk(3, "Ocean Mochi", "Cool currents below the surface.", ["Blue", "Cyan"], ["White", "Green"], 1, 0.25),
  mk(4, "Candy Mochi", "Soft, sweet and unmistakable.", ["Pink", "White"], ["Purple", "Cyan"], 2, 0.3),
  mk(5, "Ember Mochi", "Sparks before the flame.", ["Red", "Orange"], ["Brown", "Yellow"], 2, 0.25,
    "I change more than you think…"),
  mk(6, "Royal Mochi", "Crowned in twilight.", ["Purple", "Gold"], ["Blue", "Silver"], 2, 0.35),
  mk(7, "Storm Mochi", "Rain on cold steel.", ["Gray", "Blue"], ["White", "Black"], 3, 0.4),
  mk(8, "Toxic Mochi", "Glow from the deep.", ["Neon Green", "Black"], ["Yellow", "Purple"], 3, 0.3),
  mk(9, "Sakura Mochi", "Petals dipped in fire.", ["Pink", "Red"], ["White", "Magenta"], 3, 0.45),
  mk(10, "Arctic Mochi", "Breath on a winter pane.", ["White", "Cyan"], ["Blue", "Silver"], 3, 0.5,
    "Can you still see me clearly?"),
  mk(11, "Shadow Mochi", "Mystery walks at night.", ["Black", "Purple"], ["Blue", "Gray"], 4, 0.35),
  mk(12, "Cosmic Mochi", "Born among the stars.", ["Indigo", "Silver"], ["Purple", "Blue"], 4, 0.5),
  mk(13, "Glitch Mochi", "Tokyo at 3 AM.", ["Pink", "Cyan"], ["White", "Magenta"], 4, 0.45),
  mk(14, "Desert Mochi", "Sand kissed by the sun.", ["Beige", "Gold"], ["Orange", "Brown"], 4, 0.55),
  mk(15, "Crystal Mochi", "Pure light, refracted.", ["White", "Silver"], ["Cyan", "Lavender"], 4, 0.6,
    "Not every form hides the truth…"),
  mk(16, "Voltage Mochi", "Thunder in a bottle.", ["Electric Blue", "Yellow"], ["White", "Cyan"], 5, 0.5),
  mk(17, "Eclipse Mochi", "When light meets dark.", ["Black", "White"], ["Purple", "Gray"], 5, 0.55),
  mk(18, "Genesis Mochi", "First whisper of morning.", ["Lavender", "White"], ["Blue", "Pink"], 5, 0.6),
  mk(19, "Proto Mochi", "Almost remembered.", ["Purple", "Silver"], ["White", "Indigo"], 5, 0.55,
    "You've almost remembered…"),
  mk(20, "True Mochi", "Don't forget my true colors.", ["Purple", "White"], ["Blue", "Lavender"], 5, 0.65,
    "My true colors were always Purple and White."),
];

export const TURN_SECONDS = 20;
