import type Database from 'better-sqlite3';
import { usernameKey, type DB } from './db.ts';
import { BOARDS, boardById, SKILLS, STAT_CATEGORIES, type Board, type StatCategory } from './boards.ts';

export const PAGE_SIZE = 25;

/** Most specific board first: the default board shown for a player who is on several. */
const BOARD_PRIORITY = [
  'hardcore_group_ironman', 'group_ironman', 'hardcore_ironman', 'ultimate', 'ironman',
  'hardcore_worlds', 'fresh_start', 'leagues', 'deadman', 'normal',
];

export type Category =
  | { kind: 'overall' }
  | { kind: 'skill'; skill: string }
  | { kind: 'stat'; stat: StatCategory }
  | { kind: 'source'; type: string; name: string; metric: 'kills' | 'value' }
  | { kind: 'quest'; questId: number }
  | { kind: 'kc'; name: string; metric: 'kc' | 'pb' }
  | { kind: 'gains'; period: Period; skill: string };

export type Period = 'day' | 'week' | 'month';
const PERIOD_DAYS: Record<Period, number> = { day: 0, week: 6, month: 29 };

/** First UTC day (YYYY-MM-DD) of a gains period ending today. */
export function periodStart(period: Period, now = Date.now()): string {
  return new Date(now - PERIOD_DAYS[period] * 86_400_000).toISOString().slice(0, 10);
}

/** SQL for a player's XP at the start of a period: the first daily snapshot on or after the start day. */
const baselineSql = (skill: string) => skill === 'overall'
  ? `(SELECT d.total_xp FROM xp_daily d WHERE d.player_id = p.id AND d.day >= ? ORDER BY d.day LIMIT 1)`
  : `(SELECT json_extract(d.skills, '$.' || ?) FROM xp_daily d WHERE d.player_id = p.id AND d.day >= ? ORDER BY d.day LIMIT 1)`;
const currentSql = (skill: string) => skill === 'overall'
  ? 'p.total_xp'
  : '(SELECT ps.xp FROM player_skills ps WHERE ps.player_id = p.id AND ps.skill = ?)';

export class QueryError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface PlayerRow {
  id: number;
  realm: string;
  game_mode: string;
  username: string;
  account_type: number;
  total_level: number | null;
  total_xp: number | null;
  combat_level: number | null;
  quest_points: number | null;
  clog_obtained: number | null;
  clog_total: number | null;
  clog_categories: string | null;
  playtime_minutes: number | null;
  quests_completed: number | null;
  ca_points: number | null;
  ca_tasks: number | null;
  slayer_points: number | null;
  slayer_streak: number | null;
  diaries: string | null;
  diaries_completed: number | null;
  loot_value: number;
  total_kills: number;
  created_at: number;
  updated_at: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Statement cache: queries are built per board, so prepare each distinct SQL string once. */
function statementCache(db: DB) {
  const cache = new Map<string, Database.Statement<unknown[]>>();
  return (sql: string) => {
    let st = cache.get(sql);
    if (!st) cache.set(sql, (st = db.prepare<unknown[]>(sql)));
    return st;
  };
}

/** Tiny TTL cache for the sidebar lists and board summaries, which aggregate the whole board. */
function ttlCache(ms: number) {
  const store = new Map<string, { at: number; value: unknown }>();
  return <T>(key: string, compute: () => T): T => {
    const hit = store.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ms) return hit.value as T;
    const value = compute();
    store.set(key, { at: now, value });
    return value;
  };
}

