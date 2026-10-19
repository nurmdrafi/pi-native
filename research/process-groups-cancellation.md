# Process-group management & graceful cancellation (macOS + Linux, Rust std-only)

Scope: how `pibash` should cancel/timeout a shell command tree, and how daemons should
avoid orphaning children, under these constraints: Rust std-only (`std::process` plus
`extern "C"` declarations), no `libc`/`nix`/`tokio::process`, identical behaviour expected
on macOS and Linux, daemons built `panic=abort` (so `Drop` is not a reliable cleanup hook).

## Provenance convention

Every claim carries one of:

- `[src: URL]` — rests on a source supplied with the task (man7/Ubuntu `PR_SET_PDEATHSIG`,
  the tokio issue, the SUSE guide, the iximiuz post, `processkit` docs, the Rust forum
  threads, the smackerelofopinion post, the dotnet/runtime issue).
- `[uncited]` — rests on general POSIX / Linux / Darwin / Rust knowledge or on reasoning
  about the design, **not** on a provided source.

Nothing here was fetched and read in this session; `[src: URL]` means "the supplied
material attributes this to that URL", not "I re-read that page". Every `[uncited]` claim is
also listed in the verification probes in section 7, because it is the audit list.

Portability rule applied throughout: **a Linux-only mechanism is never described as
portable.** `PR_SET_PDEATHSIG` in particular is marked Linux-only at every mention, and the
macOS substitute is described separately rather than as an equivalent.

---

## 1. Recommended cancellation / kill sequence

### 1.1 Actors

- **child** — the shell process spawned with `process_group(0)`, so its PGID equals its PID. `[uncited]`
- **group** — PGID == child PID; the shell plus everything it forked that did not move
  itself into another group. `[uncited]`
- **supervisor** — the daemon or extension thread holding the `Child` handle. `[uncited]`

### 1.2 State machine

```
RUNNING --cancel/timeout--> TERM_SENT --(group empty)--> REAPED --> ENVELOPE --> SPILL_CLEANED
                                |
                                +--(grace expired, members remain)--> KILL_SENT --> REAPED --> ...
                                |
                                +--(kill: ESRCH / waitpid: ECHILD)--> REAPED --> ...
                                |
                                +--(kill: EPERM)--> KILL_SENT (log ownership error)
```

### 1.3 Steps with error branches

**Step 0 — guard the group id.** Only signal when `pgid > 1` and `pgid != getpgrp()`. `[uncited]`

Two ways this goes wrong, both from `kill(2)` pid semantics: `kill(-0, SIGTERM)` is
`kill(0, SIGTERM)` and targets the *supervisor's own* group; and group ids are pids, so a
stale `-pgid` can name a different, unrelated group after pid reuse. `[uncited]`
If the guard fails, fall back to `Child::kill()` on the single pid, which is SIGKILL only
`[src: https://users.rust-lang.org/t/stop-child-process-without-using-kill/30359]`.

**Step 1 — TERM_SENT.** `kill(-pgid, SIGTERM)`, record `t_term`.
`ESRCH` → group already gone; jump to Step 4 with `Child::try_wait()`.
`EPERM` → we do not own the group (should be impossible for our own child); go to KILL_SENT
and record the error in the envelope. `[uncited]`

**Step 2 — grace window, reaping while waiting.** Poll
`waitpid(-pgid, &mut status, WNOHANG)` with a short sleep (~10–25 ms) until either
`waitpid` reports the group empty of our children, or `now - t_term >= GRACE`. `[uncited]`

Loop semantics that must be right:

- `WNOHANG` returning `0` means "children exist, none exited". It is neither completion nor
  error; treating it as completion collapses the grace window to a single poll. `[uncited]`
- `-1` with `ECHILD` is the success signal for "no children of ours left in that group".
  `[uncited]`
- `-1` with `EINTR` is retryable, not a failure. `[uncited]`
- Do not use a blocking `waitpid` on the direct child during grace: it removes the ability
  to bound the window. `[uncited]`

SIGTERM is cooperative — a well-behaved program exits quickly — while SIGKILL cannot be
caught, blocked, or ignored, and therefore gives the child no chance to clean up. The grace
window is the only opportunity for the child to remove its own temporary files. `[src: https://www.suse.com/blog/observability-sigkill-vs-sigterm-a-developers-guide-to-process-termination]`

Grace values are engineering judgement, not a sourced standard `[uncited]`:

| Situation | GRACE |
| --- | --- |
| Interactive / user-visible command | 1500–2000 ms |
| Daemon-internal batch child | 5000 ms |
| Child known to ignore SIGTERM (JVM, some daemons) | TERM, then KILL after ~250 ms |

