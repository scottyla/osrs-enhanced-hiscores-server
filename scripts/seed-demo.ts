// Posts made-up characters to a running *development* server so every board has something to show.
// Usage: node scripts/seed-demo.ts <baseUrl>   (your local server's address)
import { randomUUID } from 'node:crypto';
import { SKILLS } from '../src/boards.ts';

const base = process.argv[2];
if (!base) {
  console.error('Usage: node scripts/seed-demo.ts <baseUrl of a local development server>');
  process.exit(1);
}
if (base.includes('osrsenhancedhiscores.com') || base.includes('railway.app')) {
  console.error('Refusing to put fake players on the live hiscores.');
  process.exit(1);
}

const ITEMS: Record<number, { name: string; gePrice: number; haPrice: number }> = {
  995: { name: 'Coins', gePrice: 1, haPrice: 0 },
  4151: { name: 'Abyssal whip', gePrice: 1_450_000, haPrice: 72_000 },
  11286: { name: 'Draconic visage', gePrice: 3_900_000, haPrice: 30_000 },
  1753: { name: 'Green dragonhide', gePrice: 1_500, haPrice: 0 },
  536: { name: 'Dragon bones', gePrice: 2_300, haPrice: 0 },
  22006: { name: 'Skeletal visage', gePrice: 21_000_000, haPrice: 30_000 },
  13265: { name: 'Abyssal dagger', gePrice: 1_100_000, haPrice: 70_000 },
  11832: { name: 'Bandos chestplate', gePrice: 17_500_000, haPrice: 159_000 },
  11834: { name: 'Bandos tassets', gePrice: 24_000_000, haPrice: 159_000 },
  21034: { name: 'Dexterous prayer scroll', gePrice: 30_000_000, haPrice: 0 },
  12073: { name: 'Clue scroll (elite)', gePrice: 0, haPrice: 0 },
};

/** [quest id, name, typical minutes]. Ids are illustrative. */
const QUESTS: [number, string, number][] = [
  [1, "Cook's Assistant", 5], [2, 'Dragon Slayer I', 45], [3, 'Monkey Madness I', 90], [4, 'Desert Treasure I', 120],
  [5, 'Recipe for Disaster', 300], [6, 'Song of the Elves', 240], [7, 'Dragon Slayer II', 180], [8, 'Lunar Diplomacy', 75],
  [9, 'Fremennik Trials', 50], [10, 'Waterfall Quest', 15], [11, 'Priest in Peril', 20], [12, 'Lost City', 25],
];

// Deterministic pseudo-random so reseeding gives the same boards.
let seed = 42;
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const between = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo));

/** XP needed for a level (the in-game formula). */
function xpFor(level: number) {
  let points = 0;
  for (let l = 1; l < level; l++) points += Math.floor(l + 300 * 2 ** (l / 7));
  return Math.floor(points / 4);
}

const FIRST = ['Iron', 'Lord', 'Zulrah', 'Big', 'Tiny', 'Mr', 'Sir', 'Bank', 'Cow', 'Gnome', 'Elvarg', 'Dharok', 'Rune', 'Pker', 'Clue'];
const LAST = ['Slayer', 'Hunter', 'Fisher', 'Btw', 'Main', 'Scaper', 'Grinder', 'Wizard', 'Chef', 'King', 'Larry', 'Hc', 'Andy'];

