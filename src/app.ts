import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.ts';
import { BOARD_IDS, SKILLS, STAT_CATEGORIES, type StatCategory } from './boards.ts';
import { createIngest, IngestError } from './ingest.ts';
import { createQueries, QueryError, type Category, type Period } from './queries.ts';
import { submissionSchema, type Submission } from './validate.ts';

export interface AppOptions {
  db: DB;
  logger?: boolean;
  /** Set when running behind a reverse proxy so rate limits use the real client IP. */
  trustProxy?: boolean;
  /** Plugin submissions allowed per IP per minute. */
  submitRateLimit?: number;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' https://static.runelite.net data:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Shared querystring pieces.
const board = { type: 'string', enum: BOARD_IDS, default: 'normal' } as const;
const season = { type: 'string', pattern: '^[A-Z0-9_]{1,40}$' } as const;
const boardQuery = { type: 'object', properties: { board, season } } as const;
const nameParams = { type: 'object', required: ['username'], properties: { username: { type: 'string', minLength: 1, maxLength: 12 } } } as const;
const CATEGORY_PATTERN = `^(overall|source|quest|kc|gains|${Object.keys(STAT_CATEGORIES).join('|')}|skill:(${SKILLS.join('|')}))$`;

interface BoardQs { board: string; season?: string }

interface CategoryQs {
  category: string; type?: string; name?: string; metric?: string; quest?: number; period: Period; skill: string;
}

function parseCategory(q: CategoryQs): Category {
  if (q.category === 'overall') return { kind: 'overall' };
  if (q.category === 'kc') {
    if (!q.name) throw new QueryError(400, 'name is required for kill count hiscores');
    return { kind: 'kc', name: q.name.toLowerCase(), metric: q.metric === 'pb' ? 'pb' : 'kc' };
  }
  if (q.category === 'gains') return { kind: 'gains', period: q.period, skill: q.skill };
  if (q.category === 'quest') {
    if (q.quest == null) throw new QueryError(400, 'quest is required for quest hiscores');
    return { kind: 'quest', questId: q.quest };
  }
  if (q.category.startsWith('skill:')) return { kind: 'skill', skill: q.category.slice(6) };
  if (q.category === 'source') {
    if (!q.type || !q.name) throw new QueryError(400, 'type and name are required for source hiscores');
    return { kind: 'source', type: q.type, name: q.name, metric: q.metric === 'value' ? 'value' : 'kills' };
  }
  return { kind: 'stat', stat: q.category as StatCategory };
}

export async function buildApp({ db, logger = true, trustProxy = false, submitRateLimit = 30 }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Log requests without client IPs: the About page promises IPs aren't kept.
    logger: logger ? { serializers: { req: (req) => ({ method: req.method, url: req.url }) } } : false,
    trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  const ingest = createIngest(db);
  const q = createQueries(db);

  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply) => {
    // Leaderboards and player pages can be up to 30 s old; lets browsers/proxies absorb bursts of traffic.
    if (req.method === 'GET' && req.url.startsWith('/api/') && req.url !== '/api/health' && reply.statusCode === 200) {
      reply.header('Cache-Control', 'public, max-age=30');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof QueryError || err instanceof IngestError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err.validation) return reply.code(400).send({ error: err.message });
    if ((err.statusCode ?? 500) < 500) return reply.code(err.statusCode!).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  // ---- Plugin ingest ----

  app.post<{ Body: Submission }>('/api/v1/submit', {
    schema: { body: submissionSchema },
    config: { rateLimit: { max: submitRateLimit, timeWindow: '1 minute' } },
  }, async (req) => {
    const token = req.headers['x-hiscores-token'];
    const b = req.body;
    const result = ingest(b, typeof token === 'string' && token.length <= 128 ? token : undefined);
    req.log.info({
      player: b.username, profile: b.profileType, mode: b.gameMode, accountType: b.accountType,
      sources: b.lootSources.length, drops: b.drops.length, clogItems: b.collectionLogItems.length,
      stats: b.stats != null, claimed: result.token != null,
    }, 'submission');
    return { ok: true, ...result };
  });

  // ---- Dashboard API ----

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/boards', async () => q.boards());

  app.get<{ Querystring: BoardQs }>('/api/summary', { schema: { querystring: boardQuery } },
    async (req) => q.summary(req.query.board, req.query.season));

  app.get<{ Querystring: BoardQs }>('/api/sources', { schema: { querystring: boardQuery } },
    async (req) => q.sources(req.query.board, req.query.season));

  app.get<{ Querystring: { q: string } }>('/api/players', {
    schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 12 } } } },
  }, async (req) => q.search(req.query.q));

  app.get<{ Params: { username: string }; Querystring: BoardQs }>('/api/players/:username',
    { schema: { params: nameParams, querystring: boardQuery } },
    async (req) => q.player(req.params.username, req.query.board, req.query.season));

  app.get<{ Params: { username: string }; Querystring: BoardQs & { type: string; name: string } }>('/api/players/:username/loot/items', {
    schema: {
      params: nameParams,
      querystring: {
        type: 'object', required: ['type', 'name'],
        properties: { board, season, type: { type: 'string', maxLength: 20 }, name: { type: 'string', maxLength: 100 } },
      },
    },
  }, async (req) => q.sourceItems(req.params.username, req.query.board, req.query.season, req.query.type, req.query.name));

  app.get<{ Params: { username: string }; Querystring: BoardQs & { limit: number } }>('/api/players/:username/drops', {
    schema: {
      params: nameParams,
      querystring: { type: 'object', properties: { board, season, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => q.drops(req.params.username, req.query.board, req.query.season, req.query.limit));

  app.get<{ Params: { username: string }; Querystring: BoardQs }>('/api/players/:username/collection-log',
    { schema: { params: nameParams, querystring: boardQuery } },
    async (req) => q.collectionLog(req.params.username, req.query.board, req.query.season));

  app.get<{ Params: { username: string }; Querystring: BoardQs }>('/api/players/:username/quests',
    { schema: { params: nameParams, querystring: boardQuery } },
    async (req) => q.quests(req.params.username, req.query.board, req.query.season));

  app.get<{ Params: { username: string }; Querystring: BoardQs }>('/api/players/:username/killcounts',
    { schema: { params: nameParams, querystring: boardQuery } },
    async (req) => q.killCounts(req.params.username, req.query.board, req.query.season));

  app.get<{ Params: { username: string }; Querystring: BoardQs }>('/api/players/:username/progress',
    { schema: { params: nameParams, querystring: boardQuery } },
    async (req) => q.progress(req.params.username, req.query.board, req.query.season));

  app.get<{ Querystring: BoardQs }>('/api/killcounts', { schema: { querystring: boardQuery } },
    async (req) => q.killCountNames(req.query.board, req.query.season));

  app.get<{ Querystring: BoardQs }>('/api/quests', { schema: { querystring: boardQuery } },
    async (req) => q.timedQuests(req.query.board, req.query.season));

  app.get<{ Querystring: BoardQs & CategoryQs & { page: number } }>('/api/hiscores', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          board, season,
          category: { type: 'string', pattern: CATEGORY_PATTERN, default: 'overall' },
          page: { type: 'integer', minimum: 0, maximum: 4000, default: 0 },
          type: { type: 'string', maxLength: 20 },
          name: { type: 'string', maxLength: 100 },
          metric: { type: 'string', enum: ['kills', 'value', 'kc', 'pb'] },
          period: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' },
          skill: { type: 'string', pattern: `^(overall|${SKILLS.join('|')})$`, default: 'overall' },
          quest: { type: 'integer', minimum: 0, maximum: 100_000 },
        },
      },
    },
  }, async (req) => q.hiscores(req.query.board, req.query.season, parseCategory(req.query), req.query.page));

  // ---- Dashboard static files ----

  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public', import.meta.url)) });

  return app;
}
