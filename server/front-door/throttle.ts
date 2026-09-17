/** Fixed-window login throttle (per IP) — hardening for the internet move.
 * Counts every /api/login attempt against the caller's IP; once the window's
 * cap is spent, further attempts are pre-empted before the token check. */

export interface ThrottleVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

export function createLoginThrottle(opts?: { max?: number; windowMs?: number; now?: () => number }) {
  const max = opts?.max ?? 20;
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const now = opts?.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key: string): ThrottleVerdict {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.set(key, w);
        // Lazy sweep so hammering many throwaway IPs cannot grow the map.
        if (windows.size > 1000) for (const [k, x] of windows) if (t - x.start >= windowMs) windows.delete(k);
      }
      if (w.count >= max) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
      w.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}