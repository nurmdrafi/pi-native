# Hardening the security boundary of pibash + its NDJSON daemon

Scope: validate the invariants already proposed in the external architecture review against
documented incidents and guidance. Target surface: `pibash` (executes arbitrary shell commands,
gated by the user-approved permission-gate extension) and the persistent stdio daemon that
receives JSON requests from the Node extension.

Citation discipline for this document:

- **[cited]** — content actually extracted for this report, or supplied as a first-party
  title-level reference by the requester.
- **[uncited]** — my own engineering knowledge of well-established platform/OS semantics, not
  fetched for this report. Correct in general, but verify against your target OS before relying on
  it for a specific decision.
- Retracted source: the arXiv URL `2602.01655v1` was originally supplied as an "OpenClaw AI Agent
  Framework security analysis". It is in fact **ProjDevBench**, an agent-benchmarking paper, and
  carries no security content. **It is not cited anywhere in this document.** Any prior
  architecture-review claim that leaned on it for path-traversal or containment findings must be
  re-sourced or dropped.
- The `codeant.ai` CVE page (CVE-2026-62677, CWE-22 path traversal in Omnigent Agent Runner)
  extracted to navigation boilerplate only. It is cited **at title level only** — "a Path
  traversal (CWE-22) class vulnerability was assigned to an agent runner" — and is never used to
  support any claim about bypass mechanism, fix, or severity.

---

## 1. Verdict table: planned invariants

| # | Planned invariant | Verdict | Basis |
|---|---|---|---|
| 1 | Daemon never reads config / credentials / allowlists from untrusted project-local files without validation | **Validates** (and **refines**) | Brig: the working directory was "guarded carefully", yet the folder was handed to the runtime "as a raw path, without checking where it actually pointed" [cited: endorlabs]. A project-local path is attacker-influenced input even when it's "inside the project". Refinement: validation must be *resolved-path* validation, not string-prefix validation. |
| 2 | Environment injection allowlisted, not broadly inherited | **Validates** — now with direct incident evidence | Checkmarx names "Identity and permission sprawl" as a primary risk class [cited: checkmarx]. Knostic documents coding agents mishandling `.env` files and secrets, and states the problem is "not isolated to a single tool" [cited: knostic]. Unit 42 documents leaked environment variables enabling a large-scale extortion operation [cited: unit42]. Sourcery documents secret exposure via env vars in container startup scripts [cited: sourcery]. |
| 3 | cwd canonicalized and checked against permitted roots | **Validates** (highest-confidence finding) | Brig GHSA-wp6x-29qx-fpr7 / ENDOR-VUL-2026-1809, CVSS 8.2: isolation "was never the problem", the hole was the unvalidated raw project path [cited: endorlabs]. Also CWE-22 class precedent in an agent runner [title-level: codeant]. |
| 4 | Temp spill files use `O_EXCL` + restrictive permissions + cleanup on abnormal exit | **Validates**, with a sharper failure model | OpenStack security guidelines treat predictable filenames and `mkdtemp`-class private directories as the dividing line between safe and unsafe temp handling [cited: openstack]; Wheeler documents insecure `mktemp(3)`/`tmpnam` races and their symlink consequences [cited: wheeler]; glibc documents `mkdtemp` as collision-free against existing files [cited: glibc-mkdtemp]; Softprayog covers `O_EXCL` creation in Linux [cited: softprayog]. Refinement: the *location and name* of the spill file decide whether `O_EXCL` helps at all — see §3.3. |
| 5 | `PI_*` env vars validated (types, lengths, paths) | **Refines** | Validates the instinct, but the material reframes the threat: Checkmarx's "memory and context poisoning" and Backslash's "hidden instructions inside content an agent reads can redirect a trusted Skill" [cited] mean env values are *instruction-bearing input*, not just typed config. Knostic shows agents moving secrets between `.env` files and their own context/logs [cited: knostic]. Refinement: validate shape **and** treat path-valued `PI_*` vars as untrusted paths requiring the same resolved-path check as cwd. |
| 6 | Logs exclude secrets / full env / raw output by default | **Validates**, with a provenance caveat | Knostic's finding is that agents leak secrets across their own handling paths, which supports default redaction [cited: knostic]. Backslash: "Process-level endpoint telemetry records that a command ran, but not which Skill, agent or MCP server caused it" [cited: backslash] — a *provenance* gap, not a secrecy gap. Refinement: redact values, but do not implement this as "log less"; add structured provenance fields (skill/agent/tool/request-id) so attribution survives redaction. |
| 7 | Permission-gate symlink / protected-path checks (flagged P0) | **Validates**; P0 ranking **refined**: symlink checks alone are the wrong top-level boundary | Brig shows the symlink swap is the *delivery* mechanism; the defect was that containment was decided without resolving [cited: endorlabs]. Wheeler documents the same class on the classic temp-file route [cited: wheeler]. A gate that lstats only the final path, or compares `starts_with` on uncanonicalized strings, reproduces brig exactly. The P0 should be "resolve-then-compare, on the opened handle's real path", with symlink rejection as one input to it. |

