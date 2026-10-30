#!/usr/bin/env python3
"""Prototype: memory -> locate -> exact read, measured against today's read.

Measures, per (file, target line):
  A  today's built-in read tool (TypeScript, in-process — builtin-read.mjs):
     whole file under the built-in caps, same context memory, plus the
     follow-up windowed read when the target sits past the truncation.
  B  prototype: context-cache lookup, then `rg -n <symbol>` locate, then the
     exact merged window around the hits (+-CONTEXT lines).
  C  python simulation of the fused shape (windows + pointer footer), one
     call, same memory protocol.
  D  the fused tool as built: `piread --path f --hits <symbol>`, same
     memory protocol as C.
  E  piread's default paged mode (Rust): whole file under the read budget
     with gap markers beyond it, plus the follow-up windowed read when the
     target sits in the gap.

Costs: output bytes (token proxy), tool calls (turn proxy), wall time.
Read-only: no files are written.
"""

import json
import os
import re
import subprocess
import sys
import time

REPO = "/home/nurmdrafi/.pi/agent"
PIREAD = f"{REPO}/bin/piread"
RG = f"{REPO}/bin/rg"
OUTLINE = f"{REPO}/bin/outline"
CONTEXT = 12
READ_CAP = 100

FILES = [
    "rust-tools/piread/src/pipeline.rs",
    "rust-tools/piread/src/compress.rs",
    "rust-tools/piread/src/serve.rs",
    "extensions/piread/index.ts",
    "extensions/permission-gate/rules/read-coverage.ts",
    "extensions/permission-gate/rules/search-guard.ts",
    "extensions/subagents/index.ts",
    "extensions/subagents/tmux.ts",
    "scripts/gen-bounds.mjs",
    "AGENTS.md",
]


def run(cmd, cwd=REPO, env=None):
    t0 = time.perf_counter()
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    ms = (time.perf_counter() - t0) * 1000
    return r, ms


def outline_targets(path):
    """Definition rows: start end kind name."""
    r, _ = run([OUTLINE, path])
    rows = []
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 4 and parts[0].isdigit():
            rows.append((int(parts[0]), int(parts[1]), parts[3]))
    return rows


def builtin_arm(tasks):
    """A: the built-in read tool (TypeScript), executed in-process by
    builtin-read.mjs with the same context memory — one node run for the
    whole task list."""
    payload = json.dumps(
        [{"path": os.path.join(REPO, p), "target": t, "context": CONTEXT} for p, t in tasks]
    )
    r = subprocess.run(["node", f"{REPO}/tests/tools/bench/locate-read/builtin-read.mjs"],
                       cwd=REPO, capture_output=True, text=True, input=payload)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        raise SystemExit("builtin-read.mjs failed")
    return json.loads(r.stdout or "[]")


def paged(path, target, cache):
    """E: piread's default paged mode — whole file under the read budget,
    gap markers beyond it, plus the follow-up windowed read when the
    target sits in a gap."""
    key = (path, target // 20)
    if key in cache:
        return {"bytes": 0, "calls": 0, "ms": 0.0, "ok": True}
    r, ms = run([PIREAD, "--path", path])
    bytes_e = len(r.stdout)
    calls = 1
    try:
        env = json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"bytes": bytes_e, "calls": calls, "ms": ms, "ok": False}
    omissions = (env.get("compaction") or {}).get("omissions") or []
    in_gap = any(o["startLine"] <= target <= o["endLine"] for o in omissions)
    ok = not in_gap
    if in_gap:
        r2, ms2 = run(
            [PIREAD, "--path", path, "--offset", str(max(1, target - CONTEXT)),
             "--limit", str(2 * CONTEXT)]
        )
        bytes_e += len(r2.stdout)
        ms += ms2
        calls += 1
        ok = True
    return {"bytes": bytes_e, "calls": calls, "ms": ms, "ok": ok}


