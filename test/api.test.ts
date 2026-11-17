import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { SKILLS } from '../src/boards.ts';

const WHIP = 4151;
const COINS = 995;

/** Every skill at `level`/`xp`, with overrides. */
function skills(level: number, xp: number, overrides: Record<string, [number, number]> = {}) {
  return { ...Object.fromEntries(SKILLS.map((s) => [s, [level, xp]])), ...overrides };
}

let hashCounter = 1000;
function submission(overrides: Record<string, unknown> = {}) {
  return {
    accountHash: String(hashCounter++),
    username: 'Zezima',
    accountType: 0,
    profileType: 'STANDARD',
    gameMode: 'NORMAL',
    stats: {
      skills: skills(99, 13_034_431),
      combatLevel: 126,
      questPoints: 300,
      collectionLogObtained: 900,
      collectionLogTotal: 1600,
      collectionLogCategories: { Bosses: [400, 700] },
      playtimeMinutes: 60_000,
    },
    items: {
      [WHIP]: { name: 'Abyssal whip', gePrice: 1_500_000, haPrice: 72_000 },
      [COINS]: { name: 'Coins', gePrice: 1, haPrice: 0 },
    },
    lootSources: [{ type: 'NPC', name: 'Abyssal demon', kills: 1000, first: 1, last: 2, drops: [WHIP, 2, COINS, 500_000] }],
    drops: [{
      id: crypto.randomUUID(), type: 'NPC', name: 'Abyssal demon', combatLevel: 124,
      amount: 1, timestamp: Date.now(), world: 301, items: [[WHIP, 1]],
    }],
    collectionLogItems: [[WHIP, 2]],
    ...overrides,
  };
}

async function setup() {
  const db = openDatabase(':memory:');
  const app = await buildApp({ db, logger: false });
  const submit = (body: unknown, token?: string) => app.inject({
    method: 'POST', url: '/api/v1/submit', payload: body as object,
    headers: token ? { 'x-hiscores-token': token } : {},
  });
  const get = async (url: string) => {
    const res = await app.inject(url);
    return { status: res.statusCode, body: res.json() };
  };
  const names = async (url: string) => (await get(url)).body.rows.map((r: { username: string }) => r.username);
  return { app, db, submit, get, names };
}

test('first submission claims the character and later ones need the token', async () => {
  const { app, submit } = await setup();
  const body = submission();

  const first = await submit(body);
  assert.equal(first.statusCode, 200);
  const token = first.json().token as string;
  assert.ok(token);

  assert.equal((await submit(body)).statusCode, 403);
  assert.equal((await submit(body, 'wrong')).statusCode, 403);

  const again = await submit(body, token);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().token, undefined);

  // A league character on the same account is a separate profile with its own token.
  const league = await submit({ ...body, profileType: 'DEMONIC_PACTS_LEAGUE', gameMode: 'SEASONAL' });
  assert.equal(league.statusCode, 200);
  assert.ok(league.json().token);
  await app.close();
});

test('players land on the same boards as the official hiscores', async () => {
  const { app, submit, names } = await setup();
  const low = { skills: skills(50, 101_333), combatLevel: 80 };
  const players = [
    submission({ username: 'Main' }),
    submission({ username: 'Iron', accountType: 1, stats: low }),
    submission({ username: 'Uim', accountType: 2, stats: low }),
    submission({ username: 'Hcim', accountType: 3, stats: low }),
    submission({ username: 'Gim', accountType: 4, stats: low }),
    submission({ username: 'Hcgim', accountType: 5, stats: low }),
    submission({ username: 'Hc World', gameMode: 'HARDCORE_MAIN', stats: low }),
    submission({ username: 'Fresh', gameMode: 'FRESH_START_WORLD', stats: low }),
    submission({ username: 'Leaguer', profileType: 'DEMONIC_PACTS_LEAGUE', gameMode: 'SEASONAL', stats: low }),
    submission({ username: 'Dmm', profileType: 'DEADMAN', gameMode: 'DEADMAN', stats: low }),
    submission({ username: 'Skiller', stats: { skills: skills(1, 0, { HITPOINTS: [10, 1154], COOKING: [99, 13_034_431] }), combatLevel: 3 } }),
    submission({ username: 'Pure', stats: { skills: skills(60, 273_742, { DEFENCE: [1, 0] }), combatLevel: 70 } }),
  ];
  for (const p of players) assert.equal((await submit(p)).statusCode, 200);

  const board = async (id: string) => (await names(`/api/hiscores?board=${id}&category=overall`)).sort();
  assert.deepEqual(await board('normal'), ['Gim', 'Hcgim', 'Hcim', 'Iron', 'Main', 'Pure', 'Skiller', 'Uim']);
  assert.deepEqual(await board('ironman'), ['Hcim', 'Iron', 'Uim']);
  assert.deepEqual(await board('ultimate'), ['Uim']);
  assert.deepEqual(await board('hardcore_ironman'), ['Hcim']);
  assert.deepEqual(await board('group_ironman'), ['Gim', 'Hcgim']);
  assert.deepEqual(await board('hardcore_group_ironman'), ['Hcgim']);
  assert.deepEqual(await board('hardcore_worlds'), ['Hc World']);
  assert.deepEqual(await board('fresh_start'), ['Fresh']);
  assert.deepEqual(await board('leagues'), ['Leaguer']);
  assert.deepEqual(await board('deadman'), ['Dmm']);
  assert.deepEqual(await board('skiller'), ['Skiller']);
  assert.deepEqual(await board('one_defence'), ['Pure']);
  await app.close();
});

