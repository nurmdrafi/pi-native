/**
 * Spawn concurrency queue — caps how many subagents run at once.
 *
 * Parallel spawns share one provider quota; several simultaneous children
 * exhaust it (429 storms) and every run slows to retry backoff. Acquire a
 * slot before launching a child, release when its watcher settles.
 *
 * `PI_SUBAGENT_MAX_CONCURRENT` sets the cap (default 5); values < 1 mean
 * unlimited. FIFO wakeup on release.
 */

export function resolveMaxConcurrent(raw: string | undefined, fallback = 5): number {
  const n = raw == null || raw.trim() === "" ? fallback : Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

// ── Declared file-scope locks (beside the slot counter) ──
//
// Only DECLARED write scopes (the spawn tool's `files` param) live here.
// Queued and running reservations both participate: a spawn parked behind an
// owner owns its paths just as firmly, so a third colliding spawn queues
// behind it even while slots are free. Parsed task-text scope never locks.

import { scopePathsOverlap } from "./scope.ts";

export interface ScopeReservation {
  /** Display name of the owning subagent. */
  name: string;
  /** Absolute, normalized paths (a directory owns its subtree). */
  paths: string[];
  state: "queued" | "running";
}

const scopeReservations = new Map<string, ScopeReservation>();
let scopeDrainHook: (() => void) | null = null;

/** Called when a scope frees so parked spawns can launch even though no
 * slot was released — a spawn waiting on an OWNER (not a slot) otherwise
 * has nothing to wake it. */
export function setScopeDrainHook(fn: (() => void) | null): void {
  scopeDrainHook = fn;
}

/** Reserve (or update) a declared write scope. Upsert by id: the queued →
 * running transition at launch re-declares with the same id. */
export function declareScope(id: string, reservation: ScopeReservation): void {
  scopeReservations.set(id, { name: reservation.name, paths: [...reservation.paths], state: reservation.state });
}

/** Drop a scope reservation. Idempotent. Removing a live reservation fires
 * the scope drain hook synchronously — parked spawns get their wakeup. */
export function releaseScope(id: string): boolean {
  if (!scopeReservations.delete(id)) return false;
  scopeDrainHook?.();
  return true;
}

/** Declared-scope conflicts for the given absolute normalized paths: every
 * reservation (queued or running) whose paths segment-prefix-overlap them.
 * `hits` are the caller's paths that overlap the owner's scope. `excludeId`
 * skips the caller's OWN reservation — a parked spawn re-checking conflicts
 * must not collide with itself. */
export function findConflicts(
  paths: string[],
  excludeId?: string,
): Array<{ id: string; name: string; hits: string[] }> {
  const conflicts: Array<{ id: string; name: string; hits: string[] }> = [];
  for (const [id, res] of scopeReservations) {
    if (excludeId !== undefined && id === excludeId) continue;
    const hits = paths.filter((p) => res.paths.some((s) => scopePathsOverlap(p, s)));
    if (hits.length > 0) conflicts.push({ id, name: res.name, hits });
  }
  return conflicts;
}

/** Snapshot of every declared scope reservation — exposure (subagents_list)
 * and tests. */
export function scopedChildren(): Array<{ id: string; name: string; paths: string[]; state: "queued" | "running" }> {
  return [...scopeReservations.entries()].map(([id, r]) => ({
    id,
    name: r.name,
    paths: [...r.paths],
    state: r.state,
  }));
}

/** Test-only: drop all reservations WITHOUT firing the drain hook. */
export function resetScopeRegistry(): void {
  scopeReservations.clear();
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
