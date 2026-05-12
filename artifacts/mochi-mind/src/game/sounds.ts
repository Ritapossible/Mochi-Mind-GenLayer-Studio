// Web Audio API sound engine for MochiMind.
// All synthesis is done in-browser — no external audio files needed.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  freq: number,
  type: OscillatorType,
  startAt: number,
  duration: number,
  gain = 0.25,
  freqEnd?: number,
) {
  const c = getCtx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.connect(g);
  g.connect(c.destination);
  o.type = type;
  o.frequency.setValueAtTime(freq, startAt);
  if (freqEnd !== undefined) {
    o.frequency.linearRampToValueAtTime(freqEnd, startAt + duration);
  }
  g.gain.setValueAtTime(0.001, startAt);
  g.gain.linearRampToValueAtTime(gain, startAt + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  o.start(startAt);
  o.stop(startAt + duration + 0.05);
}

export function playCountdownBeep(seconds: number) {
  const c = getCtx();
  const t = c.currentTime;
  if (seconds <= 3) {
    const pitch = 660 + (4 - seconds) * 130;
    tone(pitch, "sine", t, 0.18, 0.5);
    if (seconds === 1) tone(pitch * 2, "sine", t + 0.1, 0.14, 0.25);
  } else {
    tone(420 + (6 - seconds) * 35, "sine", t, 0.1, 0.22);
  }
}

export function playLockIn() {
  const c = getCtx();
  const t = c.currentTime;
  tone(392, "sine", t, 0.07, 0.28);
  tone(523, "sine", t + 0.05, 0.1, 0.28);
  tone(784, "sine", t + 0.11, 0.16, 0.25);
}

export function playRevealWhoosh() {
  const c = getCtx();
  const t = c.currentTime;
  tone(100, "sine", t, 0.9, 0.14, 900);
  tone(70, "triangle", t + 0.06, 0.85, 0.09, 700);
}

export function playCardChime(isCorrect: boolean, delayMs: number) {
  const c = getCtx();
  const t = c.currentTime + delayMs / 1000;
  if (isCorrect) {
    [1047, 1319, 1568].forEach((f, i) => tone(f, "sine", t + i * 0.065, 0.32, 0.28));
  } else {
    tone(196, "triangle", t, 0.22, 0.14);
    tone(165, "triangle", t + 0.05, 0.18, 0.1);
  }
}

export function playResultFanfare(
  result: "perfect-match" | "player-wins" | "validator-wins" | "shared-misread",
) {
  const c = getCtx();
  const t = c.currentTime + 0.15;
  if (result === "perfect-match") {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone(f, "sine", t + i * 0.09, 0.75, 0.3),
    );
  } else if (result === "player-wins") {
    [523, 659, 784, 1047].forEach((f, i) =>
      tone(f, "sine", t + i * 0.08, 0.6, 0.26),
    );
  } else if (result === "validator-wins") {
    [392, 330, 262, 196].forEach((f, i) =>
      tone(f, "triangle", t + i * 0.09, 0.5, 0.22),
    );
  } else {
    tone(330, "sine", t, 0.35, 0.2);
    tone(392, "sine", t + 0.14, 0.3, 0.2);
  }
}