test('changing game mode moves a player between boards', async () => {
  const { app, submit, names } = await setup();
  const hcw = submission({ username: 'Brave', gameMode: 'HARDCORE_MAIN' });
  const hcwToken = (await submit(hcw)).json().token;
  const hcim = submission({ username: 'Careful', accountType: 3 });
  const hcimToken = (await submit(hcim)).json().token;

  assert.deepEqual(await names('/api/hiscores?board=hardcore_worlds'), ['Brave']);
  assert.deepEqual(await names('/api/hiscores?board=hardcore_ironman'), ['Careful']);

  // Hardcore Worlds character dies and transfers to the main game; HCIM dies and becomes a regular ironman.
  await submit({ ...hcw, gameMode: 'NORMAL' }, hcwToken);
  await submit({ ...hcim, accountType: 1 }, hcimToken);

  assert.deepEqual(await names('/api/hiscores?board=hardcore_worlds'), []);
  assert.deepEqual(await names('/api/hiscores?board=hardcore_ironman'), []);
  assert.deepEqual((await names('/api/hiscores?board=normal')).sort(), ['Brave', 'Careful']);
  assert.deepEqual(await names('/api/hiscores?board=ironman'), ['Careful']);
  await app.close();
});

test('leaderboards rank by the right measure', async () => {
  const { app, submit, get } = await setup();
  await submit(submission({ username: 'Maxed' }));
  await submit(submission({
    username: 'Cooker',
    stats: { skills: skills(70, 737_627, { COOKING: [99, 50_000_000] }), combatLevel: 90, questPoints: 310 },
    lootSources: [{ type: 'NPC', name: 'Vorkath', kills: 5, drops: [COINS, 100] }],
  }));

  const overall = (await get('/api/hiscores?category=overall')).body.rows;
  assert.deepEqual(overall.map((r: { username: string }) => r.username), ['Maxed', 'Cooker']);
  assert.equal(overall[0].level, 99 * SKILLS.length);

  const cooking = (await get('/api/hiscores?category=skill:COOKING')).body.rows;
  assert.deepEqual(cooking.map((r: { username: string; xp: number }) => [r.username, r.xp]), [['Cooker', 50_000_000], ['Maxed', 13_034_431]]);

  const qp = (await get('/api/hiscores?category=quest_points')).body.rows;
  assert.deepEqual(qp.map((r: { username: string }) => r.username), ['Cooker', 'Maxed']);

  const demons = (await get('/api/hiscores?category=source&type=NPC&name=Abyssal%20demon&metric=value')).body.rows;
  assert.deepEqual(demons.map((r: { username: string; value: number }) => [r.username, r.value]), [['Maxed', 3_500_000]]);

  assert.equal((await get('/api/hiscores?category=skill:NOT_A_SKILL')).status, 400);
  assert.equal((await get('/api/hiscores?board=nope')).status, 400);
  assert.equal((await get('/api/hiscores?category=source')).status, 400);
  await app.close();
});

