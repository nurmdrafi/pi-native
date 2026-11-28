import { readFileSync } from 'node:fs';

const homePath = /(?<![\w./:$~-])\/(?:Users|home)\/(?!<)[\w.-]+(?=\/|[\s'"`),;]|$)/;
const diff = readFileSync(0, 'utf8');
let inHunk = false;
let added = 0;
let violations = 0;
for (const line of diff.split('\n')) {
  if (line.startsWith('diff --git ')) inHunk = false;
  if (line.startsWith('@@ ')) inHunk = true;
  if (inHunk && line.startsWith('+')) {
    added++;
    if (homePath.test(line.slice(1))) violations++;
  }
}
if (violations) {
  console.error(`Portable diff check: ${violations} of ${added} added lines contain machine-specific home paths. See rules/portability.md.`);
  process.exitCode = 1;
}