export function createQueries(db: DB) {
  const prep = statementCache(db);
  const cached = ttlCache(60_000);
  /** A board plus the season it's showing, as a SQL fragment over `players p`. */
  interface Scope { board: Board; season: string | null; where: string; params: string[] }

  const latestSeason = db.prepare<[string], { realm: string }>(
    'SELECT realm FROM players WHERE game_mode = ? ORDER BY updated_at DESC LIMIT 1');
  const seasonsFor = db.prepare<[string], { realm: string }>(
    'SELECT realm FROM players WHERE game_mode = ? GROUP BY realm ORDER BY MAX(updated_at) DESC');

  function scope(boardId: string, season?: string): Scope {
    const board = boardById(boardId);
    if (!board) throw new QueryError(400, `Unknown board ${boardId}`);
    if (!board.seasonal) return { board, season: null, where: board.where, params: [] };
    const realm = season ?? latestSeason.get(board.seasonal)?.realm ?? null;
    return { board, season: realm, where: `${board.where} AND p.realm = ?`, params: [realm ?? ''] };
  }

  const realmFor = (s: Scope) => s.season ?? 'STANDARD';

  const findPlayer = db.prepare<[string, string], PlayerRow>(
    'SELECT * FROM players WHERE username_key = ? AND realm = ? ORDER BY updated_at DESC LIMIT 1');
  const findAnyPlayer = db.prepare<[string], PlayerRow>(
    'SELECT * FROM players WHERE username_key = ? ORDER BY updated_at DESC LIMIT 1');

  /**
   * Find a player for a board. If they aren't on that board (e.g. a Hardcore Worlds character opened
   * from the Normal board, or a league character), fall back to the board they're on.
   */
  function resolvePlayer(username: string, boardId: string, season?: string): { p: PlayerRow; s: Scope; boards: string[] } {
    let s = scope(boardId, season);
    const key = usernameKey(username);
    const p = findPlayer.get(key, realmFor(s)) ?? findAnyPlayer.get(key);
    if (!p) throw new QueryError(404, 'Player not found');
    const boards = memberships(p.id);
    if (!boards.includes(s.board.id) || (s.season && s.season !== p.realm)) {
      const fallback = defaultBoard(boards);
      s = scope(fallback, boardById(fallback)?.seasonal ? p.realm : undefined);
    }
    return { p, s, boards };
  }

  function memberships(playerId: number): string[] {
    return BOARDS.filter((b) => db.prepare(`SELECT 1 FROM players p WHERE p.id = ? AND ${b.where}`).get(playerId))
      .map((b) => b.id);
  }

  const defaultBoard = (boards: string[]) => BOARD_PRIORITY.find((id) => boards.includes(id)) ?? boards[0] ?? 'normal';

  function profile(p: PlayerRow, boards: string[]) {
    return {
      /** Always true here: everyone in our database has submitted data with the plugin. */
      pluginLinked: true,
      username: p.username,
      accountType: p.account_type,
      gameMode: p.game_mode,
      realm: p.realm,
      boards,
      defaultBoard: defaultBoard(boards),
      totalLevel: p.total_level,
      totalXp: p.total_xp,
      combatLevel: p.combat_level,
      questPoints: p.quest_points,
      collectionLog: p.clog_total == null ? null : {
        obtained: p.clog_obtained,
        total: p.clog_total,
        categories: p.clog_categories ? JSON.parse(p.clog_categories) as Record<string, [number, number]> : {},
      },
      playtimeMinutes: p.playtime_minutes,
      questsCompleted: p.quests_completed,
      combatAchievements: p.ca_points == null ? null : { points: p.ca_points, tasks: p.ca_tasks },
      slayer: p.slayer_points == null ? null : { points: p.slayer_points, streak: p.slayer_streak },
      diaries: p.diaries ? JSON.parse(p.diaries) as Record<string, number[]> : null,
      diariesCompleted: p.diaries_completed,
      lootValue: p.loot_value,
      totalKills: p.total_kills,
      firstSeen: p.created_at,
      lastUpdated: p.updated_at,
    };
  }

  /**
   * Ranks for every category, within one board. Each rank is 1 + the number of board members strictly
   * ahead, counted through an index on the score, so the cost depends on how many players are ahead
   * rather than sorting the whole board.
   */
  function ranks(p: PlayerRow, s: Scope) {
    const count = (sql: string, ...args: unknown[]) => (prep(sql).get(...args) as { n: number }).n + 1;

    const overall = p.total_level == null ? null : count(
      `SELECT COUNT(*) AS n FROM players p WHERE p.total_level IS NOT NULL
         AND (p.total_level > ? OR (p.total_level = ? AND p.total_xp > ?)) AND ${s.where}`,
      p.total_level, p.total_level, p.total_xp, ...s.params);

    const mySkills = prep('SELECT skill, level, xp FROM player_skills WHERE player_id = ?')
      .all(p.id) as { skill: string; level: number; xp: number }[];
    const skillRankSql = `SELECT COUNT(*) AS n FROM player_skills ps JOIN players p ON p.id = ps.player_id
       WHERE ps.skill = ? AND ps.xp > ? AND ${s.where}`;
    const bySkill = new Map(mySkills.map((r) => [r.skill, { ...r, rnk: count(skillRankSql, r.skill, r.xp, ...s.params) }]));

    const stats = Object.entries(STAT_CATEGORIES).map(([key, { column, label }]) => {
      const score = (p as unknown as Record<string, number | null>)[column];
      const rank = score == null || score <= 0 ? null
        : count(`SELECT COUNT(*) AS n FROM players p WHERE p.${column} > ? AND ${s.where}`, score, ...s.params);
      return { key, label, score, rank };
    });

    const mine = prep(
      `SELECT type, name, kills, value, first_at, last_at FROM loot_sources WHERE player_id = ? ORDER BY value DESC, kills DESC`,
    ).all(p.id) as { type: string; name: string; kills: number; value: number; first_at: number | null; last_at: number | null }[];
    const sourceRankSql = (col: 'kills' | 'value') => `SELECT COUNT(*) AS n FROM loot_sources s JOIN players p ON p.id = s.player_id
       WHERE s.type = ? AND s.name = ? AND s.${col} > ? AND ${s.where}`;
    const sources = mine.map((r) => ({
      ...r,
      kill_rank: count(sourceRankSql('kills'), r.type, r.name, r.kills, ...s.params),
      value_rank: count(sourceRankSql('value'), r.type, r.name, r.value, ...s.params),
    }));

    return {
      overall: { rank: overall, level: p.total_level, xp: p.total_xp },
      skills: SKILLS.map((skill) => {
        const r = bySkill.get(skill);
        return { skill, rank: r?.rnk ?? null, level: r?.level ?? null, xp: r?.xp ?? null };
      }),
      stats,
      sources: sources.map((r) => ({
        type: r.type, name: r.name, kills: r.kills, value: r.value, firstAt: r.first_at, lastAt: r.last_at,
        killRank: r.kill_rank, valueRank: r.value_rank,
      })),
    };
  }

  return {
    boards() {
      return BOARDS.map((b) => ({
        id: b.id, label: b.label, group: b.group,
        seasons: b.seasonal ? seasonsFor.all(b.seasonal).map((r) => r.realm) : undefined,
      }));
    },

    search(q: string) {
      const key = usernameKey(q);
      if (!key) return [];
      const rows = db.prepare(
        `SELECT id, username, account_type, game_mode, realm FROM players WHERE username_key LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT 10`,
      ).all(escapeLike(key) + '%') as { id: number; username: string; account_type: number; game_mode: string; realm: string }[];
      return rows.map((r) => {
        const boards = memberships(r.id);
        const board = defaultBoard(boards);
        return { username: r.username, accountType: r.account_type, gameMode: r.game_mode, board, season: boardById(board)?.seasonal ? r.realm : undefined };
      });
    },

    /** Full personal hiscores page for one board. */
    player(username: string, boardId: string, season?: string) {
      const { p, s, boards } = resolvePlayer(username, boardId, season);
      return { board: s.board.id, season: s.season, profile: profile(p, boards), ranks: ranks(p, s) };
    },

    sourceItems(username: string, boardId: string, season: string | undefined, type: string, name: string) {
      const { p } = resolvePlayer(username, boardId, season);
      const rows = db.prepare(
        `SELECT li.item_id AS id, i.name, li.quantity, i.ge_price
         FROM loot_sources s JOIN loot_items li ON li.source_id = s.id LEFT JOIN items i ON i.item_id = li.item_id
         WHERE s.player_id = ? AND s.type = ? AND s.name = ?
         ORDER BY li.quantity * COALESCE(i.ge_price, 0) DESC, li.quantity DESC`,
      ).all(p.id, type, name) as { id: number; name: string | null; quantity: number; ge_price: number | null }[];
      return rows.map((i) => ({
        id: i.id, name: i.name ?? `Item ${i.id}`, quantity: i.quantity,
        gePrice: i.ge_price ?? 0, value: i.quantity * (i.ge_price ?? 0),
      }));
    },

    drops(username: string, boardId: string, season: string | undefined, limit: number) {
      const { p } = resolvePlayer(username, boardId, season);
      const rows = db.prepare(
        `SELECT type, name, amount, timestamp, world, items, value FROM drops
         WHERE player_id = ? ORDER BY timestamp DESC LIMIT ?`,
      ).all(p.id, limit) as { type: string; name: string; amount: number; timestamp: number; world: number; items: string; value: number }[];
      const parsed = rows.map((d) => ({ ...d, items: JSON.parse(d.items) as [number, number][] }));
      const ids = [...new Set(parsed.flatMap((d) => d.items.map(([id]) => id)))];
      const names = new Map(ids.length === 0 ? [] : (db.prepare(
        `SELECT item_id, name FROM items WHERE item_id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as { item_id: number; name: string }[]).map((r) => [r.item_id, r.name]));
      return parsed.map((d) => ({
        type: d.type, name: d.name, amount: d.amount, timestamp: d.timestamp, world: d.world, value: d.value,
        items: d.items.map(([id, quantity]) => ({ id, quantity, name: names.get(id) ?? `Item ${id}` })),
      }));
    },

    /** Every quest's state for a player, with timing where the plugin measured it. */
    quests(username: string, boardId: string, season?: string) {
      const { p } = resolvePlayer(username, boardId, season);
      return (db.prepare(
        `SELECT quest_id AS id, name, state, started_at AS startedAt, completed_at AS completedAt,
           elapsed_ms AS elapsedMs, played_ms AS playedMs
         FROM player_quests WHERE player_id = ? ORDER BY name COLLATE NOCASE`,
      ).all(p.id)) as {
        id: number; name: string; state: string; startedAt: number | null; completedAt: number | null;
        elapsedMs: number | null; playedMs: number | null;
      }[];
    },

    /** Official kill counts and PBs for a player, with ranks on the board. */
    killCounts(username: string, boardId: string, season?: string) {
      const { p, s } = resolvePlayer(username, boardId, season);
      const mine = prep('SELECT name, kc, pb_seconds AS pb FROM player_killcounts WHERE player_id = ? ORDER BY name')
        .all(p.id) as { name: string; kc: number | null; pb: number | null }[];
      const rank = (sql: string, ...args: unknown[]) => (prep(sql).get(...args) as { n: number }).n + 1;
      return mine.map((k) => ({
        ...k,
        kcRank: k.kc == null ? null : rank(`SELECT COUNT(*) AS n FROM player_killcounts k JOIN players p ON p.id = k.player_id
          WHERE k.name = ? AND k.kc > ? AND ${s.where}`, k.name, k.kc, ...s.params),
        pbRank: k.pb == null ? null : rank(`SELECT COUNT(*) AS n FROM player_killcounts k JOIN players p ON p.id = k.player_id
          WHERE k.name = ? AND k.pb_seconds IS NOT NULL AND k.pb_seconds < ? AND ${s.where}`, k.name, k.pb, ...s.params),
      }));
    },

    /** XP gains (day/week/month), daily total XP history and level-ups. */
    progress(username: string, boardId: string, season?: string, now = Date.now()) {
      const { p } = resolvePlayer(username, boardId, season);
      const current = new Map((db.prepare('SELECT skill, xp FROM player_skills WHERE player_id = ?').all(p.id) as { skill: string; xp: number }[])
        .map((r) => [r.skill, r.xp]));
      const baselineFor = db.prepare<[number, string], { total_xp: number; skills: string }>(
        'SELECT total_xp, skills FROM xp_daily WHERE player_id = ? AND day >= ? ORDER BY day LIMIT 1');
      const gains = Object.fromEntries((['day', 'week', 'month'] as Period[]).map((period) => {
        const base = baselineFor.get(p.id, periodStart(period, now));
        if (!base || p.total_xp == null) return [period, null];
        const baseSkills = JSON.parse(base.skills) as Record<string, number>;
        return [period, {
          since: periodStart(period, now),
          overall: p.total_xp - base.total_xp,
          skills: SKILLS.map((skill) => ({ skill, xp: (current.get(skill) ?? 0) - (baseSkills[skill] ?? current.get(skill) ?? 0) })),
        }];
      }));
      const history = db.prepare(
        `SELECT day, total_xp AS totalXp FROM xp_daily WHERE player_id = ? ORDER BY day DESC LIMIT 90`,
      ).all(p.id).reverse() as { day: string; totalXp: number }[];
      const levelUps = db.prepare(
        `SELECT skill, level, achieved_at AS at FROM player_level_ups WHERE player_id = ? ORDER BY achieved_at DESC, level DESC LIMIT 100`,
      ).all(p.id) as { skill: string; level: number; at: number }[];
      return { gains, history, levelUps };
    },

    /** Kill count names (bosses, activities, clues) with players on this board. */
    killCountNames(boardId: string, season?: string) {
      const s = scope(boardId, season);
      return cached(`kc|${s.board.id}|${s.season}`, () => prep(
        `SELECT k.name, COUNT(*) AS players FROM player_killcounts k JOIN players p ON p.id = k.player_id
         WHERE ${s.where} AND (k.kc > 0 OR k.pb_seconds IS NOT NULL) GROUP BY k.name ORDER BY k.name`,
      ).all(...s.params) as { name: string; players: number }[]);
    },

    /** Quests with at least one timed completion on this board, for the quest speed leaderboards. */
    timedQuests(boardId: string, season?: string) {
      const s = scope(boardId, season);
      return cached(`quests|${s.board.id}|${s.season}`, () => prep(
        `SELECT q.quest_id AS id, MAX(q.name) AS name, COUNT(*) AS players FROM player_quests q
         JOIN players p ON p.id = q.player_id
         WHERE ${s.where} AND q.state = 'FINISHED' AND q.played_ms IS NOT NULL
         GROUP BY q.quest_id ORDER BY name COLLATE NOCASE`,
      ).all(...s.params) as { id: number; name: string; players: number }[]);
    },

    collectionLog(username: string, boardId: string, season?: string) {
      const { p } = resolvePlayer(username, boardId, season);
      return (db.prepare(
        `SELECT c.item_id AS id, i.name, c.quantity FROM collection_log_items c
         LEFT JOIN items i ON i.item_id = c.item_id WHERE c.player_id = ? ORDER BY i.name`,
      ).all(p.id) as { id: number; name: string | null; quantity: number }[])
        .map((i) => ({ id: i.id, name: i.name ?? `Item ${i.id}`, quantity: i.quantity }));
    },

    /** One page of a leaderboard. */
    hiscores(boardId: string, season: string | undefined, category: Category, page: number) {
      const s = scope(boardId, season);
      const offset = page * PAGE_SIZE;
      const base = { board: s.board.id, season: s.season, page, pageSize: PAGE_SIZE };
      const rankOf = (i: number) => offset + i + 1;

      if (category.kind === 'overall') {
        const rows = db.prepare(
          `SELECT p.username, p.account_type, p.total_level AS level, p.total_xp AS xp FROM players p
           WHERE ${s.where} AND p.total_level IS NOT NULL
           ORDER BY p.total_level DESC, p.total_xp DESC, p.updated_at ASC LIMIT ? OFFSET ?`,
        ).all(...s.params, PAGE_SIZE, offset) as { username: string; account_type: number; level: number; xp: number }[];
        return { ...base, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, level: r.level, xp: r.xp })) };
      }

      if (category.kind === 'skill') {
        if (!(SKILLS as readonly string[]).includes(category.skill)) throw new QueryError(400, 'Unknown skill');
        const rows = db.prepare(
          `SELECT p.username, p.account_type, ps.level, ps.xp FROM player_skills ps JOIN players p ON p.id = ps.player_id
           WHERE ${s.where} AND ps.skill = ? AND ps.xp > 0
           ORDER BY ps.xp DESC, p.updated_at ASC LIMIT ? OFFSET ?`,
        ).all(...s.params, category.skill, PAGE_SIZE, offset) as { username: string; account_type: number; level: number; xp: number }[];
        return { ...base, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, level: r.level, xp: r.xp })) };
      }

      if (category.kind === 'stat') {
        const { column } = STAT_CATEGORIES[category.stat];
        const rows = db.prepare(
          `SELECT p.username, p.account_type, p.${column} AS score FROM players p
           WHERE ${s.where} AND p.${column} > 0
           ORDER BY p.${column} DESC, p.updated_at ASC LIMIT ? OFFSET ?`,
        ).all(...s.params, PAGE_SIZE, offset) as { username: string; account_type: number; score: number }[];
        return { ...base, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, score: r.score })) };
      }

      if (category.kind === 'kc') {
        const pb = category.metric === 'pb';
        const rows = db.prepare(
          `SELECT p.username, p.account_type, k.kc, k.pb_seconds AS pb FROM player_killcounts k JOIN players p ON p.id = k.player_id
           WHERE ${s.where} AND k.name = ? AND ${pb ? 'k.pb_seconds IS NOT NULL' : 'k.kc > 0'}
           ORDER BY ${pb ? 'k.pb_seconds ASC' : 'k.kc DESC'}, k.updated_at ASC LIMIT ? OFFSET ?`,
        ).all(...s.params, category.name, PAGE_SIZE, offset) as { username: string; account_type: number; kc: number | null; pb: number | null }[];
        return { ...base, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, kc: r.kc, pb: r.pb })) };
      }

      if (category.kind === 'gains') {
        if (category.skill !== 'overall' && !(SKILLS as readonly string[]).includes(category.skill)) throw new QueryError(400, 'Unknown skill');
        const start = periodStart(category.period);
        const skillParams = category.skill === 'overall' ? [] : [category.skill];
        const rows = db.prepare(
          `WITH g AS (
             SELECT p.username, p.account_type, p.updated_at, ${currentSql(category.skill)} AS cur, ${baselineSql(category.skill)} AS base
             FROM players p WHERE ${s.where}
           )
           SELECT username, account_type, cur - base AS gained FROM g
           WHERE base IS NOT NULL AND cur - base > 0
           ORDER BY gained DESC, updated_at ASC LIMIT ? OFFSET ?`,
        ).all(...skillParams, ...skillParams, start, ...s.params, PAGE_SIZE, offset) as { username: string; account_type: number; gained: number }[];
        return { ...base, since: start, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, gained: r.gained })) };
      }

      if (category.kind === 'quest') {
        // Fastest first: logged-in time between starting and finishing the quest.
        const rows = db.prepare(
          `SELECT p.username, p.account_type, q.name, q.played_ms, q.elapsed_ms, q.completed_at FROM player_quests q
           JOIN players p ON p.id = q.player_id
           WHERE ${s.where} AND q.quest_id = ? AND q.state = 'FINISHED' AND q.played_ms IS NOT NULL
           ORDER BY q.played_ms ASC, q.completed_at ASC LIMIT ? OFFSET ?`,
        ).all(...s.params, category.questId, PAGE_SIZE, offset) as {
          username: string; account_type: number; name: string; played_ms: number; elapsed_ms: number | null; completed_at: number | null;
        }[];
        return {
          ...base,
          quest: rows[0]?.name ?? null,
          rows: rows.map((r, i) => ({
            rank: rankOf(i), username: r.username, accountType: r.account_type,
            playedMs: r.played_ms, elapsedMs: r.elapsed_ms, completedAt: r.completed_at,
          })),
        };
      }

      const column = category.metric === 'value' ? 's.value' : 's.kills';
      const rows = db.prepare(
        `SELECT p.username, p.account_type, s.kills, s.value FROM loot_sources s JOIN players p ON p.id = s.player_id
         WHERE ${s.where} AND s.type = ? AND s.name = ? AND ${column} > 0
         ORDER BY ${column} DESC, s.updated_at ASC LIMIT ? OFFSET ?`,
      ).all(...s.params, category.type, category.name, PAGE_SIZE, offset) as { username: string; account_type: number; kills: number; value: number }[];
      return { ...base, rows: rows.map((r, i) => ({ rank: rankOf(i), username: r.username, accountType: r.account_type, kills: r.kills, value: r.value })) };
    },

    /** Bosses and activities that have at least one player on this board. */
    sources(boardId: string, season?: string) {
      const s = scope(boardId, season);
      return cached(`sources|${s.board.id}|${s.season}`, () => prep(
        `SELECT s.type, s.name, COUNT(*) AS players FROM loot_sources s JOIN players p ON p.id = s.player_id
         WHERE ${s.where} AND s.kills > 0 GROUP BY s.type, s.name ORDER BY s.name COLLATE NOCASE LIMIT 1000`,
      ).all(...s.params) as { type: string; name: string; players: number }[]);
    },

    summary(boardId: string, season?: string) {
      const s = scope(boardId, season);
      const r = cached(`summary|${s.board.id}|${s.season}`, () => prep(
        `SELECT COUNT(*) AS players, COALESCE(SUM(p.loot_value), 0) AS lootValue, COALESCE(SUM(p.total_kills), 0) AS kills
         FROM players p WHERE ${s.where}`,
      ).get(...s.params) as { players: number; lootValue: number; kills: number });
      return { board: s.board.id, season: s.season, ...r };
    },
  };
}