Verdict count: **6 validate**, **3 refine** (items 1, 5, 6), **1 reframed at P0 level** (item 7),
**0 outright contradict**. Items 2, 4 and 6 moved from design-reasoning to cited evidence in this
revision; item 7 stays a partial contradiction *of the framing*, not of the check.

---

## 2. Incident lessons, mapped to pibash / daemon specifics

### 2.1 Brig: isolation was fine; the raw path was the hole

What happened [cited: endorlabs]: brig ran each agent in a sandbox, up to a microVM with hardware
isolation. It guarded the working directory carefully. But it "handed the project folder to the
underlying runtime as a raw path, without checking where it actually pointed." The agent, which
already had read-write access to the project folder, replaced a subfolder with a symlink aimed at
another directory. "The shortcut does nothing on its own. The next time you narrow a run to that
subfolder" — i.e. the escape fires on a *later, narrower* run.

Mapping to pibash + daemon:

- **The pibash analogue of "narrow a run to that subfolder" is a per-command `cwd`.** The daemon
  receives a JSON request naming a working directory. If it resolves and checks that path at
  request time using a string comparison, or resolves it and then `chdir`s separately, an agent
  that can write inside the permitted root can pre-plant a symlink and pivot on the next call. The
  persistent daemon makes this worse than in a one-shot tool: state carried across requests means
  the planted link is still there one call later.
- **The lesson is not "add more isolation."** Brig's isolation was never the problem. Spending
  effort on the sandbox while leaving a raw path unvalidated is precisely the failure mode being
  documented. For pibash this argues against treating the permission-gate prompt as the security
  boundary and treating path validation as a nice-to-have.
- **"Guarded carefully" is a trap.** The project folder *was* guarded; the guard was on the wrong
  representation of the path (the string the caller supplied, rather than the object it resolves
  to). Any invariant phrased as "check the path" without naming *which* path — supplied vs
  resolved vs actually-opened — is under-specified.

### 2.2 The reachable-set lesson

The requester's summary of the brig write-up names the target directories as `~/.ssh`, `~/.aws`,
`~/.config/gh/hosts.yml`. Those specific paths are **[uncited]** at extract level — the extracted
text says only "any other directory on your machine" [cited: endorlabs]. Regardless of the exact
list, the reasoning is the durable part: what makes a pivot valuable is not the pivot mechanism but
the **reachable set** — which credential-bearing paths the agent's own uid can read once it escapes
its intended root. Two consequences for pibash:

- The permitted-roots check should be paired with an explicit protected-path list evaluated
  against the *resolved* path, and that list should be built by asking "what does this uid own that
  grants further access", not by asking "what looks sensitive". [uncited reasoning]
- Because the agent runs as the user, the reachable set is effectively the user's whole home
  directory. This is why the permission gate's protected-path checks cannot be advisory. The
  extortion case shows the payoff at volume: leaked environment variables were scanned and
  exploited at scale [cited: unit42].

### 2.3 Agent-runner path traversal as a recurring class

CVE-2026-62677 records a Path traversal (CWE-22) vulnerability in an agent runner, Omnigent Agent
Runner [title-level: codeant; the extracted page body was navigation boilerplate and contributed
no mechanism detail]. Treat this as class-level corroboration only: agent runners that take a path
from the model/agent and hand it to a filesystem or shell operation keep producing CWE-22. It
supports the priority ordering in the verdict table but must not be cited for any specific bypass
technique.

