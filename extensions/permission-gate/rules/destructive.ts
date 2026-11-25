/** Destructive/mutating bash analysis (H2): env/git-flag
 * normalization, quote-aware segment splitting, destructive and mutating
 * matchers.
 *
 * TRIPWIRE, NOT A BOUNDARY: this is shell-text pattern matching, not parsing.
 * It catches the realistic unsanctioned shapes at command positions; a
 * determined rewrite escapes it. AGENTS.md discipline and the user's eyes are
 * the actual boundary. */
import { homedir, tmpdir } from "os";
import { join, dirname, basename, resolve } from "path";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { config } from "../loader.ts";


/**
 * H5/B20 (2026-10-08): successful bash commands that mutate the working tree —
 * they legitimize verify re-runs exactly like an edit/write tool call (R10's
 * mutationSeq only counted edit/write, so `npm test → git pull → npm test`
 * false-blocked). Only ever relaxes R10 (more allows), never blocks more.
 * 2026-10-11: git subcommands (add/commit/push/tag/branch/cherry-pick/revert),
 * rm/mv/cp/mkdir/touch, npm/pnpm ci, npm run *build*; the file-redirect
 * alternative is no longer segment-start-anchored (`cd x && make > out` used
 * to miss). Tested on git-global-flag-normalized segments like DESTRUCTIVE.
 */
/** 1a (2026-10-26): the managed command tables. Each entry is one command
 * family with a stable id + label. Fragments and order are byte-identical
 * to the pre-table regex blobs, so compiled matcher behavior cannot drift.
 * MUTATING feeds R10's mutationSeq (relaxation only) and stays builtin; the
 * confirm set (DESTRUCTIVE + SIDE_EFFECT) is config-managed below. */
interface CmdEntry {
  id: string;
  re: string;
  label: string;
}
const MUTATING_COMMANDS: CmdEntry[] = [
  { id: "git-write-ops", label: "git working-tree writes", re: String.raw`git\s+(?:pull|checkout|merge|rebase|stash|reset|restore|clean|rm|mv|add|commit|push|tag|branch|cherry-pick|revert)\b` },
  { id: "npm-install", label: "npm install/add/ci", re: String.raw`npm\s+(?:i|install|uninstall|add|ci)\b` },
  { id: "pnpm-install", label: "pnpm install/add/ci", re: String.raw`pnpm\s+(?:i|add|install|remove|ci)\b` },
  { id: "yarn-install", label: "yarn add/install/remove", re: String.raw`yarn\s+(?:add|install|remove)\b` },
  { id: "pip-install", label: "pip install", re: String.raw`pip3?\s+install\b` },
  { id: "fs-write-utils", label: "rm/mv/cp/mkdir/touch", re: String.raw`(?:\S*\/)?(?:rm|mv|cp|mkdir|touch)\b` },
  { id: "sed-inplace", label: "sed -i", re: String.raw`sed\s+[^|]*-i\b` },
  { id: "prettier-write", label: "prettier --write", re: String.raw`prettier\b[^|]*--write\b` },
  { id: "eslint-fix", label: "eslint --fix", re: String.raw`eslint\b[^|]*--fix\b` },
  { id: "js-build", label: "js package build scripts", re: String.raw`(?:npm|pnpm|yarn)\s+(?:run\s+)?\S*build\b` },
];
const MUTATING_CORE_SRC = MUTATING_COMMANDS.map((e) => e.re).join("|");
const CMD_POS_SRC = String.raw`(?:^|&&|\|\||;|\||\bdo\b|\bthen\b|\belse\b|\bdone\b|[{(]\s*|\bxargs\s+|\s-exec(?:dir)?\s+)\s*`;
const MUTATING_BASH = new RegExp(
  CMD_POS_SRC +
    MUTATING_CORE_SRC +
    String.raw`|(?<![=>!\-\d])(?:>>?)\s*(?!/?(?:dev|null|tmp)/?)[^\s&>]+`,
);

/**
 * H2 (2026-10-08, suite-evidence): commands that need explicit user approval
 * before running — the suite's must-ask tasks (t08 npm install, t09 git
 * reset --hard) failed 6/6 with AGENTS.md text alone: the model never asked.
 * With a UI (TUI/RPC) → ctx.ui.confirm dialog; headless/print → fail CLOSED
 * with a reason that tells the model to ask in chat and wait. This list is
 * the single home of the confirm set (moved out of the general ask-before
 * rule list, 2026-10-28 — the gate owns it). Approved commands are
 * remembered verbatim for 2 min so an immediate re-send (hook retry) does not
 * re-prompt.
 *
 * 2026-10-11 (user direction): git commit/push REMOVED from this set —
 * commitlint (R9) and hooks still guard commits. Root cause of the
 * intermittent /ship print-only stop: a mid-flow re-key of promptApproves
 * left `git push` to fail closed and the model fell back to printing the
 * message. commit/push stay in MUTATING_CORE_SRC (R10 mutationSeq).
 *
 * TRIPWIRE, NOT A BOUNDARY (2026-10-11): this is shell-text pattern matching,
 * not parsing. It catches the realistic unsanctioned shapes at command
 * positions — segment head, after ;/&&/||/|/do/then/else/{/(/xargs/-exec —
 * plus bash -c "…"/$(…) wrapped payloads (core scanned anywhere), `> /etc`
 * redirects, DROP TABLE/DELETE FROM, find -delete. Quoted prose ("then rm")
 * can false-positive; a determined rewrite (base64, perl -e, env rm) escapes.
 * AGENTS.md discipline and the user's eyes are the actual boundary.
 */
