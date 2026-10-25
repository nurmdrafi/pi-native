# progress.sh — compact progress UI for setup scripts. POSIX sh, no deps.
# TTY on stdout: step line stays on one line, redrawn in place (spinner + elapsed).
# Piped/CI: plain one-line-per-step output, no control characters.
# Sourced (after-pull.sh, progress-demo.sh). API:
#   ui_total <n>             — declare step count; starts the total-time clock
#   ui_run <label> <cmd...>  — run cmd, then print `[k/n] label — ok|FAILED (time)`
#                              FAILED appends the last log lines. Returns cmd's rc.
#   ui_step <label>          — count + print a step that has no child command
#   ui_finish <name>         — summary: steps ok/failed + total time

UI_TOTAL=0 UI_STEP=0 UI_OK=0 UI_FAIL=0 UI_T0=0

# ms since epoch; node gives sub-second, date +%s is the coarse fallback.
_ui_now() {
  if command -v node >/dev/null 2>&1; then
    node -e 'console.log(Math.round(Number(process.hrtime.bigint())/1e6))'
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

# seconds with one decimal from a ms delta: 1234 -> "1.2"
_ui_secs() {
  _ms=$1
  printf '%d.%d' $(( _ms / 1000 )) $(( (_ms % 1000) / 100 ))
}

_ui_label() {
  if [ "$UI_TOTAL" -gt 0 ]; then
    printf '[%d/%d] %s' "$UI_STEP" "$UI_TOTAL" "$1"
  else
    printf '%s' "$1"
  fi
}

ui_total() {
  UI_TOTAL=${1:-0}
  UI_STEP=0 UI_OK=0 UI_FAIL=0
  UI_T0=$(_ui_now)
}

ui_step() {
  UI_STEP=$(( UI_STEP + 1 ))
  UI_OK=$(( UI_OK + 1 ))
  _ui_label "$1"
  printf '\n'
}

ui_run() {
  _ui_label_cmd=$1
  shift
  UI_STEP=$(( UI_STEP + 1 ))
  _ui_t0=$(_ui_now)
  _ui_log=$(mktemp "${TMPDIR:-/tmp}/ui-run.XXXXXX") || { "$@"; return $?; }
  if [ -t 1 ]; then
    "$@" >"$_ui_log" 2>&1 &
    _ui_pid=$!
    _ui_i=0
    while kill -0 "$_ui_pid" 2>/dev/null; do
      case $(( _ui_i % 4 )) in
        0) _ui_c='-' ;; 1) _ui_c='\' ;; 2) _ui_c='|' ;; 3) _ui_c='/' ;;
      esac
      printf '\r%s — %s %ss ' "$(_ui_label "$_ui_label_cmd")" "$_ui_c" \
        "$(_ui_secs $(( $(_ui_now) - _ui_t0 )))"
      _ui_i=$(( _ui_i + 1 ))
      sleep 0.3
  done
    wait "$_ui_pid"
    _ui_rc=$?
  else
    "$@" >"$_ui_log" 2>&1
    _ui_rc=$?
  fi
  [ -t 1 ] && printf '\r\033[K'
  if [ "$_ui_rc" -eq 0 ]; then
    UI_OK=$(( UI_OK + 1 ))
    printf '%s — ok (%ss)\n' "$(_ui_label "$_ui_label_cmd")" \
      "$(_ui_secs $(( $(_ui_now) - _ui_t0 )))"
  else
    UI_FAIL=$(( UI_FAIL + 1 ))
    printf '%s — FAILED (%ss)\n' "$(_ui_label "$_ui_label_cmd")" \
      "$(_ui_secs $(( $(_ui_now) - _ui_t0 )))"
    tail -n 3 "$_ui_log" | sed 's/^/    /'
  fi
  rm -f "$_ui_log"
  return "$_ui_rc"
}

ui_finish() {
  _ui_name=$1
  [ "$UI_T0" -eq 0 ] && UI_T0=$(_ui_now)
  if [ "$UI_FAIL" -eq 0 ]; then
    printf '== %s: %d/%d ok — %ss total\n' "$_ui_name" "$UI_OK" \
      "$(( UI_OK + UI_FAIL ))" "$(_ui_secs $(( $(_ui_now) - UI_T0 )))"
  else
    printf '!! %s: %d/%d failed — %ss total\n' "$_ui_name" "$UI_FAIL" \
      "$(( UI_OK + UI_FAIL ))" "$(_ui_secs $(( $(_ui_now) - UI_T0 )))"
  fi
}
