import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  ArrowRight, Brain, Check, Clock, ExternalLink, Lock, Play, RotateCcw,
  Sparkles, Trophy, Wifi, Zap,
} from "lucide-react";
import { STAGES, TURN_SECONDS, type Stage } from "@/game/stages";
import { endgameTitle, scoreRound, validatorAnalyze, type RoundResult } from "@/game/validator";
import {
  playCountdownBeep, playLockIn, playRevealWhoosh,
  playCardChime, playResultFanfare,
} from "@/game/sounds";
import logo from "@/assets/logo.jpg";
import { STAGE_IMAGES } from "@/assets/stages";

export const Route = createFileRoute("/play")({
  component: PlayPage,
});

type Phase = "playing" | "revealing" | "result" | "endgame";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

async function submitScore(username: string, score: number, total: number) {
  try {
    await fetch(`${API_BASE}/api/leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, score, total }),
    });
  } catch {
    // silent — leaderboard submission is best-effort
  }
}

function PlayPage() {
  const navigate = useNavigate();

  // Discord username gate — shown before first game
  const [discordUsername, setDiscordUsername] = useState<string>(
    () => localStorage.getItem("mochimind_discord") ?? "",
  );
  const [showUsernameModal, setShowUsernameModal] = useState<boolean>(
    () => !localStorage.getItem("mochimind_discord"),
  );

  const [stageIdx, setStageIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("playing");
  const [secondsLeft, setSecondsLeft] = useState(TURN_SECONDS);
  const [playerPicks, setPlayerPicks] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [validatorPicks, setValidatorPicks] = useState<[string, string] | null>(null);
  const [validatorFetchMs, setValidatorFetchMs] = useState<number | null>(null);
  const [validatorSource, setValidatorSource] = useState<"onchain" | "local-consensus" | null>(null);
  const [validatorTxHash, setValidatorTxHash] = useState<string | null>(null);
  const [playerScore, setPlayerScore] = useState(0);
  const [validatorScore, setValidatorScore] = useState(0);
  const [roundResult, setRoundResult] = useState<RoundResult | null>(null);
  const [revealFlash, setRevealFlash] = useState(false);
  const [consensusElapsed, setConsensusElapsed] = useState(0);
  const tickRef = useRef<number | null>(null);
  const consensusTickRef = useRef<number | null>(null);

  const stage = STAGES[stageIdx];
  const total = STAGES.length;

  function resetStage() {
    setPhase("playing");
    setSecondsLeft(TURN_SECONDS);
    setPlayerPicks([]);
    setLocked(false);
    setValidatorPicks(null);
    setValidatorFetchMs(null);
    setValidatorSource(null);
    setValidatorTxHash(null);
    setRoundResult(null);
    setRevealFlash(false);
    setConsensusElapsed(0);
    if (consensusTickRef.current) window.clearInterval(consensusTickRef.current);
  }

  // Count up seconds while waiting for on-chain consensus
  useEffect(() => {
    if (phase === "revealing" && validatorPicks === null) {
      setConsensusElapsed(0);
      consensusTickRef.current = window.setInterval(() => {
        setConsensusElapsed((s) => s + 1);
      }, 1000);
    } else {
      if (consensusTickRef.current) {
        window.clearInterval(consensusTickRef.current);
        consensusTickRef.current = null;
      }
    }
    return () => {
      if (consensusTickRef.current) window.clearInterval(consensusTickRef.current);
    };
  }, [phase, validatorPicks]);

  useEffect(() => {
    if (phase !== "playing") return;
    tickRef.current = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(tickRef.current!);
          handleLock(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (tickRef.current) window.clearInterval(tickRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stageIdx]);

  useEffect(() => {
    if (phase !== "playing") return;
    if (secondsLeft <= 5 && secondsLeft > 0) playCountdownBeep(secondsLeft);
  }, [secondsLeft, phase]);

  useEffect(() => {
    if (phase !== "result") return;
    setRevealFlash(true);
    const t = window.setTimeout(() => setRevealFlash(false), 600);
    return () => window.clearTimeout(t);
  }, [phase]);

  function togglePick(name: string) {
    if (locked || phase !== "playing") return;
    setPlayerPicks((cur) => {
      if (cur.includes(name)) return cur.filter((c) => c !== name);
      if (cur.length >= 2) return cur;
      return [...cur, name];
    });
  }

  async function handleLock(timedOut = false) {
    if (locked) return;
    setLocked(true);
    playLockIn();
    if (tickRef.current) window.clearInterval(tickRef.current);

    // Immediately reveal so the validator panel shows "On-chain AI analyzing..."
    // writeContract + GenLayer consensus can take 60–120 s on Studio.
    setPhase("revealing");
    playRevealWhoosh();

    const t0 = performance.now();
    const v = await validatorAnalyze(stage);
    const elapsed = Math.round(performance.now() - t0);
    setValidatorPicks(v.picks);
    setValidatorFetchMs(elapsed);
    setValidatorSource(v.source);
    if (v.txHash) setValidatorTxHash(v.txHash);

    // Brief pause so the validator chips animate in before result cards flip
    window.setTimeout(() => {
      const r = scoreRound(timedOut ? [] : playerPicks, v.picks, stage.correct);
      setPlayerScore((s) => s + r.player);
      setValidatorScore((s) => s + r.validator);
      setRoundResult(r.result);
      setPhase("result");
      stage.options.forEach((_, i) => {
        const isCorrect = stage.correct.includes(stage.options[i].name as never);
        window.setTimeout(() => playCardChime(isCorrect, 0), i * 150 + 80);
      });
      window.setTimeout(() => playResultFanfare(r.result), stage.options.length * 150 + 480);
    }, 900);
  }

  function next() {
    if (stageIdx + 1 >= total) { setPhase("endgame"); return; }
    setStageIdx((i) => i + 1);
    resetStage();
  }

  function restart() {
    setStageIdx(0);
    setPlayerScore(0);
    setValidatorScore(0);
    resetStage();
  }

  if (phase === "endgame") {
    return (
      <EndgameScreen
        playerScore={playerScore}
        validatorScore={validatorScore}
        total={total}
        discordUsername={discordUsername}
        onRestart={restart}
        onHome={() => navigate({ to: "/" })}
        onLeaderboard={() => navigate({ to: "/leaderboard" })}
      />
    );
  }

  const blurred = phase === "playing" || phase === "revealing";
  const isResult = phase === "result";

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Discord username gate */}
      {showUsernameModal && (
        <DiscordModal
          onConfirm={(name) => {
            setDiscordUsername(name);
            setShowUsernameModal(false);
          }}
        />
      )}

      {/* Flash overlay on reveal */}
      <AnimatePresence>
        {revealFlash && (
          <motion.div
            key="flash"
            className="fixed inset-0 z-[200] pointer-events-none"
            style={{ background: "radial-gradient(ellipse at center, white 0%, oklch(0.88 0.12 295) 60%, transparent 100%)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.85, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, times: [0, 0.18, 1] }}
          />
        )}
      </AnimatePresence>

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b-[3px] border-[color:var(--primary-deep)]/30">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 py-2.5 flex items-center justify-between gap-2">
          <Link to="/" className="flex items-center gap-1.5 shrink-0">
            <img src={logo} alt="MochiMind" className="h-7 w-7 sm:h-8 sm:w-8 rounded-lg object-cover ring-2 ring-[color:var(--primary-deep)]" />
            <span className="font-bold tracking-tight text-sm hidden sm:inline">MochiMind</span>
          </Link>

          {/* Stage progress */}
          <div className="flex-1 min-w-0 mx-2">
            <div className="flex items-center justify-between text-[9px] sm:text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">
              <span className="shrink-0">Stage {String(stage.id).padStart(2, "0")}/{total}</span>
              <span className="hidden sm:block truncate max-w-[160px] text-right">{stage.name}</span>
            </div>
            <Progress value={((stage.id - 1) / total) * 100} className="h-1" />
          </div>

          {/* Scores */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            <ScorePill label="You" value={playerScore} />
            <span className="text-primary font-black text-xs">vs</span>
            <ScorePill label="AI" value={validatorScore} ai />
          </div>
        </div>
      </header>

      {/* ── Main layout ── */}
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4 sm:py-8 space-y-4 lg:space-y-0 lg:grid lg:grid-cols-[1fr_300px] lg:gap-6">

        {/* LEFT — game area */}
        <section className="space-y-3">
          {/* Mochi art */}
          <MochiArtCard stage={stage} blurred={blurred} />

          {/* Hint + Timer row */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className={`text-[9px] sm:text-[10px] uppercase tracking-[0.25em] font-extrabold shrink-0 ${phase === "playing" ? "hint-blink" : "text-primary"}`}>
                Hint
              </span>
              <p className={`text-xs sm:text-sm italic truncate ${phase === "playing" ? "hint-blink" : "text-foreground/90"}`}>
                "{stage.hint}"
              </p>
            </div>
            <TimerChip seconds={secondsLeft} active={phase === "playing"} />
          </div>

          {/* Color picker */}
          <div>
            <div className="text-[9px] sm:text-[10px] uppercase tracking-[0.25em] text-primary font-extrabold mb-2">
              Pick the 2 dominant colors
            </div>

            <AnimatePresence mode="wait">
              {!isResult ? (
                <motion.div
                  key="active-grid"
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.18 }}
                  className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3"
                >
                  {stage.options.map((opt) => {
                    const selected = playerPicks.includes(opt.name);
                    return (
                      <button
                        key={opt.name}
                        onClick={() => togglePick(opt.name)}
                        disabled={locked}
                        className={`group relative rounded-2xl p-3 sm:p-4 border-[3px] transition-all duration-200 text-left bg-card
                          ${selected
                            ? "border-[color:var(--primary-deep)] shadow-chunky -translate-y-0.5"
                            : "border-[color:var(--primary-deep)]/40 shadow-chunky-sm hover:-translate-y-0.5 hover:border-[color:var(--primary-deep)]"}
                          ${locked ? "cursor-not-allowed opacity-90" : "cursor-pointer"}`}
                      >
                        <div
                          className="h-12 sm:h-16 w-full rounded-xl mb-2 sm:mb-3 ring-2 ring-[color:var(--primary-deep)]/30"
                          style={{ background: opt.hex }}
                        />
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs sm:text-sm font-extrabold truncate">{opt.name}</span>
                          {selected && (
                            <span className="shrink-0 h-4 w-4 sm:h-5 sm:w-5 rounded-full bg-primary text-primary-foreground grid place-items-center border-2 border-[color:var(--primary-deep)]">
                              <Check className="size-2.5 sm:size-3" strokeWidth={3} />
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </motion.div>
              ) : (
                <motion.div
                  key="reveal-grid"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3"
                >
                  {stage.options.map((opt, i) => {
                    const isCorrect = stage.correct.includes(opt.name as never);
                    const wasSelected = playerPicks.includes(opt.name);
                    return (
                      <motion.div
                        key={opt.name}
                        initial={{ opacity: 0, rotateY: -90, scale: 0.8 }}
                        animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                        transition={{ delay: i * 0.15, type: "spring", stiffness: 200, damping: 18 }}
                        style={{ transformPerspective: 1200 }}
                        className={`relative rounded-2xl p-3 sm:p-4 border-[3px] text-left
                          ${isCorrect
                            ? "border-[color:var(--primary-deep)] shadow-chunky bg-primary/8"
                            : "border-[color:var(--primary-deep)]/30 bg-card shadow-chunky-sm opacity-75"}
                          ${wasSelected && !isCorrect ? "border-destructive/50" : ""}`}
                      >
                        {isCorrect && (
                          <motion.div
                            className="absolute inset-0 rounded-2xl pointer-events-none"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: [0, 1, 0.6] }}
                            transition={{ delay: i * 0.15 + 0.3, duration: 0.5 }}
                            style={{ boxShadow: `0 0 24px 4px ${opt.hex}88` }}
                          />
                        )}
                        <div
                          className={`h-12 sm:h-16 w-full rounded-xl mb-2 sm:mb-3 ring-2 ${isCorrect ? "ring-[color:var(--primary-deep)]" : "ring-[color:var(--primary-deep)]/20"}`}
                          style={{ background: opt.hex }}
                        />
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs sm:text-sm font-extrabold truncate">{opt.name}</span>
                          {isCorrect && (
                            <span className="text-[8px] sm:text-[10px] uppercase tracking-widest text-primary font-extrabold shrink-0">✓</span>
                          )}
                        </div>
                        {isCorrect && <CardParticles hex={opt.hex} cardIndex={i} />}
                      </motion.div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Action row */}
            <div className="mt-3 sm:mt-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              {!isResult ? (
                locked ? (
                  <Button variant="hero" size="lg" className="rounded-full w-full sm:w-auto opacity-60 cursor-not-allowed" disabled>
                    <Lock className="size-4" /> Locked
                  </Button>
                ) : (
                  <Button
                    variant="hero"
                    size="lg"
                    className="rounded-full w-full sm:w-auto"
                    disabled={playerPicks.length !== 2}
                    onClick={() => handleLock(false)}
                  >
                    <Lock className="size-4" /> Lock In
                  </Button>
                )
              ) : (
                <Button
                  variant="hero"
                  size="lg"
                  className="rounded-full w-full sm:w-auto"
                  onClick={next}
                >
                  {stageIdx + 1 >= total ? "See Final Results" : "Next Stage"} <ArrowRight className="size-4" />
                </Button>
              )}
              <span className="text-xs text-muted-foreground text-center sm:text-left">
                {playerPicks.length}/2 selected
              </span>
            </div>
          </div>

          {/* Stage quote (mobile only, hidden on lg where panel shows it) */}
          {stage.quote && isResult && (
            <p className="lg:hidden text-center italic text-sm text-muted-foreground px-2 pt-1">
              "{stage.quote}"
            </p>
          )}
        </section>

        {/* RIGHT — Validator panel */}
        <aside>
          <ValidatorPanel
            phase={phase}
            picks={validatorPicks}
            correct={stage.correct}
            result={roundResult}
            playerPicks={playerPicks}
            fetchMs={validatorFetchMs}
            source={validatorSource}
            quote={stage.quote}
            consensusElapsed={consensusElapsed}
            txHash={validatorTxHash}
          />
        </aside>
      </div>
    </main>
  );
}

// ─── Card Particles ───────────────────────────────────────────────────────────

function CardParticles({ hex, cardIndex }: { hex: string; cardIndex: number }) {
  const particles = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => {
        const angle = (i / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const dist = 38 + Math.random() * 55;
        return {
          tx: Math.round(Math.cos(angle) * dist),
          ty: Math.round(Math.sin(angle) * dist),
          delay: cardIndex * 150 + i * 28 + Math.floor(Math.random() * 25),
          size: 6 + Math.floor(Math.random() * 6),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardIndex],
  );
  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible" aria-hidden>
      {particles.map((p, i) => (
        <div
          key={i}
          className="mochi-particle absolute top-1/2 left-1/2 rounded-full"
          style={{
            "--tx": `${p.tx}px`,
            "--ty": `${p.ty}px`,
            width: p.size,
            height: p.size,
            background: hex,
            opacity: 0,
            animationDelay: `${p.delay}ms`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// ─── Score Pill ───────────────────────────────────────────────────────────────

function ScorePill({ label, value, ai = false }: { label: string; value: number; ai?: boolean }) {
  return (
    <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-card border-[3px] border-[color:var(--primary-deep)] shadow-chunky-sm">
      <span className={`h-1.5 w-1.5 rounded-full ${ai ? "bg-accent" : "bg-primary"}`} />
      <span className="text-muted-foreground font-bold text-xs">{label}</span>
      <motion.span
        key={value}
        initial={{ scale: 1.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="font-black tabular-nums text-primary text-xs sm:text-sm"
      >
        {value}
      </motion.span>
    </div>
  );
}

// ─── Timer Chip ───────────────────────────────────────────────────────────────

function TimerChip({ seconds, active }: { seconds: number; active: boolean }) {
  const danger = seconds <= 5;
  return (
    <div
      className={`flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full border-[3px] text-xs tabular-nums font-extrabold shadow-chunky-sm bg-card shrink-0
        ${danger ? "border-destructive text-destructive" : "border-[color:var(--primary-deep)] text-primary"}
        ${active ? "timer-tick" : "opacity-60"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${danger ? "bg-destructive animate-pulse" : "bg-primary"}`} />
      {String(seconds).padStart(2, "0")}s
    </div>
  );
}

// ─── Validator Fetch Chip ─────────────────────────────────────────────────────

function ValidatorFetchChip({
  phase, fetchMs, source,
}: { phase: Phase; fetchMs: number | null; source: "onchain" | "local-consensus" | null }) {
  if (phase === "playing") return null;
  return (
    <AnimatePresence>
      <motion.div
        key={source ?? "loading"}
        initial={{ opacity: 0, y: -6, height: 0 }}
        animate={{ opacity: 1, y: 0, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.35 }}
        className="overflow-hidden mb-3"
      >
        {phase === "revealing" && fetchMs === null ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-[color:var(--primary-deep)]/30 bg-secondary text-[11px] font-bold text-muted-foreground w-fit">
            <Clock className="size-3 animate-pulse" />
            Consulting AI Validators…
          </div>
        ) : source === "local-consensus" ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-violet-400/60 bg-violet-50 text-[11px] font-extrabold text-violet-700 w-fit">
            <Brain className="size-3" />
            3 AI Validators · Simulated
            {fetchMs !== null && <span className="ml-1 opacity-70">{fetchMs}ms</span>}
          </div>
        ) : source === "onchain" ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-emerald-400/60 bg-emerald-50 text-[11px] font-extrabold text-emerald-700 w-fit">
            <Wifi className="size-3" />
            GenLayer Studio · On-Chain
            {fetchMs !== null && <span className="ml-1 opacity-70">{fetchMs}ms</span>}
          </div>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Mochi Art Card ───────────────────────────────────────────────────────────

function MochiArtCard({ stage, blurred }: { stage: Stage; blurred: boolean }) {
  const stageImg = STAGE_IMAGES[stage.id];
  return (
    <div className="relative aspect-[4/3] sm:aspect-[16/9] rounded-2xl sm:rounded-3xl overflow-hidden border-[4px] border-[color:var(--primary-deep)] bg-secondary shadow-card-chunky">
      <motion.div
        key={stage.id}
        initial={{ filter: "blur(56px) saturate(0.6)", scale: 1.04 }}
        animate={{
          filter: blurred ? "blur(56px) saturate(0.6)" : "blur(0px) saturate(1)",
          scale: blurred ? 1.04 : 1,
        }}
        transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        className="absolute inset-0 grid place-items-center"
      >
        {stageImg ? (
          <img
            src={stageImg}
            alt={`${stage.name} mascot`}
            className="h-[88%] w-auto object-contain drop-shadow-[0_30px_60px_rgba(0,0,0,0.45)]"
          />
        ) : (
          <div
            className="h-[55%] w-[42%] rounded-[50%]"
            style={{
              background: `radial-gradient(circle at 35% 35%, ${stage.options[0].hex}, ${stage.options[1].hex})`,
              boxShadow: `0 30px 80px -20px ${stage.options[0].hex}80`,
            }}
          />
        )}
      </motion.div>
      {blurred && (
        <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-accent to-transparent animate-scan z-20 shadow-glow" />
      )}
      <div className="absolute top-2 left-2 sm:top-3 sm:left-3 text-[9px] sm:text-[10px] uppercase tracking-[0.25em] text-primary-foreground font-extrabold flex items-center gap-1.5 z-20 px-2 py-1 rounded-full bg-primary border-2 border-[color:var(--primary-deep)]">
        <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground animate-pulse" />
        Stage {String(stage.id).padStart(2, "0")}
      </div>
      <div className="absolute bottom-2 right-2 sm:bottom-3 sm:right-3 text-[9px] sm:text-[10px] uppercase tracking-[0.25em] text-primary-foreground font-extrabold z-20 px-2 py-1 rounded-full bg-primary border-2 border-[color:var(--primary-deep)]">
        {"●".repeat(stage.difficulty)}{"○".repeat(5 - stage.difficulty)}
      </div>
    </div>
  );
}

// ─── Validator Panel ──────────────────────────────────────────────────────────

function ValidatorPanel({
  phase, picks, correct, result, playerPicks, fetchMs, source, quote, consensusElapsed, txHash,
}: {
  phase: Phase;
  picks: [string, string] | null;
  correct: [string, string];
  result: RoundResult | null;
  playerPicks: string[];
  fetchMs: number | null;
  source: "onchain" | "local-consensus" | null;
  quote?: string;
  consensusElapsed: number;
  txHash: string | null;
}) {
  return (
    <div className="rounded-2xl sm:rounded-3xl bg-card border-[3px] border-[color:var(--primary-deep)] shadow-card-chunky p-4 sm:p-5 lg:sticky lg:top-[88px]">
      <div className="flex items-center gap-2 mb-3 sm:mb-4">
        <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-primary border-2 border-[color:var(--primary-deep)] grid place-items-center shrink-0">
          <Brain className="size-4 sm:size-5 text-primary-foreground" strokeWidth={2.5} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-extrabold">Validator AI</div>
          <div className="text-[9px] sm:text-[10px] uppercase tracking-[0.2em] text-primary font-bold whitespace-nowrap">
            GenLayer Studio · On-Chain
          </div>
          {txHash && (
            <a
              href={`https://explorer-studio.genlayer.com/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 mt-0.5 text-[9px] text-accent font-bold hover:underline underline-offset-2 transition-colors truncate"
              title={txHash}
            >
              <ExternalLink className="size-2.5 shrink-0" />
              <span className="truncate">Tx: {txHash.slice(0, 10)}…{txHash.slice(-6)}</span>
            </a>
          )}
        </div>
      </div>

      <ValidatorFetchChip phase={phase} fetchMs={fetchMs} source={source} />

      <AnimatePresence mode="wait">
        {phase === "playing" && (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-sm text-muted-foreground">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="size-4 text-accent" />
              <span>Standing by…</span>
            </div>
            <p className="text-xs leading-relaxed">
              Lock in your two picks. The Validator will reason on-chain via GenLayer Studio and reveal its answer.
            </p>
          </motion.div>
        )}

        {phase === "revealing" && (
          <motion.div key="thinking" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-sm space-y-3">
            <div className="flex items-center gap-2 text-accent">
              <Zap className="size-4 animate-pulse shrink-0" />
              <span className="font-semibold">
                {picks === null ? "AI consensus in progress…" : "Consensus reached!"}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
              <div className="h-full w-1/2 bg-gradient-primary animate-scan" />
            </div>
            {picks === null && (
              <div className="rounded-xl border-2 border-accent/30 bg-accent/5 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-[10px] font-extrabold uppercase tracking-widest text-accent">
                  <span>GenLayer Studio · On-Chain</span>
                  <span className="tabular-nums">{String(Math.floor(consensusElapsed / 60)).padStart(2,"0")}:{String(consensusElapsed % 60).padStart(2,"0")}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  5 AI validators are independently reasoning and reaching consensus. This takes <span className="font-bold text-accent">1–2 minutes</span> on-chain.
                </p>
                <div className="flex gap-1 mt-1">
                  {[0,1,2,3,4].map((i) => (
                    <div
                      key={i}
                      className="h-1.5 flex-1 rounded-full bg-accent/40 animate-pulse"
                      style={{ animationDelay: `${i * 200}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {phase === "result" && picks && result && (
          <motion.div key="result" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <ResultBadge result={result} />
            <Row label="Your pick" colors={playerPicks} correct={correct} />
            <Row label="AI pick" colors={picks} correct={correct} />
            <Row label="Truth" colors={correct} correct={correct} highlight />
            {quote && (
              <p className="hidden lg:block text-xs italic text-muted-foreground pt-1 border-t border-[color:var(--primary-deep)]/20">
                "{quote}"
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Result Badge ─────────────────────────────────────────────────────────────

function ResultBadge({ result }: { result: RoundResult }) {
  const map: Record<RoundResult, { label: string; className: string }> = {
    "perfect-match": { label: "Perfect Match", className: "bg-accent text-accent-foreground" },
    "player-wins": { label: "You Win", className: "bg-primary text-primary-foreground" },
    "validator-wins": { label: "AI Wins", className: "bg-destructive text-destructive-foreground" },
    "shared-misread": { label: "Shared Misread", className: "bg-secondary text-secondary-foreground" },
  };
  const m = map[result];
  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 280, damping: 18 }}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-extrabold border-[3px] border-[color:var(--primary-deep)] shadow-chunky-sm ${m.className}`}
    >
      <Sparkles className="size-3" /> {m.label}
    </motion.div>
  );
}

// ─── Comparison Row ───────────────────────────────────────────────────────────

function Row({ label, colors, correct, highlight = false }: {
  label: string;
  colors: string[];
  correct: [string, string];
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-xl sm:rounded-2xl border-[3px] border-[color:var(--primary-deep)]/40 p-2.5 sm:p-3 ${highlight ? "bg-primary/10 border-[color:var(--primary-deep)]" : "bg-card"}`}>
      <div className="text-[9px] sm:text-[10px] uppercase tracking-[0.2em] text-primary font-extrabold mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {colors.length === 0 && <span className="text-xs text-muted-foreground">— timed out —</span>}
        {colors.map((c) => {
          const ok = correct.includes(c as never);
          return (
            <span key={c}
              className={`text-xs px-2 py-0.5 rounded-lg border-2 font-bold ${ok ? "border-[color:var(--primary-deep)] bg-secondary text-primary" : "border-destructive/60 text-foreground/80"}`}
            >
              {c}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── Endgame Screen ───────────────────────────────────────────────────────────

function EndgameScreen({
  playerScore, validatorScore, total, discordUsername, onRestart, onHome, onLeaderboard,
}: {
  playerScore: number;
  validatorScore: number;
  total: number;
  discordUsername: string;
  onRestart: () => void;
  onHome: () => void;
  onLeaderboard: () => void;
}) {
  const title = endgameTitle(playerScore, validatorScore, total);

  // Submit score once on mount
  useEffect(() => {
    if (discordUsername) {
      void submitScore(discordUsername, playerScore, total);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground grid place-items-center px-4 py-16 sm:py-20">
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 h-[400px] w-[400px] rounded-full bg-primary/30 blur-[160px]" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 30, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="max-w-md w-full text-center bg-card border-[3px] border-[color:var(--primary-deep)] rounded-3xl p-6 sm:p-10 shadow-card-chunky"
      >
        <div className="mx-auto h-16 w-16 sm:h-20 sm:w-20 rounded-2xl bg-primary border-[3px] border-[color:var(--primary-deep)] grid place-items-center shadow-chunky-sm mb-5 sm:mb-6">
          <Trophy className="size-8 sm:size-10 text-primary-foreground" strokeWidth={2.5} />
        </div>
        <div className="text-[10px] uppercase tracking-[0.3em] text-primary font-extrabold mb-2">Endgame</div>
        <h1 className="text-3xl sm:text-5xl font-black tracking-tight mb-3 sm:mb-4">
          <span className="text-gradient">{title}</span>
        </h1>
        <p className="text-foreground/90 italic mb-6 sm:mb-8 text-sm sm:text-base">
          "My true colors were always Purple and White."
        </p>

        <div className="grid grid-cols-2 gap-3 mb-6 sm:mb-8">
          {[
            { label: "You", value: playerScore },
            { label: "Validator AI", value: validatorScore },
          ].map((s) => (
            <div key={s.label} className="rounded-2xl border-[3px] border-[color:var(--primary-deep)] p-4 sm:p-5 bg-secondary shadow-chunky-sm">
              <div className="text-[9px] sm:text-[10px] uppercase tracking-[0.2em] text-primary font-extrabold mb-1">{s.label}</div>
              <div className="text-3xl sm:text-4xl font-black tabular-nums text-primary">{s.value}</div>
              <div className="text-xs text-muted-foreground font-bold">of {total}</div>
            </div>
          ))}
        </div>

        {discordUsername && (
          <div className="mb-4 sm:mb-6 rounded-xl border-2 border-[color:var(--primary-deep)]/30 bg-secondary px-4 py-2.5 text-xs text-center text-muted-foreground">
            Score submitted to leaderboard as <span className="font-extrabold text-primary">{discordUsername}</span>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Button variant="hero" size="lg" className="rounded-full w-full" onClick={onLeaderboard}>
            <Trophy className="size-4" /> View Leaderboard
          </Button>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button variant="glass" size="lg" className="rounded-full w-full sm:w-auto flex-1" onClick={onRestart}>
              <RotateCcw className="size-4" /> Play Again
            </Button>
            <Button variant="glass" size="lg" className="rounded-full w-full sm:w-auto flex-1" onClick={onHome}>
              Home
            </Button>
          </div>
        </div>
      </motion.div>
    </main>
  );
}

// ─── Discord Username Modal ────────────────────────────────────────────────────

function DiscordModal({ onConfirm }: { onConfirm: (username: string) => void }) {
  const [value, setValue] = useState(localStorage.getItem("mochimind_discord") ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    localStorage.setItem("mochimind_discord", trimmed);
    onConfirm(trimmed);
  }

  return (
    <div className="fixed inset-0 z-[300] bg-background/80 backdrop-blur-xl flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="w-full max-w-sm bg-card border-[3px] border-[color:var(--primary-deep)] rounded-3xl p-6 sm:p-8 shadow-card-chunky"
      >
        <div className="text-center mb-6">
          <div className="mx-auto h-14 w-14 rounded-2xl bg-primary border-[3px] border-[color:var(--primary-deep)] grid place-items-center shadow-chunky-sm mb-4">
            <img src={logo} alt="MochiMind" className="h-8 w-8 rounded-lg object-cover" />
          </div>
          <h2 className="text-xl sm:text-2xl font-black tracking-tight mb-1">Ready to play?</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Enter your Discord username to appear on the <span className="font-bold text-primary">global leaderboard</span> after completing all 20 stages.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. RitaCryptoTips"
            maxLength={32}
            autoFocus
            className="w-full rounded-xl border-[3px] border-[color:var(--primary-deep)]/40 bg-secondary px-4 py-3 text-sm font-bold placeholder:font-normal placeholder:text-muted-foreground focus:outline-none focus:border-[color:var(--primary-deep)] transition-colors"
          />
          <Button
            type="submit"
            variant="hero"
            className="w-full rounded-full"
            disabled={!value.trim()}
          >
            <Play className="size-4" /> Start Game
          </Button>
          <button
            type="button"
            onClick={() => onConfirm("Anonymous")}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
          >
            Skip — play without leaderboard
          </button>
        </form>
      </motion.div>
    </div>
  );
}