test('personal page has ranks, loot, drops and collection log', async () => {
  const { app, submit, get } = await setup();
  const body = submission({ username: 'Hcim', accountType: 3 });
  const token = (await submit(body)).json().token;
  // Retried drop with the same id must not duplicate; loot sources replace rather than add.
  await submit(body, token);
  await submit(submission({ username: 'Rival', accountType: 1, stats: { skills: skills(99, 20_000_000), questPoints: 1 } }));

  const page = (await get('/api/players/hcim')).body;
  // No board requested: defaults to Normal, which they're on.
  assert.equal(page.board, 'normal');
  assert.deepEqual(page.profile.boards, ['normal', 'ironman', 'hardcore_ironman']);
  assert.equal(page.profile.defaultBoard, 'hardcore_ironman');
  assert.equal(page.profile.lootValue, 2 * 1_500_000 + 500_000);
  assert.equal(page.ranks.overall.rank, 2);
  assert.equal(page.ranks.skills.find((s: { skill: string }) => s.skill === 'ATTACK').rank, 2);
  assert.equal(page.ranks.stats.find((s: { key: string }) => s.key === 'quest_points').rank, 1);
  assert.equal(page.ranks.sources[0].kills, 1000);
  assert.equal(page.ranks.sources[0].killRank, 1);

  const hcBoard = (await get('/api/players/Hcim?board=hardcore_ironman')).body;
  assert.equal(hcBoard.ranks.overall.rank, 1); // Rival isn't a hardcore ironman

  const items = (await get('/api/players/Hcim/loot/items?type=NPC&name=Abyssal%20demon')).body;
  assert.deepEqual(items.map((i: { id: number }) => i.id), [WHIP, COINS]);

  const drops = (await get('/api/players/Hcim/drops')).body;
  assert.equal(drops.length, 1);
  assert.equal(drops[0].value, 1_500_000);
  assert.equal(drops[0].items[0].name, 'Abyssal whip');

  assert.deepEqual((await get('/api/players/Hcim/collection-log')).body, [{ id: WHIP, name: 'Abyssal whip', quantity: 2 }]);
  assert.equal((await get('/api/players/nobody')).status, 404);
  assert.equal((await get('/api/players?q=hc')).body[0].board, 'hardcore_ironman');
  await app.close();
});

test('opening a player from a board they are not on falls back to their own board', async () => {
  const { app, submit, get } = await setup();
  await submit(submission({ username: 'Hc World', gameMode: 'HARDCORE_MAIN' }));
  await submit(submission({ username: 'Leaguer', profileType: 'DEMONIC_PACTS_LEAGUE', gameMode: 'SEASONAL' }));

  assert.equal((await get('/api/players/Hc%20World?board=normal')).body.board, 'hardcore_worlds');
  const league = (await get('/api/players/Leaguer')).body;
  assert.equal(league.board, 'leagues');
  assert.equal(league.season, 'DEMONIC_PACTS_LEAGUE');
  await app.close();
});

test('stats-only submission keeps previously known values', async () => {
  const { app, submit, get } = await setup();
  const body = submission();
  const token = (await submit(body)).json().token;
  await submit({ ...body, stats: { questPoints: 301 }, lootSources: [], drops: [], collectionLogItems: [] }, token);
  const { profile } = (await get('/api/players/Zezima')).body;
  assert.equal(profile.questPoints, 301);
  assert.equal(profile.playtimeMinutes, 60_000);
  assert.equal(profile.totalLevel, 99 * SKILLS.length);
  assert.equal(profile.lootValue, 3_500_000);
  await app.close();
});

test('rejects malformed submissions', async () => {
  const { app, submit } = await setup();
  assert.equal((await submit(submission({ username: '<script>' }))).statusCode, 400);
  assert.equal((await submit(submission({ accountHash: 'abc' }))).statusCode, 400);
  assert.equal((await submit(submission({ gameMode: 'TOURNAMENT' }))).statusCode, 400);
  assert.equal((await submit(submission({ stats: { skills: { NOT_A_SKILL: [1, 0] } } }))).statusCode, 400);
  const odd = submission({ lootSources: [{ type: 'NPC', name: 'x', kills: 1, drops: [WHIP] }] });
  assert.equal((await submit(odd)).statusCode, 400);
  await app.close();
});

