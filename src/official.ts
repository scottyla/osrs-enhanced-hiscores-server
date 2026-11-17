// Lookups against the official Old School hiscores (Jagex), so player pages can show real official
// ranks next to the extra data from the plugin. Results are cached and outbound requests are limited,
// so page views don't turn into a stream of requests to Jagex.

import { usernameKey } from './db.ts';

/** Our board -> the official hiscores table that matches it. */
export const OFFICIAL_ENDPOINTS: Record<string, string> = {
  normal: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  ultimate: 'hiscore_oldschool_ultimate',
  hardcore_ironman: 'hiscore_oldschool_hardcore_ironman',
  // Group ironmen are ranked by group officially; individually they appear on the main hiscores.
  group_ironman: 'hiscore_oldschool',
  hardcore_group_ironman: 'hiscore_oldschool',
  hardcore_worlds: 'hiscore_oldschool_hardcore_mains',
  fresh_start: 'hiscore_oldschool_fresh_start',
  leagues: 'hiscore_oldschool_seasonal',
  deadman: 'hiscore_oldschool_deadman',
  skiller: 'hiscore_oldschool_skiller',
  one_defence: 'hiscore_oldschool_skiller_defence',
};

const BASE = 'https://secure.runescape.com/m=';
const USER_AGENT = 'OSRS-Enhanced-Hiscores/1.0 (+https://osrsenhancedhiscores.com)';

export interface OfficialSkill { skill: string; rank: number | null; level: number; xp: number }
export interface OfficialActivity { name: string; rank: number | null; score: number }
export interface OfficialResult {
  found: boolean;
  board: string;
  endpoint: string;
  /** Link to the player's page on the official site. */
  url: string;
  name?: string;
  skills?: OfficialSkill[];
  /** Only activities/bosses the player has a score in. */
  activities?: OfficialActivity[];
  fetchedAt: number;
}

export class OfficialUnavailable extends Error {}

interface RawEntry { name?: unknown; rank?: unknown; level?: unknown; xp?: unknown; score?: unknown }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -1);
/** Jagex uses -1 for "not ranked". */
const rankOf = (v: unknown) => (num(v) > 0 ? num(v) : null);

export function parseOfficial(body: unknown): { name?: string; skills: OfficialSkill[]; activities: OfficialActivity[] } {
  const d = body as { name?: unknown; skills?: RawEntry[]; activities?: RawEntry[] };
  if (!d || !Array.isArray(d.skills) || !Array.isArray(d.activities)) throw new OfficialUnavailable('Unexpected official hiscores response');
  return {
    name: typeof d.name === 'string' ? d.name : undefined,
    skills: d.skills.map((s) => ({
      skill: String(s.name ?? '').toUpperCase(),
      rank: rankOf(s.rank),
      level: Math.max(num(s.level), 1),
      xp: Math.max(num(s.xp), 0),
    })),
    activities: d.activities
      .map((a) => ({ name: String(a.name ?? ''), rank: rankOf(a.rank), score: num(a.score) }))
      // Jagex lists every activity; keep ones the player is actually ranked in or has a score for.
      .filter((a) => a.name && (a.rank != null || a.score > 0)),
  };
}

export interface OfficialOptions {
  fetchImpl?: typeof fetch;
  /** How long a lookup is reused (found or not found). */
  ttlMs?: number;
  /** How long to remember that Jagex was unreachable before trying again. */
  errorTtlMs?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  maxEntries?: number;
}

export function createOfficial({
  fetchImpl = fetch, ttlMs = 10 * 60_000, errorTtlMs = 30_000, maxConcurrent = 4, timeoutMs = 8_000, maxEntries = 5_000,
}: OfficialOptions = {}) {
  const cache = new Map<string, { at: number; result?: OfficialResult; error?: boolean }>();
  const inFlight = new Map<string, Promise<OfficialResult>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = () => new Promise<void>((resolve) => {
    if (active < maxConcurrent) { active++; resolve(); } else waiting.push(() => { active++; resolve(); });
  });
  const release = () => { active--; waiting.shift()?.(); };

  async function fetchOne(username: string, board: string, endpoint: string): Promise<OfficialResult> {
    const url = `${BASE}${endpoint}/hiscorepersonal?user1=${encodeURIComponent(username)}`;
    const api = `${BASE}${endpoint}/index_lite.json?player=${encodeURIComponent(username)}`;
    await acquire();
    try {
      const res = await fetchImpl(api, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { found: false, board, endpoint, url, fetchedAt: Date.now() };
      if (!res.ok) throw new OfficialUnavailable(`Official hiscores returned HTTP ${res.status}`);
      const parsed = parseOfficial(await res.json());
      return { found: true, board, endpoint, url, ...parsed, name: parsed.name ?? username, fetchedAt: Date.now() };
    } catch (e) {
      if (e instanceof OfficialUnavailable) throw e;
      throw new OfficialUnavailable('Official hiscores are unreachable right now');
    } finally {
      release();
    }
  }

  return {
    /** Official hiscores for a player on the official table matching our board. */
    async get(username: string, board: string): Promise<OfficialResult> {
      const endpoint = OFFICIAL_ENDPOINTS[board] ?? OFFICIAL_ENDPOINTS.normal;
      const key = `${endpoint}|${usernameKey(username)}`;
      const hit = cache.get(key);
      const now = Date.now();
      if (hit?.result && now - hit.at < ttlMs) return { ...hit.result, board };
      if (hit?.error && now - hit.at < errorTtlMs) throw new OfficialUnavailable('Official hiscores are unreachable right now');

      let pending = inFlight.get(key);
      if (!pending) {
        pending = fetchOne(username, board, endpoint)
          .then((result) => { cache.set(key, { at: Date.now(), result }); return result; })
          .catch((e) => { cache.set(key, { at: Date.now(), error: true }); throw e; })
          .finally(() => {
            inFlight.delete(key);
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
          });
        inFlight.set(key, pending);
      }
      return { ...(await pending), board };
    },
  };
}
