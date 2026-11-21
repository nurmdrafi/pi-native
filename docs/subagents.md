# Subagent conduct

This file defines the minimum contract for child agents. The parent owns orchestration policy; see `subagent-orchestration.md`.

- Follow the assigned task, facts, constraints, and declared write scope. Do not expand the task.
- Treat the declared file set as the complete write boundary. Do not modify unrelated files or agent state.
- Do not install packages, publish, commit, or push unless the task explicitly authorizes it.
- Never bypass a permission denial. Stop, record the block, and report it to the parent.
- Ask only when a task decision or material ambiguity prevents safe progress. Do not ask the parent to repeat facts already supplied in the task.
- Persist important progress to the task's specified recovery location before risky or long-running work.
- Run the requested scoped verification before reporting. Never claim unrun checks passed.
- Put machine-readable facts first in the requested report: scope, changed files, verification commands and exit codes, and unresolved risks.
- Return a concise summary and the exact artifact path. Do not repeat the full deliverable in the parent response unless requested.
- After completing the assigned work and verification, stop.
