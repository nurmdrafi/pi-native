/**
 * Spawn concurrency queue — caps how many subagents run at once.
 *
 * Parallel spawns share one provider quota; several simultaneous children
 * exhaust it (429 storms) and every run slows to retry backoff. Acquire a
 * slot before launching a child, release when its watcher settles.
 *
 * `PI_SUBAGENT_MAX_CONCURRENT` sets the cap (default 3); values < 1 mean
 * unlimited. FIFO wakeup on release.
 */

export function resolveMaxConcurrent(raw: string | undefined, fallback = 3): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export class SpawnQueue {
  private readonly max: number;
  private active = 0;
  private waiters: Array<() => void> = [];
  private drainHook: (() => void) | null = null;

  constructor(max: number) {
    this.max = Math.floor(max);
  }

  /** Subagents currently holding a slot. */
  get running(): number {
    return this.active;
  }

  /** Spawns waiting for a slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Resolves when a slot is free. */
  async acquire(): Promise<void> {
    if (this.max < 1 || this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  /** Free one slot and wake the oldest waiter, or — when no waiter — run the
   * drain hook so queued (non-blocking) spawns can launch. */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
    else this.drainHook?.();
  }

  /** Non-blocking slot claim: true when a slot was free, false when the cap
   *  is reached — callers queue instead of awaiting acquire(). */
  tryAcquire(): boolean {
    if (this.max < 1 || this.active < this.max) {
      this.active += 1;
      return true;
    }
    return false;
  }

  /** Called on release when no promise waiter consumed the slot — lets the
   *  spawn path drain its FIFO of queued launches without blocking a turn. */
  setDrainHook(fn: (() => void) | null): void {
    this.drainHook = fn;
  }

  /** Test-only: drop all state. Real watchers settle asynchronously, so a
   *  suite cannot otherwise start from a known slot count. */
  resetForTest(): void {
    this.active = 0;
    this.waiters = [];
  }
}
