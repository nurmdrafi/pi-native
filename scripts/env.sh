# BASH_ENV target for non-interactive shells (daemon-spawned pibash): load
# nvm so node/npm/npx resolve without per-command `nvm use` prefixes.
# Sourcing nvm.sh costs ~200ms, so skip entirely when node already resolves
# (shells spawned from an interactive parent pay nothing). Idempotent and
# silent; safe when nvm is absent (system node stays as-is).
command -v node >/dev/null 2>&1 || {
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
}