**Step 3 — KILL_SENT.** `kill(-pgid, SIGKILL)`; `ESRCH` is success. Then a second *bounded*
reap loop (e.g. 2 s). SIGKILL cannot be ignored, but a process in uninterruptible sleep
still outlives it; on expiry, stop waiting and set `reap_unknown: true` in the envelope
rather than hanging the supervisor. `[uncited]`

**Step 4 — REAPED.** `Child::wait()` / `try_wait()` on the direct child, then emit the
original request's terminal envelope: exit code or terminating signal, `timed_out`,
`escalated`, `duration`, `reap_unknown`. Missing or deferred envelopes on the original
request path are the failure mode to design against. `[uncited]`

**Step 5 — cleanup.** Remove spill files as an explicit step in the same function, never in
`Drop` (section 6). `[uncited]`

### 1.4 Grandchildren

- A grandchild that stayed in the group receives the group signal, because signals sent to a
  process group reach its members. `[src: https://www.suse.com/blog/observability-sigkill-vs-sigterm-a-developers-guide-to-process-termination]`
- A grandchild that called `setsid()` or `setpgid()` has left the group and will not receive
  it. Unfixable at group level; the real Linux answers are cgroups (out of scope) and
  `PR_SET_CHILD_SUBREAPER` (Linux-only, section 2.5). `[uncited]`
- An orphaned grandchild is reparented to `init`/`launchd` or the nearest subreaper, so it is
  not our child and we cannot `waitpid` it. `[uncited]`

---

## 2. Orphan prevention when the supervisor dies

### 2.1 `PR_SET_PDEATHSIG` — semantics, and why it is not portable

**Linux-only. There is no macOS or BSD equivalent.** `[src: https://man7.org/linux/man-pages/man2/pr_set_pdeathsig.2const.html] [src: https://manpages.ubuntu.com/manpages/stonking/man2/PR_SET_PDEATHSIG.2const.html]`
Do not build a design that depends on it; it can only ever be an optional Linux hardening.

Caveats:

1. **It fires on termination of the parent _thread_, not the parent process.** The Ubuntu copy
   of the page states the signal is sent "upon subsequent termination of the parent thread".
   `[src: https://manpages.ubuntu.com/manpages/stonking/man2/PR_SET_PDEATHSIG.2const.html]`
   Consequence for us: the child is at risk if the *spawning thread* exits, even while the
   supervisor process lives — relevant because both the extension and the daemon are
   multi-threaded and a spawn can happen on a worker thread. `[uncited]`
2. **Arming race.** The signal is only armed once `prctl` has run in the child, before
   `exec`. If the parent dies between `fork` and that call, the child is never armed. The
   standard fix is to re-check the parent after arming:
   `prctl(PR_SET_PDEATHSIG, SIGTERM); if (getppid() != expected_parent) _exit(1);` `[uncited]`
3. **Cleared or not propagated in specific cases** (setuid/setgid `exec` among them). `[uncited]`
   Not a concern for `pibash` unless it ever execs a setuid binary — it should not.
4. **It signals the child only, not the group.** To get tree-wide effect on Linux the child
   would arm PDEATHSIG *and* live in its own group *and* re-broadcast the signal to
   `-getpgrp()`. `[uncited]`

### 2.2 macOS has no parent-death signal

`kqueue`'s `EVFILT_PROC` with `NOTE_EXIT` lets one process learn that *another* process
exited. That is the opposite direction from PDEATHSIG: it gives a survivor a detector, it
does not let a child self-arm to die with its parent. So it addresses "supervisor notices the
daemon died", not "child dies when supervisor dies". `[uncited]`

macOS options, preferred order `[uncited]`:

1. **Design out the dependency.** The daemon owns all children; give it a real shutdown path
   (signal handler plus the explicit sequence from section 1) instead of relying on the OS
   to clean up after an abrupt death.
2. **Watchdog pipe.** Supervisor and child share a pipe. A watchdog thread in the child does
   a blocking read; EOF means the supervisor is gone, and the child then
   `kill(0, SIGTERM)`s its own group. Works on both OSes, signals the group rather than a
   single pid, and has no arming race beyond pre-exec ordering. **This is the recommended
   mechanism, and the reason PDEATHSIG is optional rather than load-bearing.**
3. **Polling.** Child polls `getppid()`; parent polls `kill(parent_pid, 0)`. Latency equals
   the poll interval; a backstop, not the primary mechanism.