/** S-3 (2026-10-12, user direction) + 1a: remote/persistent side effects
 * needing the same confirm as installs/destructive ops — pipe-to-interpreter
 * script runs (curl|sh), DB migrations, deploys/releases. Inside CORE so
 * they're position-anchored (CMD_POS_SRC) and scanned anywhere inside sh -c /
 * $() wrapped payloads, like the rest of CORE. `curl|sudo sh` is already
 * covered by core `sudo`. */
const SIDE_EFFECT_COMMANDS: CmdEntry[] = [
  { id: "pipe-interpreter", label: "curl/wget piped to sh", re: String.raw`(?:curl|wget)\b[^|;&\n]*\|\s*(?:ba|z|da|fi)?sh\b(?![\w-])` },
  { id: "js-migrate-deploy", label: "js package migrate/deploy/publish", re: String.raw`(?:npx|npm|pnpm|yarn|bun)\s+(?:run\s+)?\S*(?:migrat|deploy|publish)\S*` },
  { id: "db-migrators", label: "orm/db migrators", re: String.raw`(?:npx\s+)?(?:\S*[/\\])?(?:prisma\s+(?:migrate|db\s+push)|knex\s+migrate|sequelize(?:-cli)?\s+db:migrate|alembic\s+(?:upgrade|downgrade)|flyway\s+migrate|db-migrate\s+up|migrate\b[^|;&\n]*\s(?:up|down))` },
  { id: "artisan-migrate", label: "laravel artisan migrate", re: String.raw`(?:php\s+)?(?:\S*[/\\])?artisan\s+migrate` },
  { id: "managepy-migrate", label: "django manage.py migrate", re: String.raw`python(?:3)?\s+manage\.py\s+migrate|(?:\S*[/\\])?manage\.py\s+migrate` },
  { id: "rake-db-migrate", label: "rails rake db:migrate", re: String.raw`rake\s+db:migrate` },
  { id: "dotnet-ef-update", label: "dotnet ef database update", re: String.raw`dotnet\s+ef\s+database\s+update` },
  { id: "deploy-clis", label: "deploy/infra clis", re: String.raw`(?:npx\s+)?(?:\S*[/\\])?(?:vercel|wrangler|serverless|sls|netlify|fly|flyctl|railway|terraform|tofu|cdk|pulumi|sst|kubectl|gcloud|aws|az)\b[^|;&\n]*(?:\s(?:deploy|apply|publish|up|destroy)|--prod)` },
];

/** H2 confirm set: destructive builtins + side-effect builtins, minus
 * config `destructive.remove` ids, plus validated `destructive.extra`
 * entries. Fail-closed: unknown ids warn and are ignored; invalid extra
 * patterns warn and are skipped — they never widen or throw. */
const DESTRUCTIVE_COMMANDS: CmdEntry[] = [
  { id: "sudo", label: "sudo", re: String.raw`sudo\b` },
  { id: "rm", label: "rm", re: String.raw`(?:\S*\/)?rm\b` },
  { id: "git-reset-hard", label: "git reset --hard", re: String.raw`git\s+reset\s+--hard` },
  { id: "git-clean", label: "git clean", re: String.raw`git\s+clean\b` },
  { id: "git-checkout-discard", label: "git checkout -- <path>", re: String.raw`git\s+checkout\s+--` },
  { id: "git-restore", label: "git restore", re: String.raw`git\s+restore\b` },
  { id: "npm-install", label: "npm install/add", re: String.raw`npm\s+(?:i|install|uninstall|add)\b` },
  { id: "pnpm-install", label: "pnpm install/add", re: String.raw`pnpm\s+(?:i|add|install|remove)\b` },
  { id: "yarn-install", label: "yarn add/install", re: String.raw`yarn\s+(?:add|install|remove)\b` },
  { id: "pip-install", label: "pip install", re: String.raw`pip3?\s+install\b` },
  { id: "brew-install", label: "brew install", re: String.raw`brew\s+install\b` },
  { id: "apt-install", label: "apt install", re: String.raw`apt(?:-get)?\s+install\b` },
  { id: "mkfs", label: "mkfs", re: String.raw`mkfs(?:\.\w+)?\b` },
  { id: "dd-disk", label: "dd raw disk write", re: String.raw`dd\s+if=` },
];

const CONFIRM_BUILTINS = [...DESTRUCTIVE_COMMANDS, ...SIDE_EFFECT_COMMANDS];
const warnDestructive = (msg: string): void =>
  console.error(`[permission-gate] ${msg}`);

const knownIds = new Set(CONFIRM_BUILTINS.map((e) => e.id));
for (const id of config.destructive.remove)
  if (!knownIds.has(id))
    warnDestructive(`unknown destructive.remove id "${id}" — ignored (ids: ${[...knownIds].join(", ")})`);
const EXTRA_ENTRIES: CmdEntry[] = [];
for (const x of config.destructive.extra) {
  try {
    new RegExp(x.pattern);
  } catch {
    warnDestructive(`invalid destructive.extra pattern for "${x.id}" — skipped`);
    continue;
  }
  EXTRA_ENTRIES.push({ id: x.id, re: x.pattern, label: x.label ?? x.id });
}
export const CONFIRM_SET: CmdEntry[] = CONFIRM_BUILTINS.filter(
  (e) => !config.destructive.remove.includes(e.id),
).concat(EXTRA_ENTRIES);
/** Entry ids of the applied confirm set — the manageability surface
 * (config.json remove/extra work against these ids). */
