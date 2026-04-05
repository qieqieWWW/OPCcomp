---
name: opc-workflow-guard
description: "Use when working inside OPCcomp projects; enforce Airouting conda environment by default, keep changes scoped to OPCcomp, and avoid reading or modifying openclaw or other sibling folders unless explicitly requested. Includes direction tracking to prevent AI drift."
version: "2.0.0"
---

# OPCcomp Workflow Guard + TrackGuardian

## Purpose

Use this skill for any work inside the `OPCcomp` folder, especially the competition router project. This skill combines workflow enforcement with direction tracking to prevent AI drift.

## Core Capabilities

### 1. Workflow Enforcement

- Enforce `Airouting` conda environment for Python tasks.
- Keep changes scoped to `OPCcomp` only.
- Protect `openclaw` and sibling folders from unintended modifications.

### 2. Direction Tracking (TrackGuardian)

- Monitor project direction alignment in real-time.
- Detect and prevent AI drift from project goals.
- Provide corrective suggestions when deviation is detected.
- Track direction alignment score (0-1 scale).

## Required behavior

### Workflow Enforcement

- **Python Environment**: Prefer the `Airouting` conda environment for any Python-related task.
- **Environment Activation**: Before running Python commands, activate `Airouting` unless the user explicitly asks otherwise.
- **Project Context**: Before doing any OPCcomp-related work, read [OPCcomp/OPC_PROJECT_CONTEXT.md](../../../OPC_PROJECT_CONTEXT.md) first and treat it as the canonical project context.
- **Demo Plan Check**: Before any implementation task, read [OPCcomp/DEMO_NEXT_PLAN.md](../../../DEMO_NEXT_PLAN.md), map the request to task 1/2/3, and verify sequence alignment.
- **Sequence Guard**: If request order conflicts with `DEMO_NEXT_PLAN.md`, pause and request explicit user confirmation before coding.
- **Scope Control**: Keep changes scoped to `OPCcomp` only.
- **Openclaw Protection**: Do not modify `OPCcomp/openclaw` unless the user explicitly requests it.
- **Read-Only Default**: Treat `openclaw` as read-only by default.
- **External Access Control**: Do not read, copy, or move files outside `OPCcomp` unless the user explicitly requests it.
- **Credential Safety**: If a task needs external network access, API keys, or credentials, use them only when the user has explicitly asked for that step.

### Direction Tracking

- **Context Loading**: On skill activation, load direction from `OPC_PROJECT_CONTEXT.md`.
- **Real-time Monitoring**: Check alignment at key checkpoints.
- **Deviation Detection**: Detect when task intent deviates from core goals.
- **Corrective Action**: Provide immediate corrective suggestions for low alignment tasks.
- **Score Reporting**: Report alignment score for each major task.

## Direction Tracking Configuration

```yaml
direction_tracking:
	enabled: true
	project_context_path: "OPCcomp/OPC_PROJECT_CONTEXT.md"
	thresholds:
		warning: 0.7
		critical: 0.5
	auto_correct: true
	check_points:
		- "task_start"
		- "code_generation"
		- "file_modification"
		- "task_completion"
	directions:
		primary: "可读、可比较、可回放、可融合决策"
		secondary:
			- "技术实现质量"
			- "架构协调性"
			- "风险控制"
```

## Safe defaults

### Workflow Safety

- If a file or folder outside `OPCcomp` seems relevant, prefer summarizing dependency rather than editing it.
- If a task can be completed with local files, do not use external services.
- If a command could affect sibling projects, stop and ask for confirmation.

### Direction Safety

- If alignment score falls below 0.7, issue warning and suggest corrections.
- If alignment score falls below 0.5, pause and request confirmation.
- Always reference `OPC_PROJECT_CONTEXT.md` before major decisions.
- When alignment is uncertain, ask for clarification.

## Validation checklist

### Workflow Validation

- Confirm the active Python environment is `Airouting` before Python work.
- Confirm `DEMO_NEXT_PLAN.md` has been checked and the current task item is identified.
- Confirm edits stay inside `OPCcomp`.
- Confirm `openclaw` is untouched unless explicitly requested.
- Verify no external files are accessed without explicit permission.

### Direction Validation

- Load and understand project context from `OPC_PROJECT_CONTEXT.md`.
- Calculate direction alignment score for each major task.
- Compare alignment score against thresholds before proceeding.
- Document deviations and corrective actions.

## Usage Examples

### Example 1: Normal Workflow with Direction Tracking

```text
User request: Implement the BlenderAdapter for direction A

Skill response:
- Workflow Guard: Activating Airouting environment
- Direction Tracking: Loading project context
- Direction Tracking: Alignment score 0.92/1.0
- Direction Tracking: Task is aligned with project goals
- Workflow Guard: Changes scoped to OPCcomp/modified-runtime
```

### Example 2: Detected Deviation

```text
User request: Add a completely unrelated feature

Skill response:
- Direction Tracking: Potential deviation detected
- Alignment score: 0.35/1.0 (below critical threshold)
- Project direction: 可读、可比较、可回放、可融合决策
- Suggested corrections:
	1. Prioritize direction A integration first.
	2. Align any new feature with core goals.
	3. Confirm whether this supports primary project direction.
```

### Example 3: Protected Folder Warning

```text
User request: Modify openclaw runtime files

Skill response:
- Workflow Guard: Protected folder detected
- openclaw is read-only by default
- Options:
	1. Read-only access
	2. Explicit override
	3. Work in modified-runtime instead (recommended)
```

## Integration with openclaw-runtime

For `OPCcomp/openclaw-runtime` tasks:

- Run direction check before major code generation.
- Keep edits in `modified-runtime` by default.
- Preserve backward compatibility unless the user asks otherwise.
- Maintain type safety and run type checks when practical.

## Suggested Optional Config

Create `OPCcomp/.workflow-guard.yaml` if needed:

```yaml
workflow_guard:
	version: "2.0.0"
	python_environment: "Airouting"
	default_scope: "OPCcomp"
	protected_folders:
		- "openclaw"
		- "node_modules"
		- ".git"
	direction_tracking:
		enabled: true
		context_file: "OPC_PROJECT_CONTEXT.md"
		thresholds:
			warning: 0.7
			critical: 0.5
		auto_correct: true
	safety:
		confirm_external_access: true
		confirm_protected_modifications: true
		require_explicit_override: true
```

## Best Practices

### Do

- Check direction alignment before major tasks.
- Keep changes scoped to `OPCcomp`.
- Use `Airouting` for Python work.
- Reference `OPC_PROJECT_CONTEXT.md` frequently.
- Document deviations and corrections.

### Don't

- Modify `openclaw` without explicit permission.
- Access files outside `OPCcomp` without confirmation.
- Ignore alignment warnings.
- Proceed with critical deviation without review.
