import { Router, type IRouter } from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const STORE_PATH = join(process.cwd(), "leaderboard.json");

type Entry = {
  username: string;
  score: number;
  total: number;
  date: string;
};

function readEntries(): Entry[] {
  try {
    if (!existsSync(STORE_PATH)) return [];
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Entry[];
  } catch {
    return [];
  }
}

function writeEntries(entries: Entry[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

const router: IRouter = Router();

router.get("/leaderboard", (_req, res) => {
  const entries = readEntries();
  const sorted = entries
    .sort((a, b) => b.score - a.score || new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);
  res.json(sorted);
});

router.post("/leaderboard", (req, res) => {
  const { username, score, total } = req.body as Record<string, unknown>;

  if (
    typeof username !== "string" ||
    !username.trim() ||
    typeof score !== "number" ||
    typeof total !== "number"
  ) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const entries = readEntries();
  entries.push({
    username: username.trim().slice(0, 32),
    score,
    total,
    date: new Date().toISOString(),
  });
  writeEntries(entries);
  res.json({ ok: true });
});

export default router;
