#!/usr/bin/env python3
"""Audit v2 — turn-by-turn, byte-level session accounting.

Per user-turn ledger from raw session JSONL:
  bytes_in      content bytes that entered model context this turn
                (visibleChars when compaction metadata exists, else text bytes)
  bytes_omitted elided bytes (generated, never entered context; re-read cost later)
  spill         results spilled to a temp file (future re-read needed)
  out_tok/in_tok/cache_read/reasoning/cost   usage sums of the turn's
                assistant messages (LLM input/output per turn)
  n_calls / n_blocked / n_err  tool traffic and gate catches
  waste_lines   re-fetched already-rendered read lines (v1 ledger, per turn)
  dup_cmds      exact-duplicate shell commands within the turn
  churn_max     max same-path landed edit/write count in the turn (LG1 shape)

Mistake families: Anchor Guard / Token Economy / Permission Gate /
Loop Guard / generic error results.
Writes full JSON to <sessions-root>/../.cache/session-audit.json (or argv[3]),
prints a compact report.

Usage: python3 scripts/session-audit.py [since-date=2026-10-19]
                                [sessions-dir=~/.pi/agent/sessions]
                                [out-json=<sessions-dir>/../.cache/session-audit.json]
Requires python3 (stdlib only). `since-date` feeds `fd --newer`.
"""
import json, subprocess, collections, sys, os

READ_TOOLS = {"piread", "read", "mcp__fsprobe__read"}
MUTATE_TOOLS = {"piedit", "edit", "write"}
BLOCK_FAMILIES = [
    ("Anchor Guard", "anchor"), ("Token Economy", "token"),
    ("Permission Gate", "perm"), ("Loop Guard", "loop"),
    ("Cadence", "cadence"),
]

def windows(ov, lim):
    start = ov if isinstance(ov, (int, float)) else 1
    end = start + lim - 1 if isinstance(lim, (int, float)) and lim > 0 else 10**9
    return (int(start), int(end))

def merge(led):
    out = []
    for s, e in sorted(led):
        if out and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]

def ov_lines(w, led):
    n = 0
    for ls, le in merge(led):
        n += max(0, min(w[1], le) - max(w[0], ls) + 1)
    return n

def analyze(path):
    turns = []
    cur = None
    calls = {}
    ledger = {}
    batch = {}
    cmds = collections.Counter()
    mutate_cnt = collections.Counter()
    seen_cmd_prev_turn = set()

    def newturn(ts):
        return {"ts": ts, "n_calls": 0, "n_blocked": 0, "n_err": 0,
                "families": collections.Counter(), "bytes_in": 0,
                "bytes_omitted": 0, "spill": 0, "waste_lines": 0,
                "dup_cmds": 0, "out_tok": 0, "in_tok": 0, "cache_read": 0,
                "reasoning": 0, "cost": 0.0, "churn_max": 0,
                "big_result": None, "n_asst": 0}

    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            msg = rec.get("message") or {}
            role = msg.get("role")
            ts = rec.get("timestamp", "")
            if role == "user":
                if cur: turns.append(cur)
                cur = newturn(ts)
                cmds = collections.Counter()
                mutate_cnt = collections.Counter()
            elif role == "assistant" and cur is not None:
                cur["n_asst"] += 1
                u = msg.get("usage") or {}
                mid = rec.get("id")
                cur.setdefault("msg_out", {})[mid] = u.get("output", 0) or 0
                cur["out_tok"] += u.get("output", 0) or 0
                cur["in_tok"] += u.get("input", 0) or 0
                cur["cache_read"] += u.get("cacheRead", 0) or 0
                cur["reasoning"] += u.get("reasoning", 0) or 0
                cur["cost"] += (u.get("cost") or {}).get("total", 0) or 0
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        a = c.get("arguments") or {}
                        calls[c.get("id")] = {
                            "name": c.get("name"), "path": a.get("path"),
                            "offset": a.get("offset"), "limit": a.get("limit"),
                            "cmd": a.get("command"), "mid": rec.get("id"),
                            "nblk": 0, "ncall": 0,
                        }
                        cur["n_calls"] += 1
                        calls[c.get("id")]["ncall"] += 1
            elif role == "toolResult" and cur is not None:
                cid = msg.get("toolCallId")
                cl = calls.get(cid)
                if not cl:
                    continue
                d = msg.get("details") or {}
                comp = d.get("compaction") or d.get("compression") or {}
                vis = comp.get("visibleChars")
                omitted = comp.get("omittedChars") or 0
                txt = "".join(c.get("text", "") for c in msg.get("content") or []
                              if isinstance(c, dict) and c.get("type") == "text")
                nbytes = vis if isinstance(vis, (int, float)) else len(txt.encode("utf-8", "replace"))
                cur["bytes_in"] += nbytes
                cur["bytes_omitted"] += omitted or 0
                if comp.get("spillUsed"): cur["spill"] += 1
                # biggest single result annotation
                if not cur["big_result"] or nbytes > cur["big_result"][1]:
                    cur["big_result"] = (cl["name"], nbytes)
                fam = None
                if msg.get("isError"):
                    for needle, key in BLOCK_FAMILIES:
                        if needle in txt[:80]:
                            fam = key
                            break
                    if fam:
                        cur["n_blocked"] += 1
                        cur["families"][fam] += 1
                        cur.setdefault("blk_mids", set()).add(cl["mid"])
                    else:
                        cur["n_err"] += 1
                        cur.setdefault("err_txt", collections.Counter())[txt[:60]] += 1
                # reads: rendered-span ledger for waste attribution
                name = cl["name"]
                if name in READ_TOOLS and cl["path"] and not msg.get("isError"):
                    p = cl["path"]
                    nl = len(txt.split("\n"))
                    w = [windows(cl["offset"], cl["limit"])[0],
                         min(windows(cl["offset"], cl["limit"])[1],
                             windows(cl["offset"], cl["limit"])[0] + max(0, nl - 1))]
                    prior = ledger.get(p, [])
                    ov = ov_lines(tuple(w), prior)
                    if ov > 0:
                        cur["waste_lines"] += ov
                    # same-batch sibling overlap
                    for prev in batch.get(cl["mid"], []):
                        if prev[0] == p:
                            cur["waste_lines"] += ov_lines(tuple(w), [prev[1]])
                    batch.setdefault(cl["mid"], []).append((p, tuple(w)))
                    ledger.setdefault(p, []).append(tuple(w))
                elif name in MUTATE_TOOLS and cl["path"] and not msg.get("isError"):
                    ledger.pop(cl["path"], None)
                    mutate_cnt[cl["path"]] += 1
                    cur["churn_max"] = max(cur["churn_max"], mutate_cnt[cl["path"]])
                elif name in ("bash", "pibash") and cl["cmd"] and not msg.get("isError"):
                    if cl["cmd"] in cmds:
                        cur["dup_cmds"] += 1
                    cmds[cl["cmd"]] += 1
    if cur: turns.append(cur)
    for t in turns:
        # wasted output: assistant-message output tokens whose calls were blocked
        mids = t.pop("blk_mids", set())
        mo = t.pop("msg_out", {})
        t["wasted_out"] = sum(v for k, v in mo.items() if k in mids)
        t["err_txt"] = dict(t.pop("err_txt", {}))
    return turns

