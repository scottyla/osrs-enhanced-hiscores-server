import { SKILLS } from './boards.ts';

// Wire format for POST /api/v1/submit. Must match plugin/src/main/java/com/osrsenhancedhiscores/Submission.java.

export interface ItemInfo {
  name: string;
  gePrice: number;
  haPrice: number;
}

export const GAME_MODES = ['NORMAL', 'HARDCORE_MAIN', 'FRESH_START_WORLD', 'SEASONAL', 'DEADMAN'] as const;

export interface Stats {
  /** Skill name to [level, xp] */
  skills?: Record<string, [number, number]>;
  combatLevel?: number | null;
  questPoints?: number | null;
  collectionLogObtained?: number | null;
  collectionLogTotal?: number | null;
  collectionLogCategories?: Record<string, [number, number]>;
  playtimeMinutes?: number | null;
  diaries?: Record<string, number[]>;
  combatAchievementPoints?: number | null;
  combatAchievementTasks?: number | null;
  slayerPoints?: number | null;
  slayerStreak?: number | null;
}

export interface KillCount {
  name: string;
  kc?: number | null;
  /** seconds */
  pb?: number | null;
}

export interface LevelUp {
  skill: string;
  level: number;
  at: number;
}

export interface LootSource {
  type: string;
  name: string;
  kills: number;
  first?: number | null;
  last?: number | null;
  /** Flattened [itemId, qty, itemId, qty, ...] */
  drops: number[];
}

export interface Drop {
  id: string;
  type: string;
  name: string;
  combatLevel: number;
  amount: number;
  timestamp: number;
  world: number;
  items: [number, number][];
}

export const QUEST_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'FINISHED'] as const;

export interface QuestProgress {
  id: number;
  name: string;
  state: (typeof QUEST_STATES)[number];
  startedAt?: number | null;
  completedAt?: number | null;
  elapsedMs?: number | null;
  playedMs?: number | null;
}

export interface Submission {
  accountHash: string;
  username: string;
  accountType: number;
  profileType: string;
  gameMode: (typeof GAME_MODES)[number];
  stats?: Stats | null;
  items: Record<string, ItemInfo>;
  lootSources: LootSource[];
  drops: Drop[];
  collectionLogItems: [number, number][];
  quests: QuestProgress[];
  killCounts: KillCount[];
  levelUps: LevelUp[];
}

const INT32 = 2_147_483_647;
const int = (max = INT32) => ({ type: 'integer', minimum: 0, maximum: max });
const nullableInt = (max = INT32) => ({ type: ['integer', 'null'], minimum: 0, maximum: max });
const itemPair = { type: 'array', minItems: 2, maxItems: 2, items: int() };
const sourceType = { type: 'string', pattern: '^[A-Z_]{1,20}$' };
const sourceName = { type: 'string', minLength: 1, maxLength: 100 };

export const submissionSchema = {
  type: 'object',
  required: ['accountHash', 'username', 'accountType', 'profileType', 'gameMode'],
  additionalProperties: false,
  properties: {
    accountHash: { type: 'string', pattern: '^-?[0-9]{1,20}$' },
    // OSRS names are 1-12 chars of letters, digits, spaces, hyphens and underscores.
    username: { type: 'string', pattern: '^[A-Za-z0-9 _\\-\\u00a0]{1,12}$' },
    accountType: int(10),
    profileType: { type: 'string', pattern: '^[A-Z0-9_]{1,40}$' },
    gameMode: { type: 'string', enum: GAME_MODES },
    stats: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        skills: {
          type: 'object',
          propertyNames: { enum: SKILLS },
          additionalProperties: {
            type: 'array', minItems: 2, maxItems: 2,
            items: [{ type: 'integer', minimum: 1, maximum: 126 }, int(200_000_000)],
          },
        },
        combatLevel: { type: ['integer', 'null'], minimum: 3, maximum: 126 },
        questPoints: nullableInt(1000),
        collectionLogObtained: nullableInt(10_000),
        collectionLogTotal: nullableInt(10_000),
        collectionLogCategories: {
          type: 'object',
          maxProperties: 20,
          propertyNames: { maxLength: 30 },
          additionalProperties: { type: 'array', minItems: 2, maxItems: 2, items: int(10_000) },
        },
        playtimeMinutes: nullableInt(),
        diaries: {
          type: 'object',
          maxProperties: 20,
          propertyNames: { maxLength: 40 },
          additionalProperties: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'integer', enum: [0, 1] } },
        },
        combatAchievementPoints: nullableInt(100_000),
        combatAchievementTasks: nullableInt(10_000),
        slayerPoints: nullableInt(),
        slayerStreak: nullableInt(),
      },
    },
    items: {
      type: 'object',
      maxProperties: 20_000,
      propertyNames: { pattern: '^[0-9]{1,7}$' },
      additionalProperties: {
        type: 'object',
        required: ['name', 'gePrice', 'haPrice'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 100 },
          gePrice: int(Number.MAX_SAFE_INTEGER),
          haPrice: int(Number.MAX_SAFE_INTEGER),
        },
      },
      default: {},
    },
    lootSources: {
      type: 'array',
      maxItems: 200,
      default: [],
      items: {
        type: 'object',
        required: ['type', 'name', 'kills', 'drops'],
        additionalProperties: false,
        properties: {
          type: sourceType,
          name: sourceName,
          kills: int(),
          first: { type: ['integer', 'null'] },
          last: { type: ['integer', 'null'] },
          drops: { type: 'array', maxItems: 10_000, items: int() },
        },
      },
    },
    drops: {
      type: 'array',
      maxItems: 500,
      default: [],
      items: {
        type: 'object',
        required: ['id', 'type', 'name', 'combatLevel', 'amount', 'timestamp', 'world', 'items'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
          type: sourceType,
          name: sourceName,
          combatLevel: { type: 'integer', minimum: -1, maximum: 10_000 },
          amount: int(),
          timestamp: { type: 'integer', minimum: 0 },
          world: int(100_000),
          items: { type: 'array', minItems: 1, maxItems: 200, items: itemPair },
        },
      },
    },
    collectionLogItems: { type: 'array', maxItems: 5000, default: [], items: itemPair },
    killCounts: {
      type: 'array',
      maxItems: 2000,
      default: [],
      items: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          kc: nullableInt(),
          pb: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 10_000_000 },
        },
      },
    },
    levelUps: {
      type: 'array',
      maxItems: 1000,
      default: [],
      items: {
        type: 'object',
        required: ['skill', 'level', 'at'],
        additionalProperties: false,
        properties: {
          skill: { type: 'string', enum: SKILLS },
          level: { type: 'integer', minimum: 2, maximum: 126 },
          at: { type: 'integer', minimum: 0 },
        },
      },
    },
    quests: {
      type: 'array',
      maxItems: 500,
      default: [],
      items: {
        type: 'object',
        required: ['id', 'name', 'state'],
        additionalProperties: false,
        properties: {
          id: int(100_000),
          name: { type: 'string', minLength: 1, maxLength: 100 },
          state: { type: 'string', enum: QUEST_STATES },
          startedAt: { type: ['integer', 'null'], minimum: 0 },
          completedAt: { type: ['integer', 'null'], minimum: 0 },
          elapsedMs: { type: ['integer', 'null'], minimum: 0 },
          playedMs: { type: ['integer', 'null'], minimum: 0 },
        },
      },
    },
  },
} as const;
