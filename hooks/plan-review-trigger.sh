#!/bin/bash
# PostToolUse hook for Write tool
# Detects plan/spec saves, injects Codex review command
# Claude runs Codex as a separate Bash step after self-review

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only match plan/spec document paths
if ! echo "$FILE_PATH" | grep -qE 'docs/superpowers/(plans|specs)/.*\.md$'; then
  exit 0
fi

# Prevent re-triggering on same file
MARKER="/tmp/codex-plan-review-$(echo "$FILE_PATH" | shasum -a 256 | cut -d' ' -f1)"
if [ -f "$MARKER" ]; then
  exit 0
fi
touch "$MARKER"

# Determine document type and paths
PLAN_PATH=""
SPEC_PATH=""
if echo "$FILE_PATH" | grep -qE '/plans/'; then
  PLAN_PATH="$FILE_PATH"
  SPEC_PATH=$(echo "$FILE_PATH" | sed 's|/plans/|/specs/|')
  [ ! -f "$SPEC_PATH" ] && SPEC_PATH=""
else
  SPEC_PATH="$FILE_PATH"
fi

# Build review command
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ -n "$PLAN_PATH" ] && [ -n "$SPEC_PATH" ]; then
  CMD="node \"${PLUGIN_ROOT}/scripts/plan-review.mjs\" \"$PLAN_PATH\" \"$SPEC_PATH\""
elif [ -n "$PLAN_PATH" ]; then
  CMD="node \"${PLUGIN_ROOT}/scripts/plan-review.mjs\" \"$PLAN_PATH\""
else
  CMD="node \"${PLUGIN_ROOT}/scripts/plan-review.mjs\" \"$SPEC_PATH\""
fi

jq -n --arg cmd "$CMD" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("After self-review and fixes are done, run Codex review as a SEPARATE Bash call (not inside git commit):\n" + $cmd + "\nSet Bash timeout to 600000. Fix any issues Codex finds, THEN commit.")}}'