### 2.4 Prompt-driven bypass and tool misuse

Checkmarx enumerates "unsafe tool invocation / tool misuse: Agents may invoke incorrect tools,
pass unsafe inputs, or execute unintended operations" alongside identity/permission sprawl, memory
and context poisoning, and prompt injection [cited: checkmarx]. The relevant reading for a shell
tool: **the argument to the shell command is attacker-influenced input even when the human approved
the tool.** A gate that approves "run a shell command" approves a capability, not an argv. This is
why the invariants that constrain *mechanism* (canonicalized cwd, allowlisted env, protected paths)
carry more weight than anything that inspects the *text* of the command.

Backslash adds the provenance dimension: "Hidden instructions inside content an agent reads can
redirect a trusted Skill, so provenance and update path matter beyond first install", and "Process-
level endpoint telemetry records that a command ran, but not which Skill, agent or MCP server caused
it" [cited: backslash]. For the daemon this means every request should carry and log the
originating skill/tool identity, because after the fact the OS-level record will not tell you which
agent caused an execution.

### 2.5 Secret handling in coding agents: env is the leak channel

Knostic's write-up is the closest fit to pibash's threat model: coding agents mishandling `.env`
files and secrets, with the failure "not isolated to a single tool" [cited: knostic]. The concrete
lesson is that the interesting boundary is not "does the agent read `.env`" but "what does the
agent do with what it reads" — copy it into context, into logs, into a spawned process's
environment, or into a generated file. pibash sits on exactly that last two hops: it constructs the
child environment and it may spill output to disk. Hence invariants 2 and 6 are the same defense
seen from two directions.

Two corroborating channels from outside the agent niche:

- CI/CD pipelines leak secrets through exposure of the pipeline environment itself [cited:
  trufflesecurity]. A CI runner and a pibash daemon have the same shape: a long-lived trusted
  process holding credentials, executing untrusted-influenced commands.
- Container startup scripts expose secrets via environment variables [cited: sourcery], i.e. the
  leak survives containerization because env is inherited into the process tree. Isolation does not
  fix env inheritance — the same "isolation was never the problem" pattern as brig, on a different
  mechanism.

### 2.6 Skill review scope: what it means for pibash

Backslash frames review scope as reach rather than appearance: "Agent Skills execute with the
employee's own permissions, so the review scope is what the Skill can reach, not only whether it
looks malicious"; a Skill is "a package of instructions and scripts" that "can tell an agent to
read a file, call an API, or run a shell command, executing with that user's own account and
access" [cited: backslash]. This is the strongest available argument that pibash's boundary must be
enforced in code underneath the skill, since a skill's own text is both the thing being trusted and
a plausible injection vector.

---

## 3. Concrete check implementations (std-only Rust)

Constraints: std only, no `openat2`, no `capsicum`. The ordering below matters — resolve first,
decide second, operate third, and never let a checked path become a different path between the
check and the use.

### 3.1 Canonicalize before compare

```rust
use std::path::{Path, PathBuf};

/// Resolve `candidate` to a real path and confirm it is inside one of `roots`.
/// `roots` must themselves be canonicalized once at daemon startup, not per request.
fn resolve_within_roots(candidate: &Path, roots: &[PathBuf]) -> Result<PathBuf, PathError> {
    // canonicalize() fails if any component is missing; that is the desired behaviour —
    // we refuse to reason about paths that do not exist yet.
    let real = std::fs::canonicalize(candidate).map_err(PathError::Unresolvable)?;
    if !roots.iter().any(|r| real.starts_with(r)) {
        return Err(PathError::OutsideRoots(real));
    }
    Ok(real)
}
```

Notes on why this shape, all **[uncited]** std/OS semantics:

- `canonicalize` resolves symlinks and `.`/`..` and returns an absolute path; comparing the raw
  input to roots is the brig bug.
- `Path::starts_with` compares whole components, so `/srv/roots-evil` does **not** match root
  `/srv/roots` — this is the correct primitive, unlike string `starts_with`.
- Canonicalizing roots per request re-introduces a TOCTOU window if a root's own ancestor is
  writable; canonicalize them once when the daemon starts and treat them as immutable thereafter.