type Kind = { accountType: number; gameMode: string; profileType: string; scale: number; build?: 'skiller' | 'pure' };
const KINDS: [Kind, number][] = [
  [{ accountType: 0, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 1 }, 18],
  [{ accountType: 1, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.8 }, 8],
  [{ accountType: 2, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.6 }, 4],
  [{ accountType: 3, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.7 }, 5],
  [{ accountType: 4, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.7 }, 4],
  [{ accountType: 5, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.6 }, 3],
  [{ accountType: 0, gameMode: 'HARDCORE_MAIN', profileType: 'STANDARD', scale: 0.35 }, 8],
  [{ accountType: 0, gameMode: 'FRESH_START_WORLD', profileType: 'STANDARD', scale: 0.3 }, 3],
  [{ accountType: 0, gameMode: 'SEASONAL', profileType: 'DEMONIC_PACTS_LEAGUE', scale: 0.5 }, 6],
  [{ accountType: 0, gameMode: 'DEADMAN', profileType: 'DEADMAN', scale: 0.4 }, 3],
  [{ accountType: 0, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.4, build: 'skiller' }, 3],
  [{ accountType: 0, gameMode: 'NORMAL', profileType: 'STANDARD', scale: 0.6, build: 'pure' }, 4],
];

const used = new Set<string>();
function makeName() {
  for (;;) {
    const n = `${FIRST[between(0, FIRST.length)]} ${LAST[between(0, LAST.length)]}`.slice(0, 12);
    if (!used.has(n)) { used.add(n); return n; }
  }
}

