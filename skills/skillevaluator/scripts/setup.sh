#!/bin/sh
# Portable SkillEvaluator installer (macOS/Linux; Windows: use uv manually).
# Order: existing install -> uv tool -> pipx -> venv pip. Never sudo, never
# edits shell startup files. Idempotent: exits 0 when already installed.
set -eu
log() { printf '%s\n' "$*"; }

case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) log "ERROR: Windows host — install with: uv tool install --python 3.13 \"skillevaluator[all]\""; exit 1 ;; esac

if command -v skillevaluator >/dev/null 2>&1; then
  log "skillevaluator $(skillevaluator --version) already installed"
  exit 0
fi

# newest supported Python on this machine (3.12-3.14)
PY=""
for v in 3.14 3.13 3.12; do
  if command -v "python$v" >/dev/null 2>&1; then PY="python$v"; break; fi
done
[ -n "$PY" ] || { log "ERROR: no Python 3.12-3.14 found (need python3.12, python3.13, or python3.14)"; exit 1; }

if command -v uv >/dev/null 2>&1; then
  log "installing via uv tool (python $PY)"
  uv tool install --python "$PY" "skillevaluator[all]"
elif command -v pipx >/dev/null 2>&1; then
  log "installing via pipx (python $PY)"
  pipx install --python "$PY" "skillevaluator[all]"
else
  VENV="$HOME/.venvs/skillevaluator"
  log "no uv/pipx: venv at $VENV (python $PY)"
  "$PY" -m venv "$VENV"
  # shellcheck disable=SC1091
  . "$VENV/bin/activate"
  pip install --upgrade "skillevaluator[all]"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH"; export PATH
     log "NOTE: ~/.local/bin was missing from PATH — added for this session only" ;;
esac

command -v skillevaluator >/dev/null 2>&1 \
  || { log "ERROR: install ran but skillevaluator is not on PATH — run 'uv tool update-shell' yourself, or re-open the shell"; exit 1; }
log "installed: skillevaluator $(skillevaluator --version)"