- `canonicalize` on the *final* path still leaves the classic window between resolution and use.
  Close it by operating through the returned `PathBuf` immediately and never re-joining user
  input onto it afterwards.

### 3.2 Per-component walk (for diagnostics and for refusing links outright)

```rust
use std::path::{Component, Path, PathBuf};

enum WalkError { Symlink(PathBuf), Escapes(PathBuf) }

/// Walk component by component, refusing any symlinked component.
/// Use when policy is "no links at all", or to produce a precise error for the gate UI.
fn walk_no_symlinks(input: &Path, root: &Path) -> Result<PathBuf, WalkError> {
    let mut cur: PathBuf = root.to_path_buf();
    for comp in input.components() {
        match comp {
            Component::Normal(name) => {
                cur.push(name);
                let md = std::fs::symlink_metadata(&cur).map_err(|_| WalkError::Escapes(cur.clone()))?;
                if md.file_type().is_symlink() {
                    return Err(WalkError::Symlink(cur));
                }
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(WalkError::Escapes(cur)),
            Component::RootDir | Component::Prefix(_) => return Err(WalkError::Escapes(cur)),
        }
    }
    Ok(cur)
}
```

[uncited] semantics: `symlink_metadata` (lstat) does not follow the final link, which is the point;
`fs::metadata` (stat) would silently follow it. Rejecting `ParentDir` outright is stricter than
necessary but removes an entire reasoning burden and is what a permission gate wants, since a
legitimate `..` in an agent-supplied path is rare and a red flag.

The two functions are complementary: use `walk_no_symlinks` when the policy is strict or when you
need to explain *why* a request was refused; use `resolve_within_roots` when intermediate links
inside a trusted root are considered acceptable. Do not use `walk_no_symlinks` as a substitute for
the root check — a walk that starts at the wrong root proves nothing.

### 3.3 Temp spill: what the secure-temp literature actually says

This section previously rested on reasoning alone; it now has sourced backing, and the sources move
the emphasis from *flags* to *directory and name*.

The sourced failure model **[cited: wheeler]**: insecure temp-file APIs — `mktemp(3)`, `tmpnam`,
predictable names — create a window in which an attacker who can write the temp directory pre-creates
the name (as a file, or as a symlink pointing somewhere privileged) and the victim's program then
opens it. That is a race, and it is a symlink problem, which is why it sits next to the brig lesson
rather than apart from it.

The sourced prescription:

- Create a **private directory**, not a private file. glibc documents `mkdtemp` as producing a
  directory name that clashes with no existing file, with the directory created `0700` [cited:
  glibc-mkdtemp]. OpenStack's guidelines converge on the same pattern and name predictable
  filenames inside a shared temp directory as the anti-pattern to avoid [cited: openstack].
- **`O_EXCL`** is the flag-level guarantee available when you must create a file at a chosen path,
  and Linux-oriented treatments cover its use for temp creation [cited: softprayog]. It is
  necessary but not sufficient: it protects the *final* component only, so a pre-planted symlinked
  *directory* above it is untouched. That is the same final-component-vs-whole-path distinction as
  §3.1/§3.2.
- **Remove promptly**, and prefer the API shape where the library does the removal; OpenStack
  guidelines treat lifetime and cleanup as part of the pattern, not an afterthought [cited:
  openstack].

Consequences for pibash, in std-only Rust **[uncited mechanics, cited pattern]**:

1. **`create_new(true)`** — sets `O_EXCL|O_CREAT`; fails if the final path exists at all, which
   defeats a pre-planted symlink at that component.
2. **Per-run private directory** — `std::fs::create_dir` of a directory with a random suffix under
   `TMPDIR`, immediately set to `0o700` via `std::os::unix::fs::PermissionsExt`, then spill inside
   it. This is the `mkdtemp` pattern expressed in std and is the one I would ship; it removes the
   predictable-filename class entirely rather than racing on it.
3. **`libc::open` with `O_NOFOLLOW|O_EXCL|O_CREAT` and `0o600`** — exact semantics, adds a `libc`
   dependency; justified only if the spill path must live in a directory the agent can write.
4. **`openat2` with `RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH`** — the correct kernel-level answer, but
   Linux-5.6+, not std, absent on macOS. Upgrade path if the constraint relaxes; noted in Gaps.

