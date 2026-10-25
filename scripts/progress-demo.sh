#!/bin/sh
# progress-demo.sh — preview the after-pull progress UI without building anything.
# Fake steps with sleeps; run in a terminal to watch the live redraw:
#   sh scripts/progress-demo.sh
DIR=$(dirname "$0")
. "$DIR/lib/progress.sh"

echo "== after-pull (demo): syncing setup ($(uname -s))"
ui_total 5
ui_run "npm deps (manifest moved or node_modules missing) + host links" \
  sh -c 'sleep 1; echo "added 42 packages in 3s"'
ui_run "piread: build + install (cargo --release)" \
  sh -c 'sleep 2; echo Compiling piread'
ui_run "piedit: build + install (cargo --release)" \
  sh -c 'sleep 1; echo Compiling piedit'
ui_run "pibash: build + install (cargo --release)" \
  sh -c 'sleep 1; echo Compiling pibash'
ui_step "auto-heal: stale daemons + PATH pin"
ui_finish "after-pull (demo)"
