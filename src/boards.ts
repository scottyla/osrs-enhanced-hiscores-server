// Hiscore boards, mirroring the official OSRS hiscores' game modes.
//
// A board is a filter over `players`. Like the official hiscores, a player can be on several boards:
// a hardcore ironman shows on Normal, Ironman and Hardcore Ironman.

/** IRONMAN varbit values. */
export const ACCOUNT_TYPE = {
  REGULAR: 0, IRONMAN: 1, ULTIMATE: 2, HARDCORE: 3, GROUP: 4, HARDCORE_GROUP: 5, UNRANKED_GROUP: 6,
} as const;

export interface Board {
  id: string;
  label: string;
  group: string;
  /** SQL predicate over the `players` table aliased as `p`. Only static SQL; never user input. */
  where: string;
  /** Boards for one league/Deadman season at a time. The newest season is used unless one is requested. */
  seasonal?: string;
}

const MAIN = "p.realm = 'STANDARD' AND p.game_mode = 'NORMAL'";
const T = ACCOUNT_TYPE;

export const BOARDS: Board[] = [
  { id: 'normal', label: 'Normal', group: 'Main game', where: MAIN },
  { id: 'ironman', label: 'Ironman', group: 'Ironman', where: `${MAIN} AND p.account_type IN (${T.IRONMAN}, ${T.ULTIMATE}, ${T.HARDCORE})` },
  { id: 'ultimate', label: 'Ultimate Ironman', group: 'Ironman', where: `${MAIN} AND p.account_type = ${T.ULTIMATE}` },
  { id: 'hardcore_ironman', label: 'Hardcore Ironman', group: 'Ironman', where: `${MAIN} AND p.account_type = ${T.HARDCORE}` },
  { id: 'group_ironman', label: 'Group Ironman', group: 'Group Ironman', where: `${MAIN} AND p.account_type IN (${T.GROUP}, ${T.HARDCORE_GROUP}, ${T.UNRANKED_GROUP})` },
  { id: 'hardcore_group_ironman', label: 'Hardcore Group Ironman', group: 'Group Ironman', where: `${MAIN} AND p.account_type = ${T.HARDCORE_GROUP}` },
  { id: 'hardcore_worlds', label: 'Hardcore Worlds', group: 'Game modes', where: "p.realm = 'STANDARD' AND p.game_mode = 'HARDCORE_MAIN'" },
  { id: 'fresh_start', label: 'Fresh Start Worlds', group: 'Game modes', where: "p.game_mode = 'FRESH_START_WORLD'" },
  { id: 'leagues', label: 'Leagues', group: 'Seasonal', where: "p.game_mode = 'SEASONAL'", seasonal: 'SEASONAL' },
  { id: 'deadman', label: 'Deadman', group: 'Seasonal', where: "p.game_mode = 'DEADMAN'", seasonal: 'DEADMAN' },
  // Account builds, like the official Skillers and 1 Defence boards.
  { id: 'skiller', label: 'Level 3 Skillers', group: 'Account builds', where: `${MAIN} AND p.combat_level = 3` },
  { id: 'one_defence', label: '1 Defence', group: 'Account builds', where: `${MAIN} AND p.defence_level = 1 AND p.combat_level > 3` },
];

export const BOARD_IDS = BOARDS.map((b) => b.id);
export const boardById = (id: string) => BOARDS.find((b) => b.id === id);

/** Skills in the official hiscores' order. Matches RuneLite's Skill enum names. */
export const SKILLS = [
  'ATTACK', 'DEFENCE', 'STRENGTH', 'HITPOINTS', 'RANGED', 'PRAYER', 'MAGIC', 'COOKING', 'WOODCUTTING',
  'FLETCHING', 'FISHING', 'FIREMAKING', 'CRAFTING', 'SMITHING', 'MINING', 'HERBLORE', 'AGILITY', 'THIEVING',
  'SLAYER', 'FARMING', 'RUNECRAFT', 'HUNTER', 'CONSTRUCTION', 'SAILING',
] as const;

/** Player-level categories (columns on `players`). */
export const STAT_CATEGORIES = {
  loot_value: { column: 'loot_value', label: 'Loot value' },
  total_kills: { column: 'total_kills', label: 'Kills' },
  collection_log: { column: 'clog_obtained', label: 'Collection log' },
  quest_points: { column: 'quest_points', label: 'Quest points' },
  playtime: { column: 'playtime_minutes', label: 'Hours played' },
  quests_completed: { column: 'quests_completed', label: 'Quests completed' },
  diaries: { column: 'diaries_completed', label: 'Achievement diaries' },
  ca_points: { column: 'ca_points', label: 'Combat achievements' },
  slayer_points: { column: 'slayer_points', label: 'Slayer points' },
  slayer_streak: { column: 'slayer_streak', label: 'Slayer task streak' },
} as const;
export type StatCategory = keyof typeof STAT_CATEGORIES;