test('quests: state, timing kept once known, completed count and speed boards', async () => {
  const { app, submit, get } = await setup();
  const quests = [
    { id: 1, name: "Cook's Assistant", state: 'FINISHED' },
    { id: 2, name: 'Dragon Slayer I', state: 'IN_PROGRESS', startedAt: 1_000 },
    { id: 3, name: 'Monkey Madness I', state: 'NOT_STARTED' },
  ];
  const slow = submission({ username: 'Slow', quests });
  const slowToken = (await submit(slow)).json().token;
  const fast = submission({ username: 'Fast', quests });
  const fastToken = (await submit(fast)).json().token;

  // Both finish Dragon Slayer; the plugin sends timing once, then later submissions omit it.
  await submit({ ...slow, quests: [{ id: 2, name: 'Dragon Slayer I', state: 'FINISHED', startedAt: 1_000, completedAt: 9_000_000, elapsedMs: 8_999_000, playedMs: 7_200_000 }] }, slowToken);
  await submit({ ...fast, quests: [{ id: 2, name: 'Dragon Slayer I', state: 'FINISHED', startedAt: 1_000, completedAt: 5_000_000, elapsedMs: 4_999_000, playedMs: 3_600_000 }] }, fastToken);
  await submit({ ...slow, quests: [{ id: 2, name: 'Dragon Slayer I', state: 'FINISHED' }] }, slowToken);

  const list = (await get('/api/players/Slow/quests')).body;
  assert.deepEqual(list.map((q: { name: string; state: string }) => [q.name, q.state]),
    [["Cook's Assistant", 'FINISHED'], ['Dragon Slayer I', 'FINISHED'], ['Monkey Madness I', 'NOT_STARTED']]);
  assert.equal(list[1].playedMs, 7_200_000, 'timing survives a later submission without it');
  assert.equal(list[0].playedMs, null, 'quests finished before tracking have no time');

  assert.equal((await get('/api/players/Slow')).body.profile.questsCompleted, 2);
  const completed = (await get('/api/hiscores?category=quests_completed')).body.rows;
  assert.deepEqual(completed.map((r: { score: number }) => r.score), [2, 2]);

  const speed = (await get('/api/hiscores?category=quest&quest=2')).body;
  assert.equal(speed.quest, 'Dragon Slayer I');
  assert.deepEqual(speed.rows.map((r: { username: string; playedMs: number }) => [r.username, r.playedMs]),
    [['Fast', 3_600_000], ['Slow', 7_200_000]]);
  assert.deepEqual((await get('/api/quests')).body, [{ id: 2, name: 'Dragon Slayer I', players: 2 }]);
  assert.equal((await get('/api/hiscores?category=quest')).status, 400);
  await app.close();
});

