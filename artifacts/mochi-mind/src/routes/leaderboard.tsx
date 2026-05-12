import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Trophy, ArrowLeft, Medal, Crown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import logo from "@/assets/logo.jpg";

export const Route = createFileRoute("/leaderboard")({
  component: LeaderboardPage,
});

type Entry = {
  username: string;
  score: number;
  total: number;
  date: string;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

async function fetchLeaderboard(): Promise<Entry[]> {
  const res = await fetch(`${API_BASE}/api/leaderboard`);
  if (!res.ok) throw new Error("Failed to fetch leaderboard");
  return res.json() as Promise<Entry[]>;
}

function RankIcon({ rank }: { rank: number }) {
  if (rank === 1) return <Crown className="size-5 text-yellow-400" strokeWidth={2.5} />;
  if (rank === 2) return <Medal className="size-5 text-slate-400" strokeWidth={2.5} />;
  if (rank === 3) return <Medal className="size-5 text-amber-600" strokeWidth={2.5} />;
  return (
    <span className="text-sm font-black tabular-nums text-muted-foreground w-5 text-center">
      {rank}
    </span>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function LeaderboardPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchLeaderboard()
      .then(setEntries)
      .catch(() => setError("Could not load leaderboard. Is the API server running?"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-40 bg-background/95 backdrop-blur-xl border-b-[3px] border-[color:var(--primary-deep)]/30">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <img src={logo} alt="MochiMind" className="h-8 w-8 rounded-lg object-cover ring-2 ring-[color:var(--primary-deep)]" />
            <span className="font-bold tracking-tight hidden sm:inline">MochiMind</span>
          </Link>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] font-extrabold text-primary">
            <Trophy className="size-4" /> Global Leaderboard
          </div>
          <Button variant="glass" size="sm" className="rounded-full gap-1.5" onClick={load} disabled={loading}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8 sm:mb-10"
        >
          <div className="mx-auto h-16 w-16 rounded-2xl bg-primary border-[3px] border-[color:var(--primary-deep)] grid place-items-center shadow-card-chunky mb-4">
            <Trophy className="size-8 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight mb-2">
            Global <span className="text-gradient">Leaderboard</span>
          </h1>
          <p className="text-muted-foreground text-sm sm:text-base">
            Top MochiMind players competing against Validator AI
          </p>
        </motion.div>

        {/* Content */}
        {loading && (
          <div className="flex justify-center py-16">
            <div className="h-10 w-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        {error && (
          <div className="rounded-2xl border-[3px] border-destructive/40 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive font-bold">{error}</p>
            <Button variant="glass" size="sm" className="mt-3 rounded-full" onClick={load}>Try again</Button>
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="rounded-2xl border-[3px] border-[color:var(--primary-deep)]/30 bg-card p-10 text-center shadow-card-chunky">
            <div className="text-4xl mb-3">🎮</div>
            <h3 className="font-extrabold text-lg mb-1">No scores yet</h3>
            <p className="text-sm text-muted-foreground mb-4">Be the first to complete all 20 stages!</p>
            <Button variant="hero" className="rounded-full" asChild>
              <Link to="/play">Play Now</Link>
            </Button>
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <div className="space-y-2 sm:space-y-3">
            {entries.map((entry, i) => {
              const rank = i + 1;
              const pct = Math.round((entry.score / entry.total) * 100);
              const isTop3 = rank <= 3;
              return (
                <motion.div
                  key={`${entry.username}-${entry.date}`}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.05, 0.5) }}
                  className={`flex items-center gap-3 sm:gap-4 rounded-2xl border-[3px] p-3 sm:p-4 shadow-chunky-sm transition-all
                    ${rank === 1 ? "border-yellow-400/60 bg-yellow-50/50 dark:bg-yellow-900/10" : ""}
                    ${rank === 2 ? "border-slate-400/60 bg-slate-50/50 dark:bg-slate-900/10" : ""}
                    ${rank === 3 ? "border-amber-600/60 bg-amber-50/50 dark:bg-amber-900/10" : ""}
                    ${!isTop3 ? "border-[color:var(--primary-deep)]/30 bg-card" : ""}`}
                >
                  {/* Rank */}
                  <div className="w-6 flex justify-center shrink-0">
                    <RankIcon rank={rank} />
                  </div>

                  {/* Avatar placeholder */}
                  <div className={`h-9 w-9 sm:h-10 sm:w-10 rounded-xl border-2 grid place-items-center text-sm font-black shrink-0
                    ${isTop3 ? "border-[color:var(--primary-deep)] bg-primary text-primary-foreground" : "border-[color:var(--primary-deep)]/40 bg-secondary text-primary"}`}
                  >
                    {entry.username.slice(0, 2).toUpperCase()}
                  </div>

                  {/* Name + date */}
                  <div className="flex-1 min-w-0">
                    <div className="font-extrabold truncate text-sm sm:text-base">{entry.username}</div>
                    <div className="text-[10px] sm:text-xs text-muted-foreground">{formatDate(entry.date)}</div>
                  </div>

                  {/* Score */}
                  <div className="text-right shrink-0">
                    <div className={`text-lg sm:text-xl font-black tabular-nums ${isTop3 ? "text-primary" : "text-foreground"}`}>
                      {entry.score}<span className="text-muted-foreground font-bold text-sm">/{entry.total}</span>
                    </div>
                    <div className="text-[10px] sm:text-xs font-bold text-muted-foreground">{pct}% accuracy</div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* CTA */}
        <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button variant="hero" size="lg" className="rounded-full w-full sm:w-auto" asChild>
            <Link to="/play">Play &amp; Climb the Board</Link>
          </Button>
          <Button variant="glass" size="lg" className="rounded-full w-full sm:w-auto" asChild>
            <Link to="/"><ArrowLeft className="size-4" /> Home</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