Cleanup must cover three cases that are easy to conflate: normal return, panic (a `Drop` guard
covers it), and process kill / daemon restart (nothing in-process covers it). For the last, name
spill files with the daemon pid plus a start-time token and sweep stale ones at next startup rather
than promising synchronous cleanup. Note also that a `Drop`-based guard is *not* a security control
against a hostile agent — it is reliability; the security property comes from the `0700` directory
and unpredictable names.

### 3.4 Environment allowlist

```rust
const ENV_ALLOWLIST: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

fn build_env(source: &std::process::Command) -> std::process::Command { /* ... */ }
```

Build the child environment from an empty base (`env_clear`) plus explicit `set_env` calls for
allowlisted keys, rather than inheriting and then removing. Inheriting-then-removing fails open on
every key you did not think of, and the set of keys present in a developer shell is large and
changes over time. [uncited mechanics] The evidence base for *why* is now three-deep: coding agents
mishandle secrets across tool boundaries [cited: knostic], CI pipelines leak the pipeline
environment [cited: trufflesecurity], and containerized workloads still expose env-borne secrets
despite isolation [cited: sourcery]. Note the ordering lesson from §3.3 generalizes — an allowlist
is a whole-pipeline property, so it must be applied at the `Command` construction boundary where no
code path can bypass it by building a command differently.

---

## 4. What the sources do *not* establish

- No extracted source documents an **agent-harness-specific** env-var breach with a named CVE. The
  coding-agent evidence is Knostic's study of `.env`/secret mishandling [cited], which describes a
  class of behaviour rather than a single incident; the CI/CD, extortion, and container sources are
  adjacent-domain evidence for the same channel [cited]. This is enough to move invariant 2 from
  reasoning to evidence, but it is not a pibash-shaped incident.
- The extortion case [cited: unit42] is cited for the claim that leaked env vars get scanned and
  exploited at scale; details of which variables were harvested and by what initial access are not
  established by the extracted material.
- **Temp-file guidance is generic systems-security practice, not agent-tool practice.** Wheeler,
  glibc, OpenStack, and Softprayog all predate or ignore the agent context [cited]. The transfer is
  sound — a spill file in a directory an agent can write is the classic case — but no source
  describes an agent tool exploited this way.
- The **reachable-set example paths** (`~/.ssh`, `~/.aws`, `~/.config/gh/hosts.yml`) came from the
  requester's summary, not from the extracted brig text, which says only "any other directory".
- **CVE-2026-62677** is cited at title level only; mechanism, affected versions, and fix are
  unknown here.
- Checkmarx, Backslash, Knostic, Unit 42, Sourcery, OpenStack, Wheeler, glibc, and Softprayog were
  read as extracts or pages of unknown completeness; claims are attributed to the specific points
  noted and not generalized beyond them.
- `openat2`/`RESOLVE_BENEATH` remains out of scope by the std-only constraint and is unverified
  here as an upgrade path.

---

## 5. Recommended priority order (revised by these findings)

1. **Resolve-then-compare for cwd and every path-valued argument**, evaluated against roots
   canonicalized at daemon start. This is the brig lesson applied directly, and it is the check
   that the incident says was actually missing.
2. **Protected-path list evaluated on the resolved path**, built from "what can this uid reach",
   not "what looks sensitive" — motivated by the extortion case's payoff at scale [cited: unit42].
3. **Env allowlist at the `Command` construction boundary** (`env_clear` + explicit set) — now
   evidence-backed by three leak channels [cited: knostic, trufflesecurity, sourcery].
4. **Temp spill in a per-run `0o700` private directory with `create_new`**, plus startup sweep —
   the `mkdtemp` pattern rather than a race on a predictable name [cited: openstack, glibc-mkdtemp].
5. **Request provenance in logs** (originating skill/tool/request-id) alongside redaction — the gap
   Backslash identifies, cheap to add [cited: backslash].
6. **`PI_*` validation as untrusted-input validation**, not merely type/length checks; path-valued
   `PI_*` vars go through step 1.

Item 7 of the original list (symlink checks) is not dropped, but it is re-homed: symlink rejection
is an input to steps 1 and 4, not a standalone control, and framing it as the P0 conflates the
delivery mechanism with the defect.