let hash = 9_000_000;
let sent = 0;
for (const [kind, count] of KINDS) {
  for (let i = 0; i < count; i++) {
    const s = kind.scale * (0.5 + rand());
    const skills: Record<string, [number, number]> = {};
    for (const skill of SKILLS) {
      let level = Math.min(99, Math.max(1, Math.round(between(40, 100) * Math.min(1, s + 0.3))));
      if (skill === 'HITPOINTS') level = Math.max(level, 10);
      if (kind.build === 'skiller' && ['ATTACK', 'STRENGTH', 'DEFENCE', 'RANGED', 'MAGIC', 'PRAYER'].includes(skill)) level = 1;
      if (kind.build === 'skiller' && skill === 'HITPOINTS') level = 10;
      if (kind.build === 'pure' && skill === 'DEFENCE') level = 1;
      const xp = level === 99 ? xpFor(99) + between(0, 30_000_000 * s) : xpFor(level) + between(0, xpFor(level + 1) - xpFor(level));
      skills[skill] = [level, xp];
    }
    const combat = kind.build === 'skiller' ? 3 : Math.min(126, Math.round(40 + 86 * Math.min(1, s)));
    const kills = (n: number) => Math.max(1, Math.round(n * s * (0.5 + rand())));
    const vork = kills(500);
    const demons = kills(3000);
    const bandos = kills(200);
    const cox = kills(60);
    const body = {
      accountHash: String(hash++), username: makeName(), accountType: kind.accountType,
      profileType: kind.profileType, gameMode: kind.gameMode,
      stats: {
        skills, combatLevel: combat,
        questPoints: between(50, 300 * Math.min(1, s + 0.2)),
        collectionLogObtained: between(100, 1500 * Math.min(1, s)), collectionLogTotal: 1_699,
        collectionLogCategories: { Bosses: [between(50, 600 * Math.min(1, s)), 700], Raids: [between(5, 140 * Math.min(1, s)), 150], Clues: [between(20, 450 * Math.min(1, s)), 500], Minigames: [between(10, 190 * Math.min(1, s)), 200], Other: [between(10, 140 * Math.min(1, s)), 149] },
        playtimeMinutes: rand() < 0.8 ? 60 * between(200, 9000 * s) : undefined,
        diaries: Object.fromEntries(['Ardougne', 'Desert', 'Falador', 'Fremennik', 'Kandarin', 'Karamja', 'Kourend & Kebos',
          'Lumbridge & Draynor', 'Morytania', 'Varrock', 'Western Provinces', 'Wilderness']
          .map((r) => [r, [0.9, 0.7, 0.45, 0.15].map((p) => (rand() < p * Math.min(1, s + 0.3) ? 1 : 0))])),
        combatAchievementPoints: between(0, 2500 * Math.min(1, s)),
        combatAchievementTasks: between(0, 550 * Math.min(1, s)),
        slayerPoints: between(0, 8000 * s),
        slayerStreak: between(0, 1500 * s),
      },
      killCounts: [
        { name: 'vorkath', kc: vork, pb: 60 + between(0, 120) + (rand() < 0.5 ? 0.6 : 0) },
        { name: 'zulrah', kc: kills(400), pb: 55 + between(0, 90) + 0.2 },
        { name: 'general graardor', kc: bandos },
        { name: 'chambers of xeric', kc: cox, pb: 900 + between(0, 1500) + 0.4 },
        { name: 'clue scrolls (elite)', kc: kills(80) },
        { name: 'clue scrolls (hard)', kc: kills(200) },
      ],
      levelUps: [{ skill: SKILLS[between(0, SKILLS.length)], level: between(70, 99), at: Date.now() - between(1, 600) * 60_000 }],
      items: ITEMS,
      lootSources: [
        { type: 'NPC', name: 'Vorkath', kills: vork, first: Date.now() - 9e9, last: Date.now(), drops: [995, 40_000 * vork, 536, 2 * vork, 1753, vork, 11286, Math.ceil(vork / 5000) + (rand() < 0.5 ? 1 : 0) || 1, 22006, 1] },
        { type: 'NPC', name: 'Abyssal demon', kills: demons, first: Date.now() - 9e9, last: Date.now(), drops: [995, 1500 * demons, 4151, Math.ceil(demons / 512), 13265, Math.ceil(demons / 2000)] },
        { type: 'NPC', name: 'General Graardor', kills: bandos, first: Date.now() - 9e9, last: Date.now(), drops: [995, 20_000 * bandos, 11832, Math.ceil(bandos / 381), 11834, Math.ceil(bandos / 381)] },
        { type: 'EVENT', name: 'Chambers of Xeric', kills: cox, first: Date.now() - 9e9, last: Date.now(), drops: [995, 500_000 * cox, 21034, Math.ceil(cox / 34)] },
        { type: 'EVENT', name: 'Clue Scroll (Elite)', kills: kills(80), first: Date.now() - 9e9, last: Date.now(), drops: [995, 1_000_000 * kills(10)] },
      ],
      drops: [
        { id: randomUUID(), type: 'NPC', name: 'Vorkath', combatLevel: 732, amount: 1, timestamp: Date.now() - between(1, 600) * 60_000, world: 330, items: [[995, 41_000], [536, 2], [11286, 1]] },
        { id: randomUUID(), type: 'NPC', name: 'Abyssal demon', combatLevel: 124, amount: 1, timestamp: Date.now() - between(600, 3000) * 60_000, world: 330, items: [[4151, 1]] },
        { id: randomUUID(), type: 'EVENT', name: 'Chambers of Xeric', combatLevel: -1, amount: 1, timestamp: Date.now() - between(3000, 20000) * 60_000, world: 302, items: [[21034, 1]] },
      ],
      collectionLogItems: [[4151, Math.ceil(demons / 512)], [11286, 1], [22006, 1], [13265, 1], [11832, 1], [21034, 1]],
      quests: QUESTS.map(([id, name, mins], qi) => {
        const r = rand();
        const state = r < 0.65 * Math.min(1, s + 0.3) ? 'FINISHED' : r < 0.8 ? 'IN_PROGRESS' : 'NOT_STARTED';
        // About a third of finished quests were timed by the plugin.
        const timed = state === 'FINISHED' && rand() < 0.35;
        const played = Math.round(mins * 60_000 * (0.6 + rand()));
        const completedAt = Date.now() - between(1, 60) * 86_400_000 - qi * 1000;
        return timed
          ? { id, name, state, startedAt: completedAt - played * 3, completedAt, elapsedMs: played * 3, playedMs: played }
          : { id, name, state };
      }),
    };
    const res = await fetch(`${base}/api/v1/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status !== 200) console.error(body.username, res.status, await res.text());
    else sent++;
  }
}
console.log(`Seeded ${sent} characters into ${base}`);
