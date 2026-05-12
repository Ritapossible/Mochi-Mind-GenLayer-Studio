import { createFileRoute } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import mochi from "@/assets/mochi.png";
import logo from "@/assets/logo.jpg";
import { Eye, Sparkles, Brain, Zap, ArrowRight, Play, Trophy } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } },
};

function Section({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.section
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2 }}
      variants={fadeUp}
      className={`relative bg-background py-28 px-6 text-foreground ${className}`}
    >
      {children}
    </motion.section>
  );
}

function Index() {
  const steps = [
    { icon: Eye, title: "Observe", text: "A blurred Mochi skin appears, hiding its true identity." },
    { icon: Brain, title: "Predict", text: "Choose 2 dominant colors from 4 deceptive options." },
    { icon: Sparkles, title: "Compete", text: "Validator AI analyzes Mochi in parallel with you." },
    { icon: Zap, title: "Reveal", text: "The blur fades. Truth is shown. Score is settled." },
  ];

  return (
    <main className="min-h-screen bg-background text-foreground overflow-x-hidden">
      {/* NAV */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-background/90 backdrop-blur-xl border-b-[3px] border-[color:var(--primary-deep)]/30">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2">
            <img src={logo} alt="MochiMind logo" className="h-9 w-9 rounded-lg object-cover shadow-glow" />
            <span className="font-bold tracking-tight text-lg">MochiMind</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#how" className="hover:text-foreground transition">How it works</a>
            <a href="#genlayer" className="hover:text-foreground transition">GenLayer</a>
            <Link to="/leaderboard" className="hover:text-foreground transition flex items-center gap-1.5">
              <Trophy className="size-3.5" /> Leaderboard
            </Link>
          </div>
          <Button variant="hero" size="sm" className="rounded-full px-5" asChild>
            <Link to="/play">Play Now</Link>
          </Button>
        </div>
      </nav>

      {/* HERO */}
      <section className="relative bg-background pt-40 pb-32 px-6 text-foreground">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-primary/30 blur-[120px]" />
          <div className="absolute bottom-0 right-1/4 h-96 w-96 rounded-full bg-accent/20 blur-[140px]" />
        </div>

        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <motion.div initial="hidden" animate="show" variants={fadeUp}>
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-card border-[3px] border-[color:var(--primary-deep)] shadow-chunky-sm text-xs uppercase tracking-[0.2em] text-primary font-bold mb-8">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
              GenLayer-inspired · Human vs AI
            </div>
            <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight leading-[0.95] mb-6">
              Mochi<span className="text-gradient">Mind</span>
            </h1>
            <p className="text-lg sm:text-xl md:text-2xl text-foreground/90 mb-4 font-light">
              Can you recognize Mochi's true colors better than Validator AI?
            </p>
            <p className="text-base text-muted-foreground max-w-xl mb-10 leading-relaxed">
              A fast-paced visual reasoning game. Across 20 evolving stages, you and Validator AI race to read Mochi's identity through the blur. <span className="text-foreground/80">Blur → Predict → Reveal.</span>
            </p>
            <div className="flex flex-wrap gap-4">
              <Button variant="hero" size="xl" className="rounded-full" asChild>
                <Link to="/play"><Play className="size-5" /> Play Now</Link>
              </Button>
              <Button variant="glass" size="xl" className="rounded-full" asChild>
                <a href="#how">How It Works <ArrowRight className="size-5" /></a>
              </Button>
            </div>
          </motion.div>

          {/* Mascot card */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="relative"
          >
            <div className="relative mx-auto max-w-md aspect-square">
              <div className="absolute inset-0 rounded-[2.5rem] bg-gradient-primary opacity-30 blur-3xl animate-pulse-glow" />
              <div className="relative h-full rounded-[2.5rem] bg-card border-[4px] border-[color:var(--primary-deep)] shadow-card-chunky overflow-hidden">
                <div className="absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-primary to-transparent animate-scan z-20 shadow-glow" />
                <div className="absolute top-4 left-4 z-20 text-[10px] uppercase tracking-[0.3em] text-primary font-bold flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                  Validator AI scanning…
                </div>
                <div className="absolute bottom-4 right-4 z-20 text-[10px] uppercase tracking-[0.3em] text-primary/70 font-bold">
                  Stage 01 / 20
                </div>
                <img
                  src={mochi}
                  alt="Mochi mascot — futuristic cat astronaut in purple and white"
                  className="absolute inset-0 w-full h-full object-contain p-10 animate-float"
                />
              </div>
              <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 px-5 py-2 rounded-full bg-card border-[3px] border-[color:var(--primary-deep)] shadow-chunky-sm text-xs tracking-widest uppercase text-primary font-bold">
                20 Stages of Evolution
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* CHALLENGE */}
      <Section>
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Human Intuition <span className="text-gradient">vs</span> Validator AI
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-16 leading-relaxed">
            Every Mochi evolves. Colors shift. Patterns deceive. Forms transform.
            But one question remains — can you identify Mochi's dominant identity before AI does?
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              ["Choose", "Pick 2 of 4 dominant colors."],
              ["Compete", "Outscore Validator AI."],
              ["Ascend", "Advance through 20 stages."],
            ].map(([t, d]) => (
              <div key={t} className="bg-card border-[3px] border-[color:var(--primary-deep)] rounded-3xl p-8 text-left shadow-card-chunky transition-all duration-200 hover:-translate-y-1">
                <div className="text-xs uppercase tracking-[0.25em] text-primary font-extrabold mb-3">{t}</div>
                <p className="text-foreground/90 font-medium">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* HOW IT WORKS */}
      <Section className="bg-background">
        <div className="max-w-7xl mx-auto" id="how">
          <div className="text-center mb-20">
            <div className="text-xs uppercase tracking-[0.3em] text-primary font-extrabold mb-4">The Loop</div>
            <h2 className="text-4xl md:text-6xl font-black tracking-tight">How MochiMind Works</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {steps.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.6 }}
                className="group relative bg-card border-[3px] border-[color:var(--primary-deep)] rounded-3xl p-8 shadow-card-chunky transition-all duration-300 hover:-translate-y-2"
              >
                <div className="text-7xl font-black text-primary/15 absolute top-4 right-5">0{i+1}</div>
                <s.icon className="size-9 text-primary mb-6" strokeWidth={2.5} />
                <h3 className="text-xl font-extrabold mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.text}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </Section>

      {/* GENLAYER */}
      <Section>
        <div className="max-w-4xl mx-auto text-center" id="genlayer">
          <div className="text-xs uppercase tracking-[0.3em] text-primary font-extrabold mb-4">Built for Intelligent Play</div>
          <h2 className="text-4xl md:text-5xl font-black tracking-tight mb-8">A battle of perception.</h2>
          <p className="text-lg text-muted-foreground leading-relaxed mb-10">
            MochiMind is inspired by GenLayer's vision of intelligent systems and subjective reasoning.
            Validator AI doesn't just guess — <span className="text-foreground font-bold">it interprets</span>. So do you.
          </p>
          <div className="inline-flex items-center gap-6 px-8 py-5 rounded-full bg-card border-[3px] border-[color:var(--primary-deep)] shadow-chunky-sm">
            <span className="font-extrabold">Human Judgment</span>
            <span className="text-primary font-black">vs</span>
            <span className="font-extrabold">Machine Analysis</span>
          </div>
        </div>
      </Section>

      {/* ENDGAME TEASER */}
      <Section className="bg-background">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">Do You Remember Mochi?</h2>
          <p className="text-lg text-muted-foreground mb-12">By Stage 20, one final question awaits:<br/>
          <span className="text-foreground italic">Did you truly understand Mochi… or did Validator AI see deeper?</span></p>
          <div className="relative mx-auto w-64 h-64">
            <div className="absolute inset-0 rounded-full bg-gradient-primary blur-3xl opacity-50" />
            <img src={mochi} alt="Mochi silhouette" className="relative h-full w-full object-contain animate-blur-reveal" style={{ filter: "blur(20px) brightness(0.7)" }} />
          </div>
        </div>
      </Section>

      {/* FINAL CTA */}
      <section className="relative bg-background py-32 px-6 text-center text-foreground overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-gradient-primary opacity-20 blur-3xl" />
        <h2 className="text-5xl md:text-7xl font-black tracking-tight mb-8">
          The blur is <span className="text-gradient">waiting.</span>
        </h2>
        <Button variant="hero" size="xl" className="rounded-full px-12" asChild>
          <Link to="/play"><Play className="size-5" /> Play Now</Link>
        </Button>
        <p className="mt-10 text-muted-foreground italic">No matter how Mochi changes… true colors remain.</p>
      </section>

      {/* FOOTER */}
      <footer className="bg-background border-t-[3px] border-[color:var(--primary-deep)]/20 py-10 px-6 text-foreground">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <img src={logo} alt="MochiMind logo" className="h-6 w-6 rounded-md object-cover" />
            <span className="font-bold text-foreground">MochiMind</span>
          </div>
          <p className="text-center">A GenLayer-inspired Human vs AI visual reasoning experience.</p>
          <p>
            Built with <span aria-label="purple heart">💜</span> by{" "}
            <a
              href="https://x.com/RitaCryptoTips"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-primary hover:underline underline-offset-2 transition-colors hover:text-primary/80"
            >
              RitaCryptoTips
            </a>
          </p>
        </div>
      </footer>
    </main>
  );
}
