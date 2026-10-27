# Proving a finding before publishing

Detail behind SKILL.md §4 Output.

Finding = claim about a bug — verify same way you'd verify a fix, then report. "Looks wrong" = hypothesis, not finding. Real false positives from this exact failure: `Form.List` handler `(name, checked)` compared vs numeric index looked like string/number bug, but `field.name` IS the numeric index (sibling file used it as array path `['rows', field.name, 'id']`) — correct code; `moment(x, 'YYYY/MM/DD')` parse looked like it fails on ISO date, but installed moment parses `'2000-05-15'`, `'2000/05/15'` + ISO timestamp identically. Both published before being checked.

Cheap verification, preference order:
- Run it — node one-liner, 3-case input table, unit test. Two seconds execution > paragraph inference.
- Read installed source (`node_modules/<pkg>/...`) for actual semantics, not remembered API.
- Read call site — what's actually passed (`field.name`, id source, payload consumer), not what parameter name suggests.

Unverifiable → label `[UNVERIFIED]`, state what would prove it. Never assign severity to unproven claim — severity implies confidence you lack; wrong medium+ wastes review time. Retracted-after-checking finding costs far less than published one.
