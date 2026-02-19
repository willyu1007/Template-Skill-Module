# Business Process Artifacts (BPMN)

## Purpose
Store BPMN 2.0 process definitions under `docs/context/process/` (LLM-visible contracts).

## Rules (MUST)

- Each `.bpmn` file MUST be registered via `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-artifact --artifact-id <id> --type bpmn --path <repo-relative-path>` (writes to SSOT `project.registry.json`; the derived `registry.json` is regenerated automatically).
- After editing any `.bpmn`, run:
  - `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs touch`
  - `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --strict`

## Progressive disclosure (LLM)
- Prefer reading `docs/context/registry.json` first, then open only the specific `.bpmn` files needed.