---

## Sources

1. [Project mount symlink traversal in brig: how a sandbox reaches host directories it was never
   given](https://www.endorlabs.com/learn/project-mount-symlink-traversal-in-brig-how-a-sandbox-reaches-host-directories-it-was-never-given)
   — GHSA-wp6x-29qx-fpr7 / ENDOR-VUL-2026-1809, CVSS 8.2. Contributed the core finding: isolation
   was not the weakness; the unvalidated raw project path was, and the escape fires on a later
   narrower run. Drives invariants 1, 3, 7.
2. [AI agent security: risks, controls and best practices — Checkmarx](https://checkmarx.com/learn/ai-security/ai-agent-security-risks-controls-and-best-practices)
   — Contributed the risk taxonomy: identity/permission sprawl, unsafe tool invocation and tool
   misuse, memory and context poisoning, prompt injection. Drives invariants 2 and 5.
3. [What a security review of an AI agent skill should cover — Backslash](https://www.backslash.security/learning/what-a-security-review-of-an-ai-agent-skill-should-cover)
   — Contributed review-scope-as-reach, hidden-instruction redirection of trusted skills, and the
   process-telemetry provenance gap. Drives invariants 5 and 6, plus §2.4/§2.6.
4. [From .env to Leakage: Mishandling of Secrets by Coding Agents — Knostic](https://www.knostic.ai/blog/claude-cursor-env-file-secret-leakage)
   — Directly on-niche: coding agents mishandling `.env` files and secrets, problem "not isolated
   to a single tool". Primary evidence for invariant 2 and §2.5; supports default redaction (6).
5. [Secrets leak in CI/CD pipelines — Truffle Security](https://trufflesecurity.com/blog/secrets-leak-in-ci-cd)
   — Adjacent-domain evidence that long-lived trusted executors holding credentials leak the
   pipeline environment. Supports invariant 2.
6. [Large-scale cloud extortion operation — Unit 42](https://unit42.paloaltonetworks.com/large-scale-cloud-extortion-operation)
   — Leaked environment variables scanned and exploited at scale. Supports invariant 2 and the
   reachable-set priority in §2.2 and §5.
7. [Container secrets in environment variables — Sourcery](https://www.sourcery.ai/vulnerabilities/container-secrets-environment-variables)
   — Secret exposure via env vars in startup scripts; shows isolation does not fix env inheritance.
   Supports invariant 2 and §3.4.
8. [Avoiding race conditions in secure programs — David A. Wheeler, Secure Programming HOWTO](https://dwheeler.com/secure-programs/Secure-Programs-HOWTO/avoid-race.html)
   — Insecure `mktemp(3)`/`tmpnam` and predictable-name races with symlink consequences. Primary
   evidence for invariant 4 and §3.3.
9. [glibc manual: `mkdtemp` (2.2.3)](https://ftp.gnu.org/old-gnu/Manuals/glibc-2.2.3/html_node/libc_285.html)
   — `mkdtemp` semantics: collides with no existing file, private directory. Supports the per-run
   `0700` directory pattern in §3.3.
10. [Secure temp file usage guidelines — OpenStack Security](https://security.openstack.org/guidelines/dg_using-temporary-files-securely.html)
    — Create/use/remove pattern; predictable filenames in shared temp dirs named as the
    anti-pattern. Primary practice evidence for invariant 4.
11. [How to create a temporary file in Linux — Softprayog](https://www.softprayog.in/programming/how-to-create-a-temporary-file-in-linux)
    — `O_EXCL` creation approaches and their limits. Supports §3.3 flag discussion.
12. [Vulnerability database: CVE-2026-62677 (Path traversal, CWE-22, Omnigent Agent Runner) — CodeAnt](https://codeant.ai/vulnerability-database/cve-2026-62677/copy)
    — Title-level only; page body extracted as navigation boilerplate. Cited solely as class-level
    corroboration that agent runners keep producing CWE-22.
13. Retracted, deliberately not used: `arxiv.org/html/2602.01655v1` — supplied as an agent-framework
    security analysis, but is ProjDevBench (agent benchmarking). No security claim in this document
    rests on it.
