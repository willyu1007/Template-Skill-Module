## Context Awareness (Feature)

If `docs/context/` exists:

- AI/LLM MUST treat `docs/context/AGENTS.md` as the authoritative routing entrypoint for project context.
- AI/LLM MUST follow the progressive loading protocol defined in `AGENTS.md` (registry → api-index → openapi → glossary → principles → code).
- AI/LLM MUST NOT "scan the repo" to infer APIs/DB/flows when context artifacts are available.
- AI/LLM SHOULD prefer `docs/context/knowledge/glossary.json` over code/doc scanning when resolving domain terms.
- AI/LLM MUST update `docs/context/` only via `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs`.
  - Do NOT directly edit `docs/context/registry.json` by hand.
  - After any context change, run: `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs touch` and `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --strict`.
- AI/LLM MUST run `node .ai/scripts/ctl-openapi-quality.mjs verify --source <path> --strict` before committing OpenAPI changes.

Pack switching:

- AI/LLM MUST NOT edit `.ai/skills/_meta/sync-manifest.json` directly.
- AI/LLM MUST use: `node .ai/skills/_meta/ctl-skillpacks.mjs enable-pack|disable-pack|sync ...`.

Project state:

- AI/LLM MUST treat `.ai/project/state.json` as the project "stage/state" SSOT.
- AI/LLM MUST use: `node .ai/scripts/ctl-project-state.mjs` to change it.
