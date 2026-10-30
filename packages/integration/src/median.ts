/** Median of a non-empty list (mean of the two middle values for even lengths). */
export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError("median of empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Fixed-window rolling median. One thin-market spot read can be pushed
 * arbitrarily far for a few seconds; the median of the last `window` polls
 * only moves once more than half the window agrees, so a manipulator has to
 * hold the price for ≥ window/2 polls to move the value we publish at all.
 */
export class RollingMedian {
  readonly window: number;
  private readonly values: number[] = [];

  constructor(window: number) {
    if (!Number.isInteger(window) || window < 1) throw new RangeError(`window must be a positive integer, got ${window}`);
    this.window = window;
  }

  get size(): number {
    return this.values.length;
  }

  /** Current median, or null before the first push. */
  get value(): number | null {
    return this.values.length === 0 ? null : median(this.values);
  }

  /** Append a sample (non-finite or non-positive samples are ignored) and return the new median. */
  push(sample: number): number | null {
    if (Number.isFinite(sample) && sample > 0) {
      this.values.push(sample);
      if (this.values.length > this.window) this.values.shift();
    }
    return this.value;
  }
}