4. **Separate reaper process using `kqueue`.** Heaviest option; only if a reaper already
   exists.

### 2.3 Portability record

The .NET runtime hit the same wall: PDEATHSIG exists on Linux, cannot be expressed portably,
and the request documents that macOS needs something different. `[src: https://github.com/dotnet/runtime/issues/96470]`

### 2.4 When the supervisor is a child reaper

If the supervisor is responsible for reaping children after the direct child dies, note that
PDEATHSIG is one of the documented ways to get a child reaped in that arrangement.
`[src: http://smackerelofopinion.blogspot.com/2015/11/using-prsetpdeathsig-to-reap-child.html]`
That post is Linux-specific for the same reason as 2.1.

Overall treatment of termination and reaping in Linux, with Rust examples, is covered by
iximiuz. `[src: https://iximiuz.com/en/posts/dealing-with-processes-termination-in-Linux]`

### 2.5 `PR_SET_CHILD_SUBREAPER` (Linux-only, optional)

Making ourselves the subreaper turns "orphaned grandchildren reparented to PID 1" into
"reparented to us", at which point `waitpid(-pgid, WNOHANG)` in Step 2 really does reap the
whole tree. Linux-only; adds one `prctl` option; also makes us responsible for reaping
everything we inherit. `[uncited]`

---

## 3. Process-group kill pitfalls

### 3.1 The `setpgid` race

`setpgid` fails with `EACCES` once the child has `exec`ed. `[uncited]` Two consequences:

- For `pibash`'s shell children, `Command::process_group(0)` sets the group inside std's
  pre-exec window, so the race is closed by construction. `[uncited]`
- For the daemon's raw `extern "C" setpgid(0, 0)` path, the ordering must be
  fork → `setpgid` → `exec` with no user code in between. An `EACCES` there is a fatal spawn
  error, **not** a warning. `[uncited]`

The dangerous combination: parent's `setpgid` returns `EACCES`, the code logs and continues,
then `kill(-pgid)` targets a group the child was never in → `ESRCH`, no signal delivered,
child runs forever while the supervisor believes it terminated. Assert after spawn that the
child's PGID equals its PID (Linux `/proc/<pid>/stat` field 5; macOS `getpgid(pid)`).
`[uncited]`

### 3.2 Negative-pid semantics and the guard

`kill(-N, sig)` signals every process whose PGID is N. `kill(0, sig)` / `kill(-0, sig)`
signals the caller's own group. `kill(-1, sig)` signals every process the caller may signal.
`[uncited]` Hence the Step 0 guard. Additional mitigations `[uncited]`:

- re-derive the pgid from the live `Child::id()` each time; never cache across a reap;
- stop signalling after `ESRCH`/`ECHILD`; do not send a "safety" SIGKILL later;
- keep TERM→KILL inside one bounded escalation so the pid-reuse window equals the grace.

### 3.3 Zombie reaping is the parent's job

Whoever is the parent must `waitpid`. Killing the group without waiting leaks the direct
child as a zombie. `[src: https://iximiuz.com/en/posts/dealing-with-processes-termination-in-Linux]`
`std::process::Child`'s `Drop` does not reap, so an unwrapped `Child` left on an error path
is a guaranteed zombie. `[uncited]` Grandchildren are not ours to reap without a subreaper.
`[uncited]`

### 3.4 Group kill is a snapshot, not a tree walk

`kill(-pgid)` reaches group membership at that instant; a process that `setsid`s concurrently
escapes. No std-only fix. `[uncited]`

---

## 4. `std::process` gaps and the minimal `extern "C"` surface

### 4.1 Gaps

- **No portable process-group abstraction**, and no way to *signal* a group. `[src: https://users.rust-lang.org/t/stop-child-process-without-using-kill/30359]`
- **`Child::kill()` sends SIGKILL only** on Unix, with no signal-selecting variant. `[src: https://users.rust-lang.org/t/stop-child-process-without-using-kill/30359] [src: https://github.com/tokio-rs/tokio/issues/2504]`
  tokio's `Child::kill` has the same SIGKILL-only semantics, and that issue is also the record
  of the unresolved graceful-cleanup-on-drop discussion — upstream has not solved this.
- **No drop-based cleanup guarantee** under `panic=abort`. `[uncited]`
- **No public `waitpid`**: `try_wait`/`wait` cover the direct child only. `[uncited]`

### 4.2 Minimal surface (stable on both targets)

