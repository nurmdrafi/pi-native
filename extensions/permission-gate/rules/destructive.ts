/** Destructive/mutating bash analysis (H2): env/git-flag
 * normalization, quote-aware segment splitting, destructive and mutating
 * matchers.
 *
 * TRIPWIRE, NOT A BOUNDARY: this is shell-text pattern matching, not parsing.
 * It catches the realistic unsanctioned shapes at command positions; a
 * determined rewrite escapes it. AGENTS.md discipline and the user's eyes are
 * the actual boundary. */
import { homedir } from "os";
import { realpathSync } from "fs";
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

const DESTRUCTIVE_BASH = new RegExp(
  CMD_POS_SRC +
    DESTRUCTIVE_CORE_SRC +
    // S4 fix 5 (2026-10-15, spec §6.5): a $VAR/${VAR} COMMAND WORD is
    // unclassifiable — it confirms, never silently allows. Anchored like the
    // core but NOT inside it: DESTRUCTIVE_ANYWHERE would then fire on every
    // $arg expansion (sed … $f, awk '{print $1}')
    String.raw`|` +
    CMD_POS_SRC +
    String.raw`\$\{?[A-Za-z_]\w*\}?(?=[\s;|&)]|$)` +
    // S4 fix 6 (§6.6): pipe-to-interpreter — unanchored on purpose (matches
    // anywhere in the segment, incl. inside sh -c "…" payloads); `bash
    // build.sh` (no pipe) and `| shasum` (no \b after sh) stay allowed
    String.raw`|\|\s*(?:ba|z|da|k)?sh\b(?![\w-])` +
    String.raw`|\b(?:DROP\s+(?:TABLE|DATABASE)|DELETE\s+FROM)\b|\bfind\b[^|;&]*\s-[a-zA-Z]*delete\b`,
  "i",
);
/** bash/sh -c "…" and $(…) hide payloads inside quotes — for wrapped segments the bare core is scanned anywhere */
const SHELL_WRAPPED = /\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*-c\b|\$\(/;
const DESTRUCTIVE_ANYWHERE = new RegExp(DESTRUCTIVE_CORE_SRC, "i");

/** S4 fix 9 (2026-10-18): bypass tripwires — inline-code interpreters, encoded
 * eval, alias indirection. Unscannable or obfuscated payloads confirm (H2). */
const INTERP_INLINE =
  /\b(?:perl|ruby|php|node|deno|bun)\b[^|;&]*\s(?:-e|--eval)\b|\bpython3?\b[^|;&]*\s-[cm]\b|\bawk\b[^|;&]*\bsystem\s*\(/i;
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
      const suffix =
        String.raw`/\.(?:bashrc|zshrc|profile|bash_profile|bash_aliases|bash_login|tmux\.conf|gitconfig)(?:/|$)` +
        String.raw`|` +
        String.raw`/\.(?:ssh|gnupg)/` +
        String.raw`|` +
        String.raw`/\.config/systemd/`;
      ppRe = new RegExp(
        String.raw`^(?:/etc|/usr|/var|/boot|/root)(?:/|$)` +
          homes.map((h) => String.raw`|^` + h + suffix).join(""),
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

export const segmentDestructive = (seg: string): boolean => {
  // S4 fix 9 (2026-10-18): NFKC fold first — homoglyph command words (ｒｍ) match
  const s = seg.normalize("NFKC");
  return (
    DESTRUCTIVE_BASH.test(s) ||
    // S4 fix 7 (§6.7): persistence redirect/tee targets — same protected-prefix
    // source as the write/edit realpath check (replaces the old /etc-only
    // redirect alternative)
    [...s.matchAll(REDIRECT_TARGET)].some((m) =>
      PROTECTED_PREFIX_RE.test(expandWrittenTarget(m[1])),
    ) ||
    [...s.matchAll(TEE_TARGET)].some((m) =>
      PROTECTED_PREFIX_RE.test(expandWrittenTarget(m[1])),
    ) ||
    (SHELL_WRAPPED.test(s) && DESTRUCTIVE_ANYWHERE.test(s)) ||
    // S4 fix 9 (2026-10-18): interpreter escapes, encoded eval, alias indirection
    INTERP_INLINE.test(s) ||
    EVAL_ENCODED.test(s) ||
    (/\balias\b/.test(s) && DESTRUCTIVE_ANYWHERE.test(s))
  );
};
export const APPROVED_WINDOW_MS = 2 * 60_000;

/** MUTATING/DESTRUCTIVE judged on the same env/git-flag-normalized segments as the tool_call path (2026-10-11) */
export const isMutatingCommand = (cmd: string): boolean =>
  splitSegments(cmd)
    .map(normalizeSegment)
    .some((s) => MUTATING_BASH.test(s) || segmentDestructive(s));



export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
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
      cur = "";
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
