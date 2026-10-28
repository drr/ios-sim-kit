#!/bin/bash
# SessionStart hook: when ios-sim feedback reports are waiting, tell the user (and Claude) how to start on them.
# Silent when there are none. Counts files directly, so it stays fast and needs no node.
n=0
for d in "$HOME/.config/ios-sim-kit/feedback" "${CLAUDE_PROJECT_DIR:-.}/dev/feedback"; do
  for f in "$d"/*.md; do [ -e "$f" ] && n=$((n + 1)); done
done
[ "$n" -eq 0 ] && exit 0
[ "$n" -eq 1 ] && what="1 open report" || what="$n open reports"
msg="ios-sim feedback: $what. Say 'process feedback' (the process-feedback skill) to triage."
printf '{"systemMessage": "%s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' \
  "$msg" "$msg"
