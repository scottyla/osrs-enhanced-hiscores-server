import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { usernameKey, type DB } from './db.ts';
import type { Submission } from './validate.ts';

/**
 * The plugin sends every quest (~216, including miniquests) at login and only changes afterwards.
 * A submission with at least this many is the full list.
 */
export const FULL_QUEST_LIST = 150;

/** Drops kept per player for the recent drops feed. */
const MAX_DROPS_PER_PLAYER = 500;
/** Reject timestamps more than this far in the future (client clock skew allowance). */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export class IngestError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface IngestResult {
  /** Set only when this request claimed the character; the plugin must store it and send it back. */
  token?: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function tokensMatch(token: string | undefined, storedHash: string): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sum quantities by item id. */
function pairsToMap(pairs: Iterable<[number, number]>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, qty] of pairs) out.set(id, (out.get(id) ?? 0) + qty);
  return out;
}

function* flatPairs(flat: number[]): Generator<[number, number]> {
  for (let i = 0; i + 1 < flat.length; i += 2) yield [flat[i], flat[i + 1]];
}

export function createIngest(db: DB) {
  const stmts = {
    getPlayer: db.prepare<[string, string], { id: number; token_hash: string | null }>(
      'SELECT id, token_hash FROM players WHERE account_hash = ? AND realm = ?'),
    insertPlayer: db.prepare<unknown[], { id: number }>(
      `INSERT INTO players (account_hash, realm, game_mode, username, username_key, account_type, token_hash, created_at, updated_at)
       VALUES (@hash, @realm, @gameMode, @username, @key, @accountType, @tokenHash, @now, @now) RETURNING id`),
    updatePlayer: db.prepare(
      `UPDATE players SET game_mode = @gameMode, username = @username, username_key = @key, account_type = @accountType,
         token_hash = COALESCE(token_hash, @tokenHash), updated_at = @now
       WHERE id = @id`),
    updateStats: db.prepare(
      `UPDATE players SET
         total_level      = COALESCE(@totalLevel, total_level),
         total_xp         = COALESCE(@totalXp, total_xp),
         combat_level     = COALESCE(@combatLevel, combat_level),
         defence_level    = COALESCE(@defenceLevel, defence_level),
         quest_points     = COALESCE(@questPoints, quest_points),
         clog_obtained    = COALESCE(@clogObtained, clog_obtained),
         clog_total       = COALESCE(@clogTotal, clog_total),
         clog_categories  = COALESCE(@clogCategories, clog_categories),
         playtime_minutes = COALESCE(@playtime, playtime_minutes),
         ca_points        = COALESCE(@caPoints, ca_points),
         ca_tasks         = COALESCE(@caTasks, ca_tasks),
         slayer_points    = COALESCE(@slayerPoints, slayer_points),
         slayer_streak    = COALESCE(@slayerStreak, slayer_streak),
         diaries          = COALESCE(@diaries, diaries),
         diaries_completed = COALESCE(@diariesCompleted, diaries_completed)
       WHERE id = @id`),
    insertDailyXp: db.prepare(
      `INSERT OR IGNORE INTO xp_daily (player_id, day, total_xp, skills) VALUES (@playerId, @day, @totalXp, @skills)`),
    upsertKillCount: db.prepare(
      `INSERT INTO player_killcounts (player_id, name, kc, pb_seconds, updated_at) VALUES (@playerId, @name, @kc, @pb, @now)
       ON CONFLICT(player_id, name) DO UPDATE SET
         kc = COALESCE(excluded.kc, kc), pb_seconds = COALESCE(excluded.pb_seconds, pb_seconds), updated_at = excluded.updated_at`),
    insertLevelUp: db.prepare(
      `INSERT OR IGNORE INTO player_level_ups (player_id, skill, level, achieved_at) VALUES (?, ?, ?, ?)`),
    upsertSkill: db.prepare(
      `INSERT INTO player_skills (player_id, skill, level, xp) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, skill) DO UPDATE SET level = excluded.level, xp = excluded.xp`),
    upsertItem: db.prepare(
      `INSERT INTO items (item_id, name, ge_price, ha_price, updated_at) VALUES (@id, @name, @gePrice, @haPrice, @now)
       ON CONFLICT(item_id) DO UPDATE SET name = excluded.name, ge_price = excluded.ge_price,
         ha_price = excluded.ha_price, updated_at = excluded.updated_at`),
    upsertSource: db.prepare<unknown[], { id: number }>(
      `INSERT INTO loot_sources (player_id, type, name, kills, first_at, last_at, updated_at)
       VALUES (@playerId, @type, @name, @kills, @first, @last, @now)
       ON CONFLICT(player_id, type, name) DO UPDATE SET kills = excluded.kills,
         first_at = excluded.first_at, last_at = excluded.last_at, updated_at = excluded.updated_at
       RETURNING id`),
    clearSourceItems: db.prepare('DELETE FROM loot_items WHERE source_id = ?'),
    insertSourceItem: db.prepare('INSERT INTO loot_items (source_id, item_id, quantity) VALUES (?, ?, ?)'),
    updateSourceValue: db.prepare(
      `UPDATE loot_sources SET value = (
         SELECT COALESCE(SUM(li.quantity * COALESCE(i.ge_price, 0)), 0)
         FROM loot_items li LEFT JOIN items i ON i.item_id = li.item_id WHERE li.source_id = @id)
       WHERE id = @id`),
    insertDrop: db.prepare(
      `INSERT OR IGNORE INTO drops (id, player_id, type, name, combat_level, amount, timestamp, world, items, value)
       VALUES (@id, @playerId, @type, @name, @combatLevel, @amount, @timestamp, @world, @items, @value)`),
    pruneDrops: db.prepare(
      `DELETE FROM drops WHERE player_id = @playerId AND id NOT IN (
         SELECT id FROM drops WHERE player_id = @playerId ORDER BY timestamp DESC LIMIT ${MAX_DROPS_PER_PLAYER})`),
    upsertClogItem: db.prepare(
      `INSERT INTO collection_log_items (player_id, item_id, quantity, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id, item_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`),
    upsertQuest: db.prepare(
      `INSERT INTO player_quests (player_id, quest_id, name, state, started_at, completed_at, elapsed_ms, played_ms, updated_at)
       VALUES (@playerId, @id, @name, @state, @startedAt, @completedAt, @elapsedMs, @playedMs, @now)
       ON CONFLICT(player_id, quest_id) DO UPDATE SET
         name = excluded.name, state = excluded.state, updated_at = excluded.updated_at,
         -- Timing is only sent once (when the plugin sees it happen), so never overwrite it with nothing.
         started_at   = COALESCE(excluded.started_at, started_at),
         completed_at = COALESCE(excluded.completed_at, completed_at),
         elapsed_ms   = COALESCE(excluded.elapsed_ms, elapsed_ms),
         played_ms    = COALESCE(excluded.played_ms, played_ms)`),
    // Only count quests once the full list has arrived; a partial list would give a wrong (low) count.
    updateQuestCount: db.prepare(
      `UPDATE players SET
         quests_synced_at = CASE WHEN @full THEN @now ELSE quests_synced_at END,
         quests_completed = CASE WHEN @full OR quests_synced_at IS NOT NULL
           THEN (SELECT COUNT(*) FROM player_quests WHERE player_id = @playerId AND state = 'FINISHED') END
       WHERE id = @playerId`),
    updateTotals: db.prepare(
      `UPDATE players SET
         loot_value  = (SELECT COALESCE(SUM(value), 0) FROM loot_sources WHERE player_id = @playerId),
         total_kills = (SELECT COALESCE(SUM(kills), 0) FROM loot_sources WHERE player_id = @playerId)
       WHERE id = @playerId`),
  };

  const apply = db.transaction((sub: Submission, token: string | undefined, now: number): IngestResult => {
    const existing = stmts.getPlayer.get(sub.accountHash, sub.profileType);
    const result: IngestResult = {};

    // Trust on first use: the first submission for a character gets a token, later ones must present it.
    let newTokenHash: string | null = null;
    if (existing?.token_hash) {
      if (!tokensMatch(token, existing.token_hash)) {
        throw new IngestError(403, 'Token does not match this account');
      }
    } else if (token) {
      newTokenHash = hashToken(token);
    } else {
      result.token = randomBytes(32).toString('base64url');
      newTokenHash = hashToken(result.token);
    }

    const playerParams = {
      hash: sub.accountHash, realm: sub.profileType, gameMode: sub.gameMode, username: sub.username,
      key: usernameKey(sub.username), accountType: sub.accountType, tokenHash: newTokenHash, now,
    };
    let playerId: number;
    if (existing) {
      playerId = existing.id;
      stmts.updatePlayer.run({ ...playerParams, id: playerId });
    } else {
      playerId = stmts.insertPlayer.get(playerParams)!.id;
    }

    if (sub.stats) {
      const s = sub.stats;
      const skills = Object.entries(s.skills ?? {});
      for (const [skill, [level, xp]] of skills) stmts.upsertSkill.run(playerId, skill, level, xp);
      const categories = s.collectionLogCategories && Object.keys(s.collectionLogCategories).length > 0
        ? JSON.stringify(s.collectionLogCategories) : null;
      stmts.updateStats.run({
        id: playerId,
        totalLevel: skills.length ? skills.reduce((sum, [, [level]]) => sum + level, 0) : null,
        totalXp: skills.length ? skills.reduce((sum, [, [, xp]]) => sum + xp, 0) : null,
        combatLevel: s.combatLevel ?? null,
        defenceLevel: s.skills?.DEFENCE?.[0] ?? null,
        questPoints: s.questPoints ?? null,
        clogObtained: s.collectionLogObtained ?? null,
        clogTotal: s.collectionLogTotal ?? null,
        clogCategories: categories,
        playtime: s.playtimeMinutes ?? null,
        caPoints: s.combatAchievementPoints ?? null,
        caTasks: s.combatAchievementTasks ?? null,
        slayerPoints: s.slayerPoints ?? null,
        slayerStreak: s.slayerStreak ?? null,
        diaries: s.diaries && Object.keys(s.diaries).length > 0 ? JSON.stringify(s.diaries) : null,
        diariesCompleted: s.diaries && Object.keys(s.diaries).length > 0
          ? Object.values(s.diaries).reduce((sum, tiers) => sum + tiers.reduce((a, b) => a + b, 0), 0) : null,
      });
      if (skills.length > 0) {
        // The first snapshot of each UTC day is the baseline for gains.
        stmts.insertDailyXp.run({
          playerId, day: new Date(now).toISOString().slice(0, 10),
          totalXp: skills.reduce((sum, [, [, xp]]) => sum + xp, 0),
          skills: JSON.stringify(Object.fromEntries(skills.map(([skill, [, xp]]) => [skill, xp]))),
        });
      }
    }

    for (const [id, item] of Object.entries(sub.items)) {
      stmts.upsertItem.run({ id: Number(id), name: item.name, gePrice: item.gePrice, haPrice: item.haPrice, now });
    }

    // Loot sources are full snapshots from the Loot Tracker, so they replace what we had.
    for (const source of sub.lootSources) {
      if (source.drops.length % 2 !== 0) throw new IngestError(400, `Malformed drops for ${source.name}`);
      const { id } = stmts.upsertSource.get({
        playerId, type: source.type, name: source.name, kills: source.kills,
        first: source.first ?? null, last: source.last ?? null, now,
      })!;
      stmts.clearSourceItems.run(id);
      for (const [itemId, qty] of pairsToMap(flatPairs(source.drops))) {
        stmts.insertSourceItem.run(id, itemId, qty);
      }
      stmts.updateSourceValue.run({ id });
    }

    for (const drop of sub.drops) {
      if (drop.timestamp > now + MAX_CLOCK_SKEW_MS) continue;
      const items = [...pairsToMap(drop.items)];
      const value = items.reduce((sum, [id, qty]) => sum + qty * (sub.items[id]?.gePrice ?? 0), 0);
      stmts.insertDrop.run({
        id: drop.id.toLowerCase(), playerId, type: drop.type, name: drop.name, combatLevel: drop.combatLevel,
        amount: drop.amount, timestamp: drop.timestamp, world: drop.world, items: JSON.stringify(items), value,
      });
    }
    if (sub.drops.length > 0) stmts.pruneDrops.run({ playerId });

    for (const [itemId, qty] of sub.collectionLogItems) {
      stmts.upsertClogItem.run(playerId, itemId, qty, now);
    }

    for (const kc of sub.killCounts) {
      stmts.upsertKillCount.run({ playerId, name: kc.name.toLowerCase(), kc: kc.kc ?? null, pb: kc.pb ?? null, now });
    }

    for (const lu of sub.levelUps) {
      if (lu.at <= now + MAX_CLOCK_SKEW_MS) stmts.insertLevelUp.run(playerId, lu.skill, lu.level, lu.at);
    }

    for (const q of sub.quests) {
      const sane = (t: number | null | undefined) => (t != null && t <= now + MAX_CLOCK_SKEW_MS ? t : null);
      stmts.upsertQuest.run({
        playerId, id: q.id, name: q.name, state: q.state, now,
        startedAt: sane(q.startedAt), completedAt: sane(q.completedAt),
        elapsedMs: q.elapsedMs ?? null, playedMs: q.playedMs ?? null,
      });
    }
    if (sub.quests.length > 0) {
      stmts.updateQuestCount.run({ playerId, full: sub.quests.length >= FULL_QUEST_LIST ? 1 : 0, now });
    }

    if (sub.lootSources.length > 0) stmts.updateTotals.run({ playerId });
    return result;
  });

  return (sub: Submission, token: string | undefined, now = Date.now()) => apply(sub, token, now);
}
