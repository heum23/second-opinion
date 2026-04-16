#!/bin/bash
# PostToolUse hook for Write / Edit / MultiEdit on plan/spec documents.
#
# This is a thin wrapper: all state-machine logic lives in the sibling
# plan-review-trigger.py so that the JSON marker file (read-modify-write
# with a three-state machine + soft/hard gates) is easier to maintain than
# it would be in pure bash. The .sh entry point is kept so hooks.json does
# not need to change and so Claude Code's existing permission prompts /
# settings remain valid.
#
# Failure modes:
#   - python3 missing → warn to stderr, exit 0 (never block the tool call)
#   - malformed stdin / unknown state → python script logs and exits 0

LOG_FILE="${LOG_FILE:-/tmp/codex-plan-review-hook.log}"

if ! command -v python3 >/dev/null 2>&1; then
  echo >&2 "codex-plan-review hook: python3 not found; skipping (install python3 to enable hook)"
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] python3 missing; skipping hook" >>"$LOG_FILE" 2>/dev/null
  exit 0
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

export PLUGIN_ROOT
export LOG_FILE

exec python3 "$PLUGIN_ROOT/hooks/plan-review-trigger.py"