```rust
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
    fn getpgid(pid: i32) -> i32;   // assertions in tests
    fn getpgrp() -> i32;           // the "don't signal my own group" guard
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    #[cfg(target_os = "linux")]
    fn prctl(option: i32, ...) -> i32; // PR_SET_PDEATHSIG, PR_SET_CHILD_SUBREAPER
}
```

Constants are ABI, so hard-code them: `SIGTERM = 15`, `SIGKILL = 9` (both targets),
`WNOHANG = 1`, `PR_SET_PDEATHSIG = 1`, `PR_SET_CHILD_SUBREAPER = 36`. `[uncited]`

Notes `[uncited]`:

- Read `errno` via `std::io::Error::last_os_error()` immediately after the failing call;
  it is thread-local and easily clobbered.
- Prefer `Child::wait`/`try_wait` for the direct child over hand-decoding `waitpid` status
  macros; the bit tricks are the same on Darwin and Linux but easier to get wrong.
- `pre_exec` runs with the supervisor's signal dispositions inherited: **the supervisor must
  not have SIGTERM blocked or ignored before spawning**, or the child starts with it ignored.
- Do not add `setsid` (it escapes supervision).

---

## 5. macOS vs Linux divergence

| Concern | Linux | macOS | Portable approach |
| --- | --- | --- | --- |
| Spawn into own group | `process_group(0)` / `setpgid` | same | same std call `[uncited]` |
| `setpgid` after exec | `EACCES` | `EACCES` | pre-exec only `[uncited]` |
| Group kill | `kill(-pgid, sig)` | same | same `[uncited]` |
| Parent-death signal | `PR_SET_PDEATHSIG` `[src: https://man7.org/linux/man-pages/man2/pr_set_pdeathsig.2const.html]` | **absent** `[uncited]` | watchdog pipe (§2.2) |
| Parent-death detector | `/proc` polling or PDEATHSIG | `kqueue` `EVFILT_PROC` `NOTE_EXIT` `[uncited]` | poll `kill(pid, 0)` |
| Reap descendants we did not spawn | `PR_SET_CHILD_SUBREAPER` `[uncited]` | **absent**; no subreaper concept `[uncited]` | do not rely on it |
| Reap direct child | `waitpid` `[src: https://iximiuz.com/en/posts/dealing-with-processes-termination-in-Linux]` | `waitpid` | `Child::wait` |
| Zombie on supervisor exit | reparented to PID 1 | reparented to `launchd` | same policy `[uncited]` |
| `kill(0)`/negative pid semantics | as documented in `kill(2)` | same | same guard `[uncited]` |

**Explicit uncertainty:** the macOS column's `kqueue` row is general Darwin knowledge, not
from a provided source, and no supplied material covers a macOS orphan-prevention mechanism
at all. The only macOS statements this report can make with source backing are negative:
none of the supplied sources offers a PDEATHSIG equivalent for macOS. Everything positive
about macOS behaviour here is `[uncited]` and should be treated as a design hypothesis to
test on the target, not as established fact.

---

## 6. `panic=abort` and kill-on-drop

`processkit` provides a `ProcessGroup` that kills a process tree on drop. `[src: https://docs.rs/processkit]`
The same instinct appears in the tokio discussion. `[src: https://github.com/tokio-rs/tokio/issues/2504]`

Under `panic=abort`, `Drop` never runs on panic. `[uncited]` So a `Drop`-based guard is, at
best, a happy-path optimisation and must not be the mechanism relied upon — notably for
`pibash` daemons.

Emulation, in order `[uncited]`:

1. **Explicit sequence.** One `fn cancel(&mut Child) -> Envelope` implementing section 1.3,
   called from every cancellation path (timeout timer, explicit cancel, supervisor shutdown).
2. **Single funnel.** Route every early return through one `finish()` that owns envelope
   emission, reap, and spill cleanup, so `?` cannot skip it.
3. **Panic containment only where unwind exists.** If a subprocess's work lives in a crate
   or binary compiled `panic=unwind`, a `catch_unwind` plus RAII guard is sound there.
   Otherwise skip it.
4. **Startup sweep in the supervisor.** After spawn, immediately record the group in a
   live-groups file; remove on REAPED. On startup, kill recorded groups whose leader is gone.
   This closes the abort-leak hole without `Drop`. Store `(pid, start_time)` and refuse to
   kill on a start-time mismatch, because of pid reuse (§3.2).
5. **Daemon signal handler** for SIGTERM/SIGINT running the explicit sequence. Covers orderly
   shutdown; does not cover the `SIGABRT` a panic produces, which is the common leak source
   under `panic=abort`.

Recommendation: 1 + 2 + 4. Treat `ProcessGroup`-style drop as optional polish for any
`panic=unwind` build.

