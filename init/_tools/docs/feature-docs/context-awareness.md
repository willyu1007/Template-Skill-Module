# Feature: context awareness

## Conclusions (read first)

- Provides stable API/DB/BPMN contracts under `docs/context/` for LLM + human collaboration
- Makes project context auditable (registries/checksums + verification)
- Includes LLM routing entrypoint (`docs/context/AGENTS.md`), domain glossary, and architecture principles
- **Mandatory in this template** (installed by default during Stage C)

## How to configure (Stage B)

Context awareness is always enabled in Stage C. You MAY keep `features.contextAwareness: true` in the blueprint (or omit it), but you MUST NOT set it to `false`.

Configuration (mode/env list):

```json
{
  "context": {
    "mode": "contract",
    "environments": ["dev", "staging", "prod"]
  }
}
```

Supported modes:
- `contract` (authoritative files)
- `snapshot` (generated snapshots)

## What Stage C `apply` does

Stage C always:

1) Copies templates from:
- `.ai/skills/features/context-awareness/templates/`
- Includes: `AGENTS.md`, `INDEX.md`, `glossary.json`, `glossary.schema.json`, `architecture-principles.md`, `project.registry.json`, API/BPMN/config templates

2) Initializes project state (best-effort):

```bash
node .ai/scripts/ctl-project-state.mjs init --repo-root .
node .ai/scripts/ctl-project-state.mjs set features.contextAwareness true --repo-root .
node .ai/scripts/ctl-project-state.mjs set context.enabled true --repo-root .
node .ai/scripts/ctl-project-state.mjs set-context-mode <contract|snapshot> --repo-root .
```

3) Initializes context artifacts (idempotent):

```bash
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs init --repo-root .
```

4) Generates aggregated API Index from module/project OpenAPI files:

```bash
node .ai/scripts/ctl-api-index.mjs generate --touch
```

5) Recomputes all registry checksums:

```bash
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs touch --repo-root .
```

6) Optional verification (when Stage C is run with `--verify-features`):

```bash
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --repo-root .
```

## Post-init: glossary migration

After Stage C, migrate domain terms from `init/_work/stage-a-docs/domain-glossary.md` (Markdown) into `docs/context/knowledge/glossary.json` (structured JSON):

```bash
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-term --term "<term>" --definition "<def>" [--scope global] [--aliases "<csv>"]
```

## Key outputs

- `docs/context/AGENTS.md` (LLM routing entrypoint with progressive loading protocol)
- `docs/context/knowledge/glossary.json` (structured domain glossary)
- `docs/context/knowledge/glossary.schema.json` (glossary JSON Schema)
- `docs/context/knowledge/architecture-principles.md` (cross-cutting constraints)
- `docs/context/**` (registries + contracts)
- `config/environments/**` (environment contract scaffolding, if present in templates)