export const confirmEntryIds = (): string[] => CONFIRM_SET.map((e) => e.id);

// The (?:…​) wrap is load-bearing: CMD_POS_SRC must anchor the WHOLE
// alternation. Ungrouped, every entry after the first matches anywhere —
// `echo rm x` confirmed without a command-position rm (caught by the 1a
// corpus, 2026-10-26). MUTATING stays ungrouped because it always was.
const DESTRUCTIVE_CORE_SRC = `(?:${CONFIRM_SET.map((e) => e.re).join("|")})`;

/** /yolo lane (user direction 2026-11-12): the git-family confirm entries
 * are part of the bypass, so the except-git judge needs the same
 * construction over the non-git entries only. Empty (config removed every
 * non-git id) matches nothing — never widens. */
const CONFIRM_SET_NON_GIT = CONFIRM_SET.filter((e) => !e.id.startsWith("git-"));
const DESTRUCTIVE_CORE_NON_GIT_SRC = CONFIRM_SET_NON_GIT.length
  ? `(?:${CONFIRM_SET_NON_GIT.map((e) => e.re).join("|")})`
  : "(?!)";

const DESTRUCTIVE_BASH_SUFFIX =
  // S4 fix 6 (§6.6): pipe-to-interpreter — unanchored on purpose (matches
  // anywhere in the segment, incl. inside sh -c "…" payloads); `bash
  // build.sh` (no pipe) and `| shasum` (no \b after sh) stay allowed.
  // 2026-11-07 HIGH fix: the family after the pipe extends past sh — a
  // decoded payload piped into any script interpreter (`echo <b64> |
  // base64 -d | node`) is the same unscannable-exec lane as curl|sh. The
  // new words require whitespace BEFORE the bar: real shell pipes leave
  // one, while a quoted pattern's alternation inside a word
  // (`rg "node -e|python3 -c"`, 16.3 pin) does not.
  // 2026-11-19: the sh alternative gets the same `(?<=\s)` — a quoted
  // alternation like `rg '...(Destructive|Bash ...'` has no space before
  // the bar but matched `\|\s*(?:ba)?sh` and blocked a read-only search.
  String.raw`|(?<=\s)\|\s*(?:ba|z|da|k)?sh\b(?![\w-])` +
  String.raw`|(?<=\s)\|\s*(?:node(?:js)?|python3?|perl|ruby|php|deno|bun)\b(?![\w-])` +
  String.raw`|\b(?:DROP\s+(?:TABLE|DATABASE)|DELETE\s+FROM)\b|\bfind\b[^|;&]*\s-[a-zA-Z]*delete\b`;

