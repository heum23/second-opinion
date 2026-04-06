---
name: plan-reviewer-change
description: Codex plan review 모델 변경 (default, spark, gpt-5.4-mini, 또는 직접 입력)
argument-hint: '<model>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" $ARGUMENTS`
