# OPCcomp Workspace Instructions

## Scope
- This workspace is for OPCcomp work only.
- Treat `OPC_PROJECT_CONTEXT.md` as the canonical product and architecture reference for all OPCcomp changes.
- Prefer changes that advance the main OPC route: execution-oriented, comparable, replayable, and decision-ready outputs.

## Safety and boundaries
- Keep edits inside `OPCcomp` unless the user explicitly asks to cross folders.
- Treat `openclaw` as read-only unless the user explicitly requests a change there.
- Prefer local files and existing code paths over introducing new dependencies or external services.

## Runtime and validation
- Use the `Airouting` conda environment by default for Python-related work.
- Validate changes with type checks or smoke tests when practical.
- Preserve existing interfaces unless a change is required by the task.

## Fusion and runtime guidance
- Reuse existing runtime, aggregation, prompt, and blending pieces before adding new abstractions.
- Prefer thin adapters over rewrites.
- When adding fusion logic, preserve traceability, ranking metadata, and replayability.

## Documentation and recall
- If a task changes the main route or workflow assumptions, update the relevant instructions or skill files so future work stays aligned.
- If a task is specific to OPCcomp workflow control, consult `OPCcomp/.github/skills/opc-workflow-guard/SKILL.md` first.

## Demo plan first
- Before starting any OPCcomp implementation task, read `OPCcomp/DEMO_NEXT_PLAN.md` and confirm the requested work matches the current priority order.
- If the requested work conflicts with `OPCcomp/DEMO_NEXT_PLAN.md` sequence, explicitly ask for confirmation before proceeding.
- For implementation tasks, state the matched plan item (for example: task 1/2/3) before coding.
