---
name: parallel-plan-review
description: Adds Codex review for plan/spec documents. PostToolUse hook on Write injects the Codex review command. Claude runs self-review first, then executes the Codex Bash command as a separate step before committing.
---

# Codex Plan/Spec Review

When a plan or spec is saved, the hook injects a Codex review command. Claude runs it as a **separate Bash step** after self-review, before commit.

## Flow

```
Write saves plan/spec → hook injects review command (fast)
  │
  ▼
Self-review (inline)
  │
  ▼
Fix self-review issues (Edit)
  │
  ▼
Bash(node plan-review.mjs ...)  ← separate step, Codex reviews fixed version
  │
  ▼
Fix Codex issues if any
  │
  ▼
git commit
```

## Important

- The hook injects the command as `additionalContext` — it does NOT run Codex directly
- Run the Codex review command as a **separate Bash call** — do NOT embed it inside git commit
- Set Bash timeout to **600000** (10 minutes)
- **DO NOT commit** until Codex review is done and issues are addressed
- Marker file prevents the hook from re-triggering on the same file
