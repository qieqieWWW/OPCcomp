---
name: opc-workflow-guard
description: "Use when working inside OPC projects; enforce Airouting conda environment by default, keep changes scoped to OPC, and avoid reading or modifying openclaw or other sibling folders unless explicitly requested."
---

# OPC Workflow Guard

## Purpose

Use this skill for any work inside the `OPC` folder, especially the competition router project.

## Required behavior

- Prefer the `Airouting` conda environment for any Python-related task.
- Before running Python commands, activate `Airouting` unless the user explicitly asks otherwise.
- Keep changes scoped to `OPC` only.
- Do not modify `OPC/openclaw` unless the user explicitly requests it.
- Treat `openclaw` as read-only by default.
- Do not read, copy, or move files outside `OPC` unless the user explicitly requests it.
- If a task needs external network access, API keys, or credentials, use them only when the user has explicitly asked for that step.

## Safe defaults

- If a file or folder outside `OPC` seems relevant, prefer summarizing the dependency rather than editing it.
- If a task can be completed with local files, do not use external services.
- If a command could affect sibling projects, stop and ask for confirmation.

## Validation checklist

- Confirm the active Python environment is `Airouting` before Python work.
- Confirm edits stay inside `OPC`.
- Confirm `openclaw` is untouched unless explicitly requested.
