/**
 * Sliding-window counter keyed by an arbitrary string (client IP, player id).
 * `hit(key)` records one event and returns false when the key already has
 * `limit` events inside the last `windowMs`. Keys with no live events are
 * dropped on each hit (and on `prune`) so the map stays bounded by the number
 * of keys active within one window.
 */
export class SlidingWindow {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  hit(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let times = this.hits.get(key);
    if (times) {
      let drop = 0;
      while (drop < times.length && times[drop] <= cutoff) drop++;
      if (drop > 0) times.splice(0, drop);
    } else {
      times = [];
      this.hits.set(key, times);
    }
    if (times.length >= this.limit) return false;
    times.push(now);
    return true;
  }

  /** Drop every key whose events all fell out of the window. */
  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