test('upgrading a v2 database keeps existing players', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'hiscores-'));
  const path = join(dir, 'test.db');
  try {
    // Make a v2 database: today's schema minus what v3 and v4 added.
    const v2 = openDatabase(path);
    v2.exec(`DROP INDEX players_quests; DROP INDEX players_ca; DROP INDEX players_diaries;
      ALTER TABLE players DROP COLUMN quests_completed; DROP TABLE player_quests;
      ${['ca_points', 'ca_tasks', 'slayer_points', 'slayer_streak', 'diaries', 'diaries_completed']
        .map((c) => `ALTER TABLE players DROP COLUMN ${c};`).join(' ')}
      DROP TABLE player_killcounts; DROP TABLE player_level_ups; DROP TABLE xp_daily;`);
    v2.pragma('user_version = 2');
    v2.prepare(`INSERT INTO players (account_hash, realm, game_mode, username, username_key, created_at, updated_at)
      VALUES ('1', 'STANDARD', 'NORMAL', 'Survivor', 'survivor', 0, 0)`).run();
    v2.close();

    const db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.equal((db.prepare('SELECT username, quests_completed FROM players').get() as { username: string }).username, 'Survivor');
    for (const t of ['player_quests', 'player_killcounts', 'player_level_ups', 'xp_daily']) {
      assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t);
    }
    assert.ok(db.prepare('SELECT ca_points, diaries_completed FROM players').get());
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kill counts, personal bests, diaries, combat achievements and slayer', async () => {
  const { app, submit, get } = await setup();
  const diaries = { Ardougne: [1, 1, 1, 0], Karamja: [1, 1, 0, 0], Wilderness: [0, 0, 0, 0] };
  const stats = (extra: object) => ({ skills: skills(80, 2_000_000), combatLevel: 110, questPoints: 200, ...extra });
  const a = submission({
    username: 'Alpha', stats: stats({ diaries, combatAchievementPoints: 1200, combatAchievementTasks: 300, slayerPoints: 5000, slayerStreak: 250 }),
    killCounts: [{ name: 'Zulrah', kc: 500, pb: 61.2 }, { name: 'vorkath', kc: 100 }, { name: 'clue scrolls (elite)', kc: 40 }],
  });
  const aToken = (await submit(a)).json().token;
  await submit(submission({
    username: 'Bravo', stats: stats({ combatAchievementPoints: 300, slayerPoints: 100, slayerStreak: 900 }),
    killCounts: [{ name: 'zulrah', kc: 900, pb: 75 }],
  }));

  // A later kill count update without a PB keeps the stored PB.
  await submit({ ...a, stats: null, killCounts: [{ name: 'zulrah', kc: 501 }] }, aToken);

  const byKc = (await get('/api/hiscores?category=kc&name=Zulrah')).body.rows;
  assert.deepEqual(byKc.map((r: { username: string; kc: number }) => [r.username, r.kc]), [['Bravo', 900], ['Alpha', 501]]);
  const byPb = (await get('/api/hiscores?category=kc&name=zulrah&metric=pb')).body.rows;
  assert.deepEqual(byPb.map((r: { username: string; pb: number }) => [r.username, r.pb]), [['Alpha', 61.2], ['Bravo', 75]]);

  const kcs = (await get('/api/players/Alpha/killcounts')).body;
  const zulrah = kcs.find((k: { name: string }) => k.name === 'zulrah');
  assert.deepEqual(zulrah, { name: 'zulrah', kc: 501, pb: 61.2, kcRank: 2, pbRank: 1 });
  assert.deepEqual((await get('/api/killcounts')).body.map((k: { name: string }) => k.name), ['clue scrolls (elite)', 'vorkath', 'zulrah']);

  const { profile, ranks } = (await get('/api/players/Alpha')).body;
  assert.equal(profile.diariesCompleted, 5);
  assert.deepEqual(profile.diaries.Karamja, [1, 1, 0, 0]);
  assert.deepEqual(profile.combatAchievements, { points: 1200, tasks: 300 });
  assert.deepEqual(profile.slayer, { points: 5000, streak: 250 });
  const rank = (key: string) => ranks.stats.find((x: { key: string }) => x.key === key).rank;
  assert.equal(rank('ca_points'), 1);
  assert.equal(rank('slayer_streak'), 2);
  assert.deepEqual((await get('/api/hiscores?category=diaries')).body.rows.map((r: { score: number }) => r.score), [5]);
  await app.close();
});

test('xp gains use the first snapshot of the period, and level-ups are recorded', async () => {
  const { app, db, submit, get } = await setup();
  const body = submission({ username: 'Grinder', stats: { skills: skills(90, 5_346_332), combatLevel: 120 } });
  const token = (await submit(body)).json().token;
  const id = (db.prepare("SELECT id FROM players WHERE username = 'Grinder'").get() as { id: number }).id;

  // Pretend we had snapshots 3 and 20 days ago with less XP.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const snap = (n: number, xp: number) => db.prepare('INSERT INTO xp_daily (player_id, day, total_xp, skills) VALUES (?, ?, ?, ?)')
    .run(id, daysAgo(n), xp * SKILLS.length, JSON.stringify(Object.fromEntries(SKILLS.map((s) => [s, xp]))));
  snap(20, 4_000_000);
  snap(3, 5_000_000);

  // Today: gain 100k Attack XP and level from 90 to 91.
  await submit({ ...body, stats: { skills: skills(90, 5_346_332, { ATTACK: [91, 5_446_332] }) }, levelUps: [{ skill: 'ATTACK', level: 91, at: Date.now() }] }, token);

  const progress = (await get('/api/players/Grinder/progress')).body;
  assert.equal(progress.gains.day.overall, 100_000);
  assert.equal(progress.gains.week.overall, (5_346_332 - 5_000_000) * SKILLS.length + 100_000);
  assert.equal(progress.gains.month.skills.find((x: { skill: string }) => x.skill === 'ATTACK').xp, 5_446_332 - 4_000_000);
  assert.deepEqual(progress.levelUps.map((l: { skill: string; level: number }) => [l.skill, l.level]), [['ATTACK', 91]]);
  assert.equal(progress.history.length, 3);

  const week = (await get('/api/hiscores?category=gains&period=week')).body;
  assert.equal(week.rows[0].username, 'Grinder');
  const attackDay = (await get('/api/hiscores?category=gains&period=day&skill=ATTACK')).body.rows;
  assert.deepEqual(attackDay.map((r: { gained: number }) => r.gained), [100_000]);
  assert.equal((await get('/api/hiscores?category=gains&skill=NOPE')).status, 400);
  await app.close();
});
