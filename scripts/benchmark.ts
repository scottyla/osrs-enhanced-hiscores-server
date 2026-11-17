// Load-tests the database layer with N synthetic players and times the hot paths.
// Usage: node scripts/benchmark.ts [players=10000] [dbPath=bench.db]
// Uses the real ingest/query code against a scratch SQLite file (deleted first).
import { rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.ts';
import { createIngest } from '../src/ingest.ts';
import { createQueries } from '../src/queries.ts';
import { SKILLS } from '../src/boards.ts';

const N = Number(process.argv[2] ?? 10_000);
const path = process.argv[3] ?? 'bench.db';
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });

const db = openDatabase(path);
const ingest = createIngest(db);
const q = createQueries(db);

let seed = 7;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const between = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo));

const ITEMS: Record<number, { name: string; gePrice: number; haPrice: number }> = {};
for (let id = 1; id <= 400; id++) ITEMS[id] = { name: `Item ${id}`, gePrice: between(1, 5_000_000), haPrice: 0 };
const SOURCES = Array.from({ length: 150 }, (_, i) => `Boss ${i}`);
const QUESTS = Array.from({ length: 216 }, (_, i) => [i + 1, `Quest ${i + 1}`] as const);

function stats() {
  return {
    skills: Object.fromEntries(SKILLS.map((s) => { const l = between(30, 99); return [s, [l, l * l * 1000 + between(0, 9999)]]; })),
    combatLevel: between(3, 126), questPoints: between(0, 300), collectionLogObtained: between(0, 1600), collectionLogTotal: 1699,
    playtimeMinutes: between(1000, 500_000), combatAchievementPoints: between(0, 2500), combatAchievementTasks: between(0, 600),
    slayerPoints: between(0, 5000), slayerStreak: between(0, 1000), diaries: { Ardougne: [1, 1, 0, 0], Varrock: [1, 0, 0, 0] },
  };
}

function firstLogin(i: number) {
  const sources = Array.from({ length: between(20, 60) }, () => SOURCES[between(0, SOURCES.length)]);
  return {
    accountHash: String(1_000_000 + i), username: `Player ${i}`.slice(0, 12), accountType: rand() < 0.2 ? 1 : 0,
    profileType: 'STANDARD', gameMode: rand() < 0.05 ? 'HARDCORE_MAIN' : 'NORMAL',
    stats: stats(), items: ITEMS,
    lootSources: [...new Set(sources)].map((name) => ({
      type: 'NPC', name, kills: between(1, 3000),
      drops: Array.from({ length: between(4, 14) }, () => [between(1, 400), between(1, 1000)]).flat(),
    })),
    drops: [], collectionLogItems: Array.from({ length: 40 }, () => [between(1, 400), 1] as [number, number]),
    quests: QUESTS.map(([id, name]) => ({ id, name, state: rand() < 0.6 ? 'FINISHED' : 'NOT_STARTED' })),
    killCounts: SOURCES.slice(0, 20).map((n) => ({ name: n.toLowerCase(), kc: between(1, 2000), pb: rand() < 0.3 ? between(30, 600) : null })),
    levelUps: [],
  };
}

const time = <T>(label: string, fn: () => T, runs = 1): T => {
  let out!: T;
  const t = performance.now();
  for (let i = 0; i < runs; i++) out = fn();
  const ms = (performance.now() - t) / runs;
  console.log(`${label.padEnd(52)} ${ms.toFixed(ms < 10 ? 2 : 0).padStart(8)} ms${runs > 1 ? ` (avg of ${runs})` : ''}`);
  return out;
};

// 1. First login for every player: full history (the heaviest write)
const tokens: string[] = [];
let t0 = performance.now();
for (let i = 0; i < N; i++) {
  const r = ingest(firstLogin(i) as never, undefined);
  tokens.push(r.token!);
}
let elapsed = performance.now() - t0;
console.log(`\n${N} players, first-login sync (full loot history + 216 quests): ${(elapsed / N).toFixed(2)} ms each, ${(N / (elapsed / 1000)).toFixed(0)}/s`);

// 2. Steady state: what a player online sends every 30 s (stats + a couple of drops)
const M = Math.min(N, 5000);
t0 = performance.now();
for (let i = 0; i < M; i++) {
  ingest({
    accountHash: String(1_000_000 + i), username: `Player ${i}`.slice(0, 12), accountType: 0, profileType: 'STANDARD', gameMode: 'NORMAL',
    stats: stats(), items: { 1: ITEMS[1], 2: ITEMS[2] }, lootSources: [], collectionLogItems: [], quests: [], killCounts: [], levelUps: [],
    drops: [{ id: randomUUID(), type: 'NPC', name: 'Boss 1', combatLevel: 100, amount: 1, timestamp: Date.now(), world: 301, items: [[1, 1], [2, 5]] }],
  } as never, tokens[i]);
}
elapsed = performance.now() - t0;
const perSec = M / (elapsed / 1000);
console.log(`steady-state 30 s update: ${(elapsed / M).toFixed(2)} ms each -> ${perSec.toFixed(0)}/s, i.e. ~${Math.round(perSec * 30).toLocaleString()} players online at once\n`);

// 3. Reads
const mid = `Player ${Math.floor(N / 2)}`.slice(0, 12);
time('leaderboard: Normal overall, page 1', () => q.hiscores('normal', undefined, { kind: 'overall' }, 0), 20);
time('leaderboard: Normal overall, page 200', () => q.hiscores('normal', undefined, { kind: 'overall' }, 200), 5);
time('leaderboard: Ironman, Attack XP, page 1', () => q.hiscores('ironman', undefined, { kind: 'skill', skill: 'ATTACK' }, 0), 20);
time('leaderboard: loot value, page 1', () => q.hiscores('normal', undefined, { kind: 'stat', stat: 'loot_value' }, 0), 20);
time('leaderboard: boss kills (one source), page 1', () => q.hiscores('normal', undefined, { kind: 'source', type: 'NPC', name: 'Boss 3', metric: 'kills' }, 0), 20);
time('leaderboard: boss KC (Chat Commands), page 1', () => q.hiscores('normal', undefined, { kind: 'kc', name: 'boss 3', metric: 'kc' }, 0), 20);
time('leaderboard: XP gained this week, page 1', () => q.hiscores('normal', undefined, { kind: 'gains', period: 'week', skill: 'overall' }, 0), 5);
time('player page (profile + every rank)', () => q.player(mid, 'normal'), 5);
time('player kill counts with ranks', () => q.killCounts(mid, 'normal'), 5);
time('player progress (gains, history)', () => q.progress(mid, 'normal'), 20);
time('sidebar: bosses on board', () => q.sources('normal'), 5);
time('name search', () => q.search('player 12'), 20);

db.pragma('wal_checkpoint(TRUNCATE)');
const size = statSync(path).size;
console.log(`\ndatabase size: ${(size / 1e6).toFixed(0)} MB for ${N} players (${(size / N / 1e3).toFixed(0)} KB each)`);
db.close();