---

## 7. Verification probes

These convert every `[uncited]` claim into a checked fact on both targets; each needs only
the surface in §4.2.

1. `waitpid(-pgid, WNOHANG)` returns `0` while a member is alive, `-1/ECHILD` once empty.
2. Step 0 guard rejects `pgid == 0` and `pgid == getpgrp()`; confirm `kill(-0, sig)` would
   have hit our own group.
3. `setpgid` on an already-exec'd child returns `-1`/`EACCES` on both macOS and Linux.
4. SIGTERM-ignoring child (`trap '' TERM; sleep`) survives TERM, dies on KILL; envelope has
   `escalated: true`.
5. Child that `setsid`s a grandchild: group kill misses it; test asserts and documents the
   limitation.
6. Linux only: `PR_SET_PDEATHSIG` plus `getppid()` re-check; kill the spawning thread and
   assert child death; variant kills the parent before `prctl` to exercise the race.
7. Watchdog pipe: close the write end, assert the child self-terminates on both OSes.
8. Startup-sweep start-time mismatch refuses to kill.

---

## 8. Gaps

- **No source was fetched or read.** `[src: URL]` records supplied attribution only. All
  numeric constants, `errno` values, and loop semantics in section 1.3 are `[uncited]` and
  must pass the probes in section 7 before the escalation logic ships.
- **Grace period durations** are judgement. The supplied material explains the
  SIGTERM/SIGKILL tradeoff but recommends no duration, so no value here has source backing.
- **macOS orphan detection without `kqueue`** — the central unresolved question. No supplied
  source addresses a macOS parent-death substitute. The watchdog-pipe recommendation is
  `[uncited]` design reasoning; the `kqueue` direction claim (a survivor can watch a victim
  but a child cannot self-arm) is also `[uncited]` and needs checking against Darwin
  `kqueue(2)` before it is cited in design docs.
- **Whether `pre_exec` and `process_group(0)` interact badly** with the daemon's thread
  topology, given PDEATHSIG's parent-*thread* trigger, is `[uncited]` and untested.
- **`PR_SET_PDEATHSIG` man page details** (setuid `exec`, `fork` inheritance) are `[uncited]`;
  the two supplied copies confirm the "parent thread" wording and Linux-only status only.
- **Grandchildren that change their own group** have no std-only solution; whether the harness
  can accept that residual risk is a product decision, not a research finding.
- **cgroups v2 / `systemd-run --scope`** is the real Linux tree-kill answer and is excluded by
  the std-only constraint; worth a `docs/` note so the constraint is a recorded choice.
- **`prctl` is variadic** and its declaration in a Rust `extern "C"` block is `[uncited]`; if
  the pinned toolchain rejects it, use a tiny C shim or a `syscall()` declaration.

---

## 9. Sources

1. [Stop child process without using kill — users.rust-lang.org](https://users.rust-lang.org/t/stop-child-process-without-using-kill/30359) — no portable group abstraction in `std`; `Child::kill` is SIGKILL-only.
2. [tokio-rs/tokio#2504](https://github.com/tokio-rs/tokio/issues/2504) — tokio `Child::kill` SIGKILL on Unix; graceful-cleanup-on-drop discussion.
3. [Dealing with process termination in Linux — iximiuz](https://iximiuz.com/en/posts/dealing-with-processes-termination-in-Linux) — signals and reaping with Rust examples.
4. [processkit — docs.rs](https://docs.rs/processkit) — `ProcessGroup` kill-on-drop container for a process tree.
5. [SIGKILL vs SIGTERM: a developer's guide — SUSE](https://www.suse.com/blog/observability-sigkill-vs-sigterm-a-developers-guide-to-process-termination) — signal semantics; propagation within process groups.
6. [PR_SET_PDEATHSIG(2const) — man7.org](https://man7.org/linux/man-pages/man2/pr_set_pdeathsig.2const.html) — parent-death signal semantics; Linux-specific.
7. [PR_SET_PDEATHSIG — manpages.ubuntu.com](https://manpages.ubuntu.com/manpages/stonking/man2/PR_SET_PDEATHSIG.2const.html) — signal fires on termination of the *parent thread*.
8. [Using PR_SET_PDEATHSIG to reap child — smackerelofopinion](http://smackerelofopinion.blogspot.com/2015/11/using-prsetpdeathsig-to-reap-child.html) — PDEATHSIG for child reaping.
9. [dotnet/runtime#96470](https://github.com/dotnet/runtime/issues/96470) — PR_SET_PDEATHSIG support request and portability discussion.
