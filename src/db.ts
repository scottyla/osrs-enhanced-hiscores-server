import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA_VERSION = 4;

const SCHEMA = `
-- One row per character per RuneScape profile. Leagues/Deadman are separate profiles with their own
-- data, so the same account hash can have a STANDARD row and a league row.
CREATE TABLE IF NOT EXISTS players (
  id               INTEGER PRIMARY KEY,
  account_hash     TEXT NOT NULL,
  realm            TEXT NOT NULL,           -- RuneLite RuneScapeProfileType, e.g. STANDARD
  game_mode        TEXT NOT NULL,           -- NORMAL, HARDCORE_MAIN, FRESH_START_WORLD, SEASONAL, DEADMAN
  username         TEXT NOT NULL,
  username_key     TEXT NOT NULL,
  account_type     INTEGER NOT NULL DEFAULT 0,
  token_hash       TEXT,
  total_level      INTEGER,
  total_xp         INTEGER,
  combat_level     INTEGER,
  defence_level    INTEGER,
  quest_points     INTEGER,
  clog_obtained    INTEGER,
  clog_total       INTEGER,
  clog_categories  TEXT,
  playtime_minutes INTEGER,
  quests_completed INTEGER,
  ca_points        INTEGER,
  ca_tasks         INTEGER,
  slayer_points    INTEGER,
  slayer_streak    INTEGER,
  diaries          TEXT,                    -- JSON: region -> [easy, medium, hard, elite] as 0/1
  diaries_completed INTEGER,                -- number of diary tiers complete (of 48)
  -- Denormalised loot totals so hiscores don't aggregate every player's loot per request.
  loot_value       INTEGER NOT NULL DEFAULT 0,
  total_kills      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (account_hash, realm)
);
CREATE INDEX IF NOT EXISTS players_username ON players(username_key, realm);
CREATE INDEX IF NOT EXISTS players_mode ON players(realm, game_mode, account_type);

CREATE TABLE IF NOT EXISTS player_skills (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill     TEXT NOT NULL,
  level     INTEGER NOT NULL,
  xp        INTEGER NOT NULL,
  PRIMARY KEY (player_id, skill)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS player_skills_rank ON player_skills(skill, xp DESC);

CREATE TABLE IF NOT EXISTS items (
  item_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  ge_price   INTEGER NOT NULL DEFAULT 0,
  ha_price   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loot_sources (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kills      INTEGER NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  first_at   INTEGER,
  last_at    INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (player_id, type, name)
);
CREATE INDEX IF NOT EXISTS loot_sources_rank ON loot_sources(type, name, kills DESC);

CREATE TABLE IF NOT EXISTS loot_items (
  source_id INTEGER NOT NULL REFERENCES loot_sources(id) ON DELETE CASCADE,
  item_id   INTEGER NOT NULL,
  quantity  INTEGER NOT NULL,
  PRIMARY KEY (source_id, item_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS drops (
  id           TEXT PRIMARY KEY,
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  combat_level INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  timestamp    INTEGER NOT NULL,
  world        INTEGER NOT NULL,
  items        TEXT NOT NULL,
  value        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drops_by_player ON drops(player_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS player_quests (
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quest_id     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  state        TEXT NOT NULL,           -- NOT_STARTED, IN_PROGRESS, FINISHED
  started_at   INTEGER,                 -- only known for quests started while the plugin was running
  completed_at INTEGER,                 -- only known for completions the plugin saw
  elapsed_ms   INTEGER,                 -- real time from start to completion
  played_ms    INTEGER,                 -- logged-in time from start to completion
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, quest_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS player_quests_speed ON player_quests(quest_id, played_ms);

-- Official kill counts and personal bests (from RuneLite's Chat Commands plugin) and clue completions.
CREATE TABLE IF NOT EXISTS player_killcounts (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                 -- lowercase, e.g. 'zulrah', 'clue scrolls (elite)'
  kc         INTEGER,
  pb_seconds REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS player_killcounts_kc ON player_killcounts(name, kc DESC);
CREATE INDEX IF NOT EXISTS player_killcounts_pb ON player_killcounts(name, pb_seconds);

-- Levels gained while the plugin was running.
CREATE TABLE IF NOT EXISTS player_level_ups (
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill       TEXT NOT NULL,
  level       INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, skill, level)
) WITHOUT ROWID;

-- XP at the first submission of each UTC day: the baseline for day/week/month gains.
CREATE TABLE IF NOT EXISTS xp_daily (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  total_xp  INTEGER NOT NULL,
  skills    TEXT NOT NULL,                  -- JSON: skill -> xp
  PRIMARY KEY (player_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS collection_log_items (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL,
  quantity   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, item_id)
) WITHOUT ROWID;
`;

const OLD_TABLES = ['collection_log_items', 'drops', 'loot_items', 'loot_sources', 'player_skills', 'items', 'players'];

/** Additive migrations, keyed by the version they upgrade to. Run in order for existing databases. */
const MIGRATIONS: Record<number, string> = {
  3: 'ALTER TABLE players ADD COLUMN quests_completed INTEGER;',
  4: `ALTER TABLE players ADD COLUMN ca_points INTEGER;
      ALTER TABLE players ADD COLUMN ca_tasks INTEGER;
      ALTER TABLE players ADD COLUMN slayer_points INTEGER;
      ALTER TABLE players ADD COLUMN slayer_streak INTEGER;
      ALTER TABLE players ADD COLUMN diaries TEXT;
      ALTER TABLE players ADD COLUMN diaries_completed INTEGER;`,
};

/** Indexes on columns added by migrations; created after migrating. */
const POST_MIGRATION = `
CREATE INDEX IF NOT EXISTS players_quests ON players(quests_completed DESC);
CREATE INDEX IF NOT EXISTS players_ca ON players(ca_points DESC);
CREATE INDEX IF NOT EXISTS players_diaries ON players(diaries_completed DESC);
`;

export function openDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  let version = db.pragma('user_version', { simple: true }) as number;
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'players'").get();
  if (hasTables && version < 2) {
    // Version 1 was pre-release (one row per account, no game modes). Nothing worth migrating.
    console.warn(`Database schema v${version} is from a pre-release build; recreating it.`);
    db.pragma('foreign_keys = OFF');
    for (const t of OLD_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.pragma('foreign_keys = ON');
  }

  const fresh = !hasTables || version < 2;
  db.transaction(() => {
    db.exec(SCHEMA);
    if (!fresh) {
      for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
        if (MIGRATIONS[v]) db.exec(MIGRATIONS[v]);
      }
    }
    db.exec(POST_MIGRATION);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  return db;
}

/** Normalise an OSRS display name for lookups: case-insensitive, and _ - nbsp treated as spaces. */
export function usernameKey(name: string): string {
  return name.replace(/[_\- ]/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}
