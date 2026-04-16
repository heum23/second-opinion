---
name: plan-reviewer-change
description: Codex plan review 설정 변경 (model / mode / soft-gate / hard-gate)
argument-hint: '<model|mode|soft-gate|hard-gate> [value]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" $ARGUMENTS`
