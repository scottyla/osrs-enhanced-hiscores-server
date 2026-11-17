// Per-key token buckets, used to cap how often one character can submit regardless of IP.
// A normal plugin sends about once every 2 minutes plus a short burst at login.

export interface Bucket { tokens: number; at: number }

export function createRateLimiter({ capacity, refillMs, maxKeys = 200_000 }: { capacity: number; refillMs: number; maxKeys?: number }) {
  const buckets = new Map<string, Bucket>();
  return {
    /** Take one token for `key`. Returns 0 if allowed, otherwise the seconds until a token is free. */
    take(key: string, now = Date.now()): number {
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) {
          // Drop idle buckets (full ones carry no state worth keeping).
          for (const [k, v] of buckets) if (v.tokens + (now - v.at) / refillMs >= capacity) buckets.delete(k);
        }
        b = { tokens: capacity, at: now };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + (now - b.at) / refillMs);
      b.at = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return 0;
      }
      return Math.ceil(((1 - b.tokens) * refillMs) / 1000);
    },
  };
}