if __name__ == "__main__":
    since = sys.argv[1] if len(sys.argv) > 1 else "2026-10-19"
    sdir = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.pi/agent/sessions")
    outpath = (sys.argv[3] if len(sys.argv) > 3
               else os.path.join(os.path.dirname(sdir.rstrip("/")), ".cache", "session-audit.json"))
    files = subprocess.run(["fd", "-e", "jsonl", "--newer", since],
                           capture_output=True, text=True,
                           cwd=sdir).stdout.split()
    out = []
    for f in files:
        try:
            ts = analyze(os.path.join(sdir, f))
        except Exception as e:
            print(f"SKIP {f}: {e}", file=sys.stderr)
            continue
        if ts:
            out.append({"file": f.split("/")[-2] + "/" + f.split("/")[-1][:20], "turns": ts})
    os.makedirs(os.path.dirname(outpath), exist_ok=True)
    json.dump(out, open(outpath, "w"))
    # ---- compact report ----
    T = [t for s in out for t in s["turns"]]
    tot = lambda k: sum(t[k] for t in T)
    print(f"sessions={len(out)} turns={len(T)}")
    print(f"bytes_in={tot('bytes_in')/1e6:.1f}MB omitted={tot('bytes_omitted')/1e6:.1f}MB "
          f"spill={tot('spill')} waste_lines={tot('waste_lines')}")
    print(f"calls={tot('n_calls')} blocked={tot('n_blocked')} errs={tot('n_err')} "
          f"dupcmds={tot('dup_cmds')} churnmax>=4 turns={sum(1 for t in T if t['churn_max']>=4)}")
    fam = collections.Counter()
    for t in T: fam.update(t["families"])
    print("families:", dict(fam))
    print(f"tokens: out={tot('out_tok')/1e3:.0f}K in={tot('in_tok')/1e3:.0f}K "
          f"cache_read={tot('cache_read')/1e6:.1f}M reasoning={tot('reasoning')/1e3:.0f}K "
          f"cost=${tot('cost'):.2f}")
    # mistake-cost correlation
    blk = [t for t in T if t["n_blocked"] or t["n_err"]]
    clean = [t for t in T if not (t["n_blocked"] or t["n_err"])]
    mb = sum(t["out_tok"] for t in blk) / max(1, len(blk))
    mc = sum(t["out_tok"] for t in clean) / max(1, len(clean))
    print(f"turns with mistakes: {len(blk)}  avg out_tok={mb:.0f} | clean: {len(clean)} avg={mc:.0f}")
    print("top turns by bytes_in:")
    for t in sorted(T, key=lambda t: -t["bytes_in"])[:8]:
        print(f"  {t['ts'][:16]} in={t['bytes_in']/1e3:6.0f}KB om={t['bytes_omitted']/1e3:5.0f}KB "
              f"calls={t['n_calls']:2d} blk={t['n_blocked']} big={t['big_result']}")