const DESTRUCTIVE_BASH = new RegExp(
  CMD_POS_SRC + DESTRUCTIVE_CORE_SRC + DESTRUCTIVE_BASH_SUFFIX,
  "i",
);
const DESTRUCTIVE_BASH_NON_GIT = new RegExp(
  CMD_POS_SRC + DESTRUCTIVE_CORE_NON_GIT_SRC + DESTRUCTIVE_BASH_SUFFIX,
  "i",
);
/** bash/sh -c "…" and $(…) hide payloads inside quotes — for wrapped segments the bare core is scanned anywhere */
const SHELL_WRAPPED = /\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*-c\b|\$\(/;
const DESTRUCTIVE_ANYWHERE = new RegExp(DESTRUCTIVE_CORE_SRC, "i");

/** S4 fix 9 (2026-10-18): bypass tripwires — inline-code interpreters, encoded
 * eval, alias indirection. Unscannable or obfuscated payloads confirm (H2). */
/** S4 fix 9 (2026-10-18): bypass tripwires — inline-code interpreters, encoded
 * eval, alias indirection. Unscannable or obfuscated payloads confirm (H2).
 * 16.3 (2026-11-02 audit): the interpreter token now has to sit at execution
 * position — segment start (after env assignments and known wrappers) or right
 * after a command-substitution opener. Unanchored matching confirmed a quoted
 * mention (`rg -n "node -e" docs`) as destructive although nothing ran, which
 * blocked read-only review children probing their own docs.
 * Phase 2 (audit A13, 2026-11-18): osascript -e joins the list — an inline
 * AppleScript payload is the same unscannable-exec lane. */
const INTERP_INLINE = new RegExp(
  "(?:^|`|\\$\\(\\s*)" +
    "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*" +
    "(?:(?:sudo|env|command|nohup|time|nice|xargs)\\s+(?:-\\S+\\s+)*)*" +
    "(?:\\b(?:perl|ruby|php|node|deno|bun|osascript)\\b[^|;&]*\\s(?:-e|--eval)\\b" +
    "|\\bpython3?\\b[^|;&]*\\s-[cm]\\b" +
    "|\\bawk\\b[^|;&]*\\bsystem\\s*\\()",
  "i",
);
const EVAL_ENCODED = /\beval\b[^|;&]*(?:\$\(|`)/;

/** S4 fixes 7+8 (2026-10-15, spec §6.7–8): the single protected-prefix
 * source, shared by the bash redirect/tee target check below and the
 * write/edit realpath confirm in index.ts. RegExp-shaped but rebuilt when
 * os.homedir() changes — the S4 canary suite runs the gate under a fake
 * HOME, and ~/.ssh there must confirm exactly like the real one.
 * System trees: /etc /usr /var /boot /root; home: rc files, ~/.ssh/,
 * ~/.gnupg/, ~/.config/systemd/. */
let ppHome = "";
let ppRe: RegExp | undefined;
/** A2 (2026-11-18): the gate's own tree is protected control plane — writes,
 * edits, and bash redirects into extensions/permission-gate confirm like any
 * protected path, closing the self-modify seam where a config.json edit
 * armed on the next process. The write/edit lanes additionally require the
 * chat phrase "gate maintenance" (index.ts) — the redirect lane asks through
 * the ordinary H2 ladder. */
const GATE_DIR = (() => {
  try {
    return realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch {
    return "";
  }
})();
/** Single source of the home-tree protection suffix (rc files, .ssh,
 * .gnupg, systemd) — consumed by the ppRe builder below and by the
 * tmp-allowance ranking (home protection outranks scratch: credentials
 * stay protected even when a sandbox parks HOME under a tmp root). */
const PROTECTED_HOME_SUFFIX_SRC =
  String.raw`/\.(?:bashrc|zshrc|profile|bash_profile|bash_aliases|bash_login|tmux\.conf|gitconfig)(?:/|$)` +
  String.raw`|` +
  String.raw`/\.(?:ssh|gnupg)/` +
  String.raw`|` +
  String.raw`/\.config/systemd/`;
const HOME_PROTECTED = new RegExp(PROTECTED_HOME_SUFFIX_SRC);

/** Tmp allowance as a JUDGMENT (not a location): scratch under a tmp root
 * is free EXCEPT credentials/rc files and the gate's own tree — those keep
 * their protected confirm wherever they live. Used wherever the allowance
 * could cancel a protected verdict (write/edit lane, redirect/tee judges). */
export const tmpAllowed = (real: string): boolean =>
  isTmpAllowPath(real) &&
  !HOME_PROTECTED.test(real) &&
  !(GATE_DIR !== "" && (real === GATE_DIR || real.startsWith(GATE_DIR + "/")));

export const PROTECTED_PREFIX_RE = {
  test(p: string): boolean {
    // Compare in realpath space. Callers pass an already-realpathed target, so
    // an unresolved home never matches where a path component is a symlink
    // (macOS: /var -> /private/var, /tmp -> /private/tmp). That missed every
    // protected write routed through a symlinked temp dir.
    const raw = homedir();
    let resolved = raw;
    try {
      resolved = realpathSync(raw);
    } catch {}
    if (!ppRe || resolved !== ppHome) {
      ppHome = resolved;
      const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      // Homes are tried in both spellings so callers that hand over a raw
      // (non-realpathed) path — e.g. bash redirect targets — still match.
      const homes = [resolved, raw].filter((v, i, a) => a.indexOf(v) === i).map(esc);
      const suffix = PROTECTED_HOME_SUFFIX_SRC;
      ppRe = new RegExp(
        String.raw`^(?:/etc|/usr|/var|/boot|/root)(?:/|$)` +
          homes.map((h) => String.raw`|^` + h + suffix).join("") +
          (GATE_DIR ? String.raw`|^` + GATE_DIR.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) + String.raw`(?:/|$)` : ""),
      );
    }
    return ppRe.test(p);
  },
};
/** `~/.ssh/x` / `$HOME/.ssh/x` as written in command text → absolute, then
 * judged against PROTECTED_PREFIX_RE (quoted forms are the documented
 * tripwire miss, same class as the rest) */
const expandWrittenTarget = (t: string) =>
  t.replace(/^~\//, homedir() + "/").replace(/^\$HOME\//, homedir() + "/");
const REDIRECT_TARGET = /(?<![=>!\-\d])(?:>>?)\s+([^\s&>]+)/g;
const TEE_TARGET = /\btee(?:\s+-[a-zA-Z][a-zA-Z0-9]*)*\s+([^\s|;&)]+)/g;

/** System trees in RESOLVED space — darwin resolves /etc|/usr|/var to
 * /private/*, so a realpathed target needs its own list. Kept separate
 * from PROTECTED_PREFIX_RE (raw space, homes-aware): the write/edit lane
 * tests only the resolved path and predates this list — extending the
 * shared regex there would protect every darwin $TMPDIR sandbox; the bash
 * lane below judges both spellings. */
const PROTECTED_RESOLVED =
  /^(?:\/etc|\/usr|\/var|\/boot|\/root|\/private\/etc|\/private\/usr|\/private\/var)(?:\/|$)/;

/** Redirect/tee target judgment (2026-11-19): resolve the written target
 * first — the raw text and the realpath can differ on both sides. Tmp
 * allowance wins in resolved space (macOS $TMPDIR sits under protected
 * /var; the allowance names the sanctioned per-user scratch); otherwise
 * the target confirms when EITHER spelling hits a protected prefix, so a
 * symlinked final hop into a system tree cannot launder the write. */
const protectedWrittenTarget = (raw: string): boolean => {
  const t = expandWrittenTarget(raw);
  const real = realpathish(t);
  if (tmpAllowed(real)) return false;
  return PROTECTED_PREFIX_RE.test(t) || PROTECTED_RESOLVED.test(real);
};

/** Phase 2 (audit A6, 2026-11-18): an inline-interpreter payload confirms on
 * its BODY's deletion/unlink vocabulary — never on where its stdout lands
 * (the `node -e` arithmetic false positive confirmed on a /tmp redirect and
 * rerouted writers into scratch files; 2026-11-02's .cache destination
 * exemption is subsumed — destinations no longer matter to this judge).
 * Vocabulary stays deletion-only — rm/rmdir/unlink semantics plus
 * AppleScript deletion (A13); moves and writes are not destructive confirms.
 * 2026-11-18 code review (finding 4): argument-or-call shapes, not bare
 * words — a dotted member (fs.rm, os.unlink), a call paren, or an argument
 * token after rm/unlink. A word with NO argument (`console.log("rm")`,
 * "the rm case") is prose and must not confirm; `rm <arg>` keeps confirming
 * (an embedded-shell `system("rm canary")` is the same shape as prose —
 * accepted confirm-only FP, deletion asymmetry wins). */
const INTERP_BODY_DESTRUCTIVE =
  /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:rm|rmdir)|promises\.(?:rm|rmdir))\b|\.(?:rm|unlink|rmdir)(?:Sync)?\b|\b(?:rm|unlink|rmdir)(?:Sync)?\s*\(|\b(?:rm|unlink)\s+\S|\brm\s+-[a-zA-Z]*[rRf]|\btell\s+application\b[^\n]*\b(?:delete|empty\s+trash)\b/;

/** Realpath with the write-lane fallback: an unresolvable tail still
 * judges against its realpathed parent, so a not-yet-created target keeps
 * its tree. Exported — index.ts judges confinement in the same space. */
export const realpathish = (abs: string): string => {
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs; // unresolvable — judge the path as written
    }
  }
};

/** Tmp allowance (user direction 2026-11-19): /tmp and the OS tmp dir are
 * agent scratch — never protected, never write-confined, parents and
 * subagents alike (scout durability files, spill slices). macOS parks
 * $TMPDIR under /var, a protected system tree, so the prefix test alone
 * would confirm every scratch redirect. PGATE_TMP_ROOTS (colon-separated)
 * replaces the default pair — test sandboxes pin it to stay confinable;
 * read per call so a process can retarget mid-run. Write-then-execute from
 * a tmp tree still confirms (index.ts): scratch is not execution. */
export const tmpAllowRoots = (): string[] => {
  const raw = process.env.PGATE_TMP_ROOTS;
  const roots = raw ? raw.split(":").filter(Boolean) : ["/tmp", tmpdir()];
  return [...new Set(roots.map(realpathish))];
};
export const isTmpAllowPath = (p: string): boolean =>
  tmpAllowRoots().some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));

/** Structural destructive signals shared by both judges: protected
 * redirect/tee targets, wrapped payloads, interpreter escapes, encoded
 * eval, alias indirection. One home — the judges never drift. */
const structuralDestructive = (s: string): boolean =>
  // S4 fix 7 (§6.7): persistence redirect/tee targets — same protected-prefix
  // source as the write/edit realpath check (replaces the old /etc-only
  // redirect alternative)
  [...s.matchAll(REDIRECT_TARGET)].some((m) => protectedWrittenTarget(m[1] ?? "")) ||
  [...s.matchAll(TEE_TARGET)].some((m) => protectedWrittenTarget(m[1] ?? "")) ||
  (SHELL_WRAPPED.test(s) && DESTRUCTIVE_ANYWHERE.test(s)) ||
  // S4 fix 9 (2026-10-18): interpreter escapes, encoded eval, alias indirection
  // 2026-11-18 (audit A6): the inline-interpreter tripwire judges the BODY's
  // own vocabulary only — never where a benign payload's stdout lands (the
  // `node -e` arithmetic false positive); protected redirects confirm above,
  // and the planted-file follow-up is index.ts's write-then-execute signal.
  (INTERP_INLINE.test(s) && INTERP_BODY_DESTRUCTIVE.test(s)) ||
  EVAL_ENCODED.test(s) ||
  (/\balias\b/.test(s) && DESTRUCTIVE_ANYWHERE.test(s));

/** S4 fix 5 (2026-10-15, spec §6.5): a $VAR/${VAR} COMMAND WORD is
 * unclassifiable — it confirms, never silently allows. Anchored like the
 * core but NOT inside DESTRUCTIVE_BASH: DESTRUCTIVE_ANYWHERE would then
 * fire on every $arg expansion (sed … $f, awk '{print $1}').
 * 2026-11-22 (harness-watch misfire): judged on single-quote-stripped text —
 * command position never occurs inside single quotes, so a $VAR seen only
 * there is jq/awk program data ("($s|length)" grouping read as a subshell
 * running $s and blocked read-only analysis pipelines). An unpaired quote
 * strips nothing, so prose apostrophes stay fail-closed. */
const VAR_CMD_WORD = new RegExp(
  CMD_POS_SRC + String.raw`\$\{?[A-Za-z_]\w*\}?(?=[\s;|&)]|$)`,
  "i",
);
const stripSingleQuoted = (s: string): string => s.replace(/'[^']*'/g, "''");

export const segmentDestructive = (seg: string): boolean => {
  // S4 fix 9 (2026-10-18): NFKC fold first — homoglyph command words (ｒｍ) match
  const s = seg.normalize("NFKC");
  return (
    DESTRUCTIVE_BASH.test(s) ||
    VAR_CMD_WORD.test(stripSingleQuoted(s)) ||
    structuralDestructive(s)
  );
};

/** /yolo judge (user direction 2026-11-12): identical to
 * segmentDestructive except the git-family confirm entries are exempt —
 * git push/history asks auto-approve under the bypass. A segment matching
 * a git entry AND any other signal (sudo, rm, protected redirect, …)
 * still confirms: only git-only segments pass. */
export const segmentDestructiveExceptGit = (seg: string): boolean => {
  const s = seg.normalize("NFKC");
  return (
    DESTRUCTIVE_BASH_NON_GIT.test(s) ||
    VAR_CMD_WORD.test(stripSingleQuoted(s)) ||
    structuralDestructive(s)
  );
};
export const APPROVED_WINDOW_MS = 2 * 60_000;

/** MUTATING/DESTRUCTIVE judged on the same env/git-flag-normalized segments as the tool_call path (2026-10-11) */
export const isMutatingCommand = (cmd: string): boolean =>
  splitSegments(cmd)
    .map(normalizeSegment)
    .some((s) => MUTATING_BASH.test(s) || segmentDestructive(s));



/** 16.1 (2026-11-02): heredoc opener at a segment's end — `<<TAG`, `<<-TAG`,
 * `<<'TAG'`, `<<"TAG"` (optional whitespace). `<<` is bounded on both sides so
 * `<<<` here-strings never arm a body; quotes are stripped from the tag as
 * written. Known simplification: multiple openers on one line arm only the
 * last tag — earlier bodies are swallowed by its body, still never scanned. */
const HEREDOC_OPENER =
  /(?<!<)<<(?!<)(-?)\s*(?:"([^"\s]+)"|'([^'\s]+)'|([^\s'";&|<>]+))\s*$/;
/** Phase 2 (audit A7, 2026-11-18): heredoc openers that feed an interpreter
 * run their body as code. Two families: shell words (re-emitted body lines
 * judge as plain shell segments) and inline-code interpreters (destructive
 * body lines re-emit as the equivalent inline call). Non-interpreter openers
 * (cat, wc, psql…) keep the 16.1 rule — body lines are data. */
const INTERP_OPENER_WORD =
  /\b(?:python3?|node|deno|bun|perl|ruby|php|osascript|(?:ba|z|da|k)?sh)\b/i;
const INLINE_CODE_WORD = /\b(?:python3?|node|deno|bun|perl|ruby|php|osascript)\b/;
const heredocOf = (seg: string) => {
  const m = HEREDOC_OPENER.exec(seg);
  if (!m) return undefined;
  const tag = m[2] ?? m[3] ?? m[4];
  if (!tag) return undefined;
  // 2026-11-18 code review (finding 6): the interpreter word must sit in the
  // COMMAND position before `<<` — a delimiter named like an interpreter
  // (`cat <<node`) feeds cat, and its body stays data.
  const word = INTERP_OPENER_WORD.exec(seg.slice(0, m.index))?.[0]?.toLowerCase();
  return { tag, stripTabs: m[1] === "-", word };
};

/** 2026-11-07 HIGH fix: a heredoc feeding a shell runs its body —
 * `sh <<EOF … rm -rf …` hid the destructive line as "data". A body line
 * that STARTS with a confirm-set command word is re-emitted as a segment
 * so the destructive analyzers judge it; mid-line prose mentions
 * (`cost = $5; rm -rf / is quoted prose`) stay data per the 16.1 pins. */
const HEREDOC_BODY_CMD = new RegExp(`^\\s*(?:${DESTRUCTIVE_CORE_SRC})`, "i");

export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  // 16.1: a segment ending in an opener ARMS a heredoc — the body starts at
  // the NEXT newline, so `; && ||` continuations on the opener line
  // (`cat <<EOF && rm x`) keep scanning normally until it arrives. Body lines
  // are data, not commands (markdown bodies quoting interpreter-escape prose
  // blocked three review children on /tmp durability writes); only the opener
  // segment is emitted and scanned. Delimiter match: raw body line, leading
  // tabs stripped first for `<<-`, exact equality with the (unquoted) tag.
  let armed: { tag: string; stripTabs: boolean; word?: string } | undefined;
  let heredoc: { tag: string; stripTabs: boolean; word?: string } | undefined;
  let line = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (heredoc) {
      if (ch === "\n") {
        // CRLF (review-16a F1): the opener regex's \s*$ eats the opener line's
        // \r, so the delimiter word is bare `TAG` — strip this line's \r too,
        // else `TAG\r` never closes the heredoc and every later line is
        // swallowed unscanned (bash keeps \r inside the word and closes).
        const raw = (heredoc.stripTabs ? line.replace(/^\t+/, "") : line).replace(
          /\r$/,
          "",
        );
        if (raw === heredoc.tag) heredoc = undefined;
        // 2026-11-07 HIGH fix: a destructive body line is re-emitted as its
        // own segment — heredoc-fed shells must not launder `rm -rf` past
        // the confirm. Prose mid-line mentions stay dropped (16.1 pins).
        // 2026-11-18 (audit A7): an opener that names an interpreter feeds a
        // PROGRAM — its body is additionally judged on interpreter-destructive
        // words mid-line. sh-family openers re-emit the line raw (plain shell
        // judging covers command words and substitutions); inline-code openers
        // re-emit the equivalent inline call so the interp judge sees the body.
        else if (HEREDOC_BODY_CMD.test(raw)) out.push(raw);
        else if (heredoc.word && INTERP_BODY_DESTRUCTIVE.test(raw)) {
          out.push(
            INLINE_CODE_WORD.test(heredoc.word)
              ? `${heredoc.word} ${/^python/.test(heredoc.word) ? "-c" : "-e"} ${raw}`
              : raw,
          );
        }
        line = "";
      } else {
        line += ch;
      }
      continue; // body chars are prose — never split, never quote-tracked
    }
    if (quote) {
      if (ch === "\\") {
        cur += ch + (cmd[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (cmd[i + 1] ?? ""); // unquoted \; \& \| — literals, not separators
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (ch === "\n" || ch === ";" || two === "&&" || two === "||") {
      out.push(cur);
      const opener = heredocOf(cur);
      if (opener) armed = opener;
      cur = "";
      if (ch === "\n") {
        heredoc = armed;
        armed = undefined;
      }
      if (two === "&&" || two === "||") i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** S-2 (2026-10-09, /ship-flow autoresearch): leading VAR=value assignments
 * (`GIT_TERMINAL_PROMPT=0 git push`) precede the subcommand and hid it from
 * the ^-anchored destructive/R9 matches — strip them first so an
 * env-prefixed mutation can never skip the confirm (B18's -C class of miss). */
const stripEnvPrefix = (seg: string) =>
  seg.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']+)\s+)+/, "");

/** S4 fix 4 (2026-10-15, spec §6.4): transparent wrappers — `env rm x`,
 * `command rm x`, `exec`, `nohup`, `timeout 5 rm x`, `nice [-n 5] rm x` —
 * relocate the real command off the ^-anchored match positions. Stripped in
 * a loop with the env-assignment prefix because they stack
 * (`nohup env FOO=1 rm x`). Flag forms of the bare words are NOT stripped:
 * `command -v rm` stays a builtin lookup, never a wrapped destructive. */
const TRANSPARENT_PREFIX = new RegExp(
  String.raw`^(?:env|command|exec|nohup)\b[ \t]+` +
    String.raw`|^timeout\s+(?:-{1,2}\S+\s+)*\d+(?:\.\d+)?[smh]?\s+` +
    String.raw`|^nice\s+(?:-n\s+)?[+-]?\d+(?:\.\d+)?\s+` +
    String.raw`|^nice\b[ \t]+`,
);

/** item 1 (2026-10-11): strip env prefixes AND git global flags (-C dir,
 * --no-pager, -c k=v) once per segment — destructive and R9 both
 * judge the normalized segment, so `git -C . push` confirms like `git push`.
 * S4 fix 4: loops to a fixpoint so transparent wrappers and env assignments
 * strip in any stacking order. */
export const normalizeSegment = (seg: string) => {
  let s = seg;
  for (;;) {
    const next = stripEnvPrefix(s)
      .replace(TRANSPARENT_PREFIX, "")
      .replace(
        /^git\s+((-[A-Za-z]\s+\S+|--[a-z-]+(?:=\S+)?|-[A-Za-z]+)(\s+|$))*/,
        "git ",
      );
    if (next === s) return s;
    s = next;
  }
};

/** what counts as chat approval of destructive work (AGENTS.md Safety:
 * approval in the invoking message counts — incl. /ship, /issue, /update-changelog) */
export const APPROVAL_RE =
  /\b(?:yes|y|approve[ds]?|go[ -]ahead|run it|do it|proceed|ship it)\b|^\/(?:ship|issue|update-changelog)\b/im;

/** Phase 6 (audit A12): negation-hardened approval. An affirmative riding a
 * negation is a refusal — "don't proceed", "no, do not run it", "not
 * approved" previously armed the destructive bypass. The pre-scan voids
 * any match whose clause (text since the last sentence boundary) contains
 * a negation word before the affirmative; clean matches in other
 * sentences still count. Slash-command invocations are explicit commands,
 * not prose — they always count. */
const NEGATION_WORD =
  /\b(?:no|not|never|don'?t|dont|do\s+not|stop|can(?:not|'t)|won'?t|will\s+not|neither|nor)\b/i;
const CLAUSE_BOUNDARY = /[.!?\n]/;
/** matchAll needs the global flag; a g-clone of the immutable APPROVAL_RE
 * (matchAll clones again per call, so lastIndex state never leaks) */
const APPROVAL_GLOBAL = new RegExp(APPROVAL_RE.source, APPROVAL_RE.flags + "g");
export const approvalIn = (text: string): boolean => {
  for (const m of text.matchAll(APPROVAL_GLOBAL)) {
    if (m[0].startsWith("/")) return true; // slash-command invocation
    const before = text.slice(0, m.index ?? 0);
    let start = 0;
    for (let i = before.length - 1; i >= 0; i--)
      if (CLAUSE_BOUNDARY.test(before[i])) {
        start = i + 1;
        break;
      }
    if (!NEGATION_WORD.test(before.slice(start))) return true;
  }
  return false;
};

/** Phase 2 (audit A6, 2026-11-18): write-then-execute — the lane the A6
 * body-judging relaxation opens (a benign inline body planting a scratch
 * file, then running it). index.ts records every /tmp redirect/tee target
 * per session (as written, plus realpath so symlink spellings match);
 * a later command in the SAME session executing one of those paths — at
 * command position or as an operand of a shell/script interpreter — is the
 * planted-payload shape and confirms through the ordinary ladder. The pure
 * halves live here so segment logic keeps one home; session state resets on
 * session_start. Benign re-reads (cat/grep/wc) never match: only execution
 * positions do. */
const TMP_WRITE_PREFIX = /^\/(?:private\/)?tmp\//;
/** ALL written targets (redirect + tee, expanded) of one segment — raw
 * material for the /tmp recording below and the protected-lane checks. */
export const writtenTargetsOf = (seg: string): string[] =>
  [
    ...[...seg.matchAll(REDIRECT_TARGET)].map((m) => m[1]),
    ...[...seg.matchAll(TEE_TARGET)].map((m) => m[1]),
  ].map(expandWrittenTarget);

/** /tmp write targets of one segment, as written (realpath appended when it
 * resolves — macOS /tmp is /private/tmp; a not-yet-written target still
 * matches by its written spelling). */
export const tmpWriteTargetsOf = (seg: string): string[] => {
  const out: string[] = [];
  for (const t of writtenTargetsOf(seg)) {
    // 2026-11-19: every tmp-allow root records planted files, not just
    // literal /tmp spellings — the seam follows the allowance wherever it
    // points (darwin $TMPDIR sits outside /tmp).
    if (!TMP_WRITE_PREFIX.test(t) && !isTmpAllowPath(realpathish(t))) continue;
    out.push(t);
    try {
      const rp = realpathSync(t);
      if (rp !== t) out.push(rp);
    } catch {
      /* not on disk yet — the written spelling still matches */
    }
  }
  return out;
};
/** interpreters whose file operand EXECUTES that file (osascript included,
 * A13). A bare word before the interpreter must be a pipe or a transparent
 * wrapper — `grep bash <file>` is a pattern, not an execution. */
const TMP_EXEC_INTERP =
  /^(?:python3?|node|deno|bun|osascript|(?:ba|z|da|k)?sh)$/;
const TMP_EXEC_WRAPPER = /^(?:sudo|env|command|exec|nohup|nice|xargs)$/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** the recorded path this command executes (command position or interpreter
 * operand), or undefined when it only reads/mentions recorded paths */
export const executesRecordedTmpTarget = (
  segs: string[],
  recorded: Set<string>,
): string | undefined => {
  for (const seg of segs) {
    // the segment's OWN redirect/tee targets are destinations, not operands
    // — `node -e '1+1' > /tmp/fp.js` writes the file, it does not run it
    const own = new Set(tmpWriteTargetsOf(seg));
    const toks = seg
      .split(/\s+/)
      .map((t) => t.replace(/^["']+|["']+$/, ""));
    // 2026-11-18 code review (finding 3): env assignments and transparent
    // wrappers may precede the command word — FOO=1 /tmp/fp.js and
    // sudo /tmp/fp.js execute the planted file just the same.
    let start = 0;
    while (
      start < toks.length &&
      (ENV_ASSIGN.test(toks[start]) || TMP_EXEC_WRAPPER.test(toks[start]))
    )
      start++;
    if (start < toks.length && recorded.has(toks[start]) && !own.has(toks[start]))
      return toks[start];
    for (let i = 0; i < toks.length; i++) {
      if (!TMP_EXEC_INTERP.test(toks[i])) continue;
      if (
        i > 0 &&
        toks[i - 1] !== "|" &&
        !TMP_EXEC_WRAPPER.test(toks[i - 1])
      )
        continue;
      for (let j = i + 1; j < toks.length; j++)
        if (recorded.has(toks[j]) && !own.has(toks[j])) return toks[j];
    }
  }
  return undefined;
};

/** 2026-11-18 code review (findings 1-2): resolve a written/copied target the
 * way the shell would — cwd-relative when not absolute — then compare in
 * realpath space. Returns the resolved target when it lands in a protected
 * tree (the gate's own tree included since A2), else undefined. */
const protectedTarget = (t: string, cwd?: string): string | undefined => {
  const abs = t.startsWith("/") ? t : cwd ? resolve(cwd, t) : t;
  // 2026-11-19: resolve nonexistent tails through their parent so a raw
  // /var spelling of a darwin $TMPDIR target lands in realpath space; the
  // tmp allowance is judged there BEFORE the protected test — scratch wins
  // over the system-tree prefix it happens to sit under.
  const real = realpathish(abs);
  if (tmpAllowed(real)) return undefined;
  return PROTECTED_PREFIX_RE.test(real) || PROTECTED_RESOLVED.test(real)
    ? real
    : undefined;
};

/** Finding 1: a relative redirect/tee target into a protected tree. The
 * structural judge sees absolute spellings only; from the agent-home cwd
 * the relative form is the common one. */
export const protectedWrittenTargetOf = (
  seg: string,
  cwd?: string,
): string | undefined => {
  for (const t of writtenTargetsOf(seg)) {
    const hit = protectedTarget(t, cwd);
    if (hit) return hit;
  }
  return undefined;
};

/** Finding 2: cp/mv/install/rsync place files without a redirect — the
 * final operand is the destination. Flag tokens are skipped; fewer than two
 * operands is not a copy. copyTargetOf returns the raw destination (A12b
 * approval stat key, A9 write binding); protectedCopyTargetOf judges it
 * against the protected prefixes as before. */
const COPY_CMD = /^(?:sudo\s+|env\s+\S*\s+|command\s+)?(?:cp|mv|install|rsync)\b/;
export const copyTargetOf = (seg: string): string | undefined => {
  const head = COPY_CMD.exec(seg)?.[0] ?? "";
  if (!head) return undefined;
  const operands = seg
    .slice(head.length)
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/, ""))
    .filter((t) => t && !t.startsWith("-"));
  if (operands.length < 2) return undefined;
  return operands[operands.length - 1];
};
export const protectedCopyTargetOf = (
  seg: string,
  cwd?: string,
): string | undefined => {
  const dest = copyTargetOf(seg);
  return dest === undefined ? undefined : protectedTarget(dest, cwd);
};