def prototype(path, target, symbol, cache):
    """B: memory -> locate -> exact read."""
    key = (path, target // 20)
    if key in cache:
        return {"bytes": 0, "calls": 0, "ms": 0.0, "ok": True, "stage": "memory"}
    r, ms = run([RG, "-n", symbol, path])
    hits = []
    for line in r.stdout.splitlines():
        m = re.match(r"^(\d+):", line)
        if m:
            hits.append(int(m.group(1)))
    bytes_b = len(r.stdout)
    if not hits:
        bytes_b += len(path.encode())
        return {"bytes": bytes_b, "calls": 1, "ms": ms, "ok": False, "stage": "locate-miss"}
    windows = []
    for h in sorted(hits):
        lo, hi = max(1, h - CONTEXT), h + CONTEXT
        if windows and lo <= windows[-1][1] + 1:
            windows[-1][1] = max(windows[-1][1], hi)
        else:
            windows.append([lo, hi])
    printed = 0
    for lo, hi in windows:
        room = READ_CAP - printed
        if room <= 0:
            break
        hi = min(hi, lo + room - 1)
        with open(f"{REPO}/{path}", encoding="utf-8", errors="replace") as fh:
            for i, text in enumerate(fh, 1):
                if lo <= i <= hi:
                    bytes_b += len(text) + 6  # "NNNN: " prefix, as rendered
        printed += hi - lo + 1
        for t in range(lo, hi + 1, 20):  # cache the printed span
            cache[(path, t // 20)] = True
    return {"bytes": bytes_b, "calls": 2, "ms": ms, "ok": printed > 0, "stage": "locate+read"}


def fused(path, target, symbol, cache):
    """C: one call = memory check, then locate rows and the exact merged
    windows in a single result (the shape a tool would print)."""
    key = (path, target // 20)
    if key in cache:
        return {"bytes": 40, "calls": 1, "ms": 0.0, "ok": True, "stage": "memory"}
    r, ms = run([RG, "-n", symbol, path])
    hits = [int(m.group(1)) for m in (re.match(r"^(\d+):", L) for L in r.stdout.splitlines()) if m]
    out = len(r.stdout) + 32  # hit rows + one "[hits: N]" status line
    if not hits:
        out += len(path.encode())
        return {"bytes": out, "calls": 1, "ms": ms, "ok": False, "stage": "locate-miss"}
    printed = 0
    lo_hi = []
    for h in sorted(hits):
        lo, hi = max(1, h - CONTEXT), h + CONTEXT
        if lo_hi and lo <= lo_hi[-1][1] + 1:
            lo_hi[-1][1] = max(lo_hi[-1][1], hi)
        else:
            lo_hi.append([lo, hi])
    for lo, hi in lo_hi:
        room = READ_CAP - printed
        if room <= 0:
            break
        hi = min(hi, lo + room - 1)
        with open(f"{REPO}/{path}", encoding="utf-8", errors="replace") as fh:
            for i, text in enumerate(fh, 1):
                if lo <= i <= hi:
                    out += len(text) + 6
        printed += hi - lo + 1
        for t in range(lo, hi + 1, 20):
            cache[(path, t // 20)] = True
    return {"bytes": out, "calls": 1, "ms": ms, "ok": printed > 0, "stage": "fused"}


def rust_fused(path, target, symbol, cache):
    """D: the real `piread --path f --hits sym` binary, same protocol as C
    (memory check, then one fused call)."""
    key = (path, target // 20)
    if key in cache:
        return {"bytes": 40, "calls": 1, "ms": 0.0, "ok": True, "stage": "memory"}
    r, ms = run([PIREAD, "--path", path, "--hits", symbol])
    out = len(r.stdout)
    try:
        locate = (json.loads(r.stdout) or {}).get("locate") or {}
    except json.JSONDecodeError:
        locate = {}
    ok = bool(locate.get("hits"))
    if not ok:
        return {"bytes": out, "calls": 1, "ms": ms, "ok": False, "stage": "locate-miss"}
    for lo, hi in locate.get("windows") or []:
        for t in range(lo, hi + 1, 20):
            cache[(path, t // 20)] = True
    return {"bytes": out, "calls": 1, "ms": ms, "ok": True, "stage": "fused"}


def main():
    cache = {}
    cache_b = {}
    cache_d = {}
    cache_e = {}
    totals = {"a_bytes": 0, "b_bytes": 0, "c_bytes": 0, "d_bytes": 0, "e_bytes": 0,
              "a_calls": 0, "b_calls": 0, "c_calls": 0, "d_calls": 0, "e_calls": 0,
              "a_ms": 0.0, "b_ms": 0.0, "c_ms": 0.0, "d_ms": 0.0, "e_ms": 0.0,
              "n": 0, "a_miss": 0, "b_miss": 0, "c_miss": 0, "d_miss": 0, "e_miss": 0}
    per_file = []
    all_tasks = []
    file_picks = []
    for path in FILES:
        targets = outline_targets(path)
        if not targets:
            continue
        # sample up to 3 definitions spread through the file
        step = max(1, len(targets) // 3)
        picked = targets[::step][:3]
        file_picks.append((path, len(targets), picked))
        for start, _end, _name in picked:
            all_tasks.append((path, start))
    a_results = builtin_arm(all_tasks)
    ai = 0
    for path, ndefs, picked in file_picks:
        a_bytes = b_bytes = c_bytes = d_bytes = e_bytes = 0
        a_calls = b_calls = c_calls = d_calls = e_calls = 0
        a_ms = b_ms = c_ms = d_ms = e_ms = 0.0
        for start, _end, name in picked:
            a = a_results[ai]; ai += 1
            b = prototype(path, start, name, cache_b)
            c = fused(path, start, name, cache)
            d = rust_fused(path, start, name, cache_d)
            e = paged(path, start, cache_e)
            a_bytes += a["bytes"]; b_bytes += b["bytes"]; c_bytes += c["bytes"]; d_bytes += d["bytes"]; e_bytes += e["bytes"]
            a_calls += a["calls"]; b_calls += b["calls"]; c_calls += c["calls"]; d_calls += d["calls"]; e_calls += e["calls"]
            a_ms += a["ms"]; b_ms += b["ms"]; c_ms += c["ms"]; d_ms += d["ms"]; e_ms += e["ms"]
            totals["a_miss"] += 0 if a["ok"] else 1
            totals["b_miss"] += 0 if b["ok"] else 1
            totals["c_miss"] += 0 if c["ok"] else 1
            totals["d_miss"] += 0 if d["ok"] else 1
            totals["e_miss"] += 0 if e["ok"] else 1
            totals["n"] += 1
        totals["a_bytes"] += a_bytes; totals["b_bytes"] += b_bytes; totals["c_bytes"] += c_bytes; totals["d_bytes"] += d_bytes; totals["e_bytes"] += e_bytes
        totals["a_calls"] += a_calls; totals["b_calls"] += b_calls; totals["c_calls"] += c_calls; totals["d_calls"] += d_calls; totals["e_calls"] += e_calls
        totals["a_ms"] += a_ms; totals["b_ms"] += b_ms; totals["c_ms"] += c_ms; totals["d_ms"] += d_ms; totals["e_ms"] += e_ms
        per_file.append((path, ndefs, a_bytes, b_bytes, c_bytes, d_bytes, e_bytes,
                         a_calls, b_calls, c_calls, d_calls, e_calls,
                         round(a_ms, 1), round(b_ms, 1), round(c_ms, 1), round(d_ms, 1), round(e_ms, 1)))

    print(f"{'file':46} {'defs':>4} {'A B':>8} {'B B':>8} {'C B':>8} {'D B':>8} {'E B':>8} {'A cl':>4} {'B cl':>4} {'C cl':>4} {'D cl':>4} {'E cl':>4}")
    for row in per_file:
        print(f"{row[0]:46} {row[1]:4d} {row[2]:8d} {row[3]:8d} {row[4]:8d} {row[5]:8d} {row[6]:8d} {row[7]:4d} {row[8]:4d} {row[9]:4d} {row[10]:4d} {row[11]:4d}")
    n = totals["n"]
    print()
    print(f"tasks={n} misses A={totals['a_miss']} B={totals['b_miss']} C={totals['c_miss']} D={totals['d_miss']} E={totals['e_miss']}")
    print(f"bytes   A={totals['a_bytes']:9d}  B={totals['b_bytes']:9d}  C={totals['c_bytes']:9d}  D={totals['d_bytes']:9d}  E={totals['e_bytes']:9d}")
    print(f"        B/A={totals['b_bytes']/max(1,totals['a_bytes']):.2f}  C/A={totals['c_bytes']/max(1,totals['a_bytes']):.2f}  D/A={totals['d_bytes']/max(1,totals['a_bytes']):.2f}  E/A={totals['e_bytes']/max(1,totals['a_bytes']):.2f}")
    print(f"calls   A={totals['a_calls']:9d}  B={totals['b_calls']:9d}  C={totals['c_calls']:9d}  D={totals['d_calls']:9d}  E={totals['e_calls']:9d}")
    print(f"ms      A={totals['a_ms']:9.1f}    B={totals['b_ms']:9.1f}    C={totals['c_ms']:9.1f}    D={totals['d_ms']:9.1f}    E={totals['e_ms']:9.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
