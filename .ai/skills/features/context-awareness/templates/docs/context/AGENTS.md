# Context Layer — LLM Loading Protocol

## Conclusions (read first)

- This file is the **authoritative routing entrypoint** for AI/LLM accessing project context.
- MUST follow the progressive loading order below. Do NOT deep-scan the source tree before checking context artifacts.
- If `docs/context/` does not exist, the Context Awareness feature has not been materialized. Run init Stage C apply with `contextAwareness=true`.

## Progressive Loading Protocol

### Step 1: Registry (always first)

Open `docs/context/registry.json` to discover all available context artifacts (aggregated from project + module registries).

### Step 2: API tasks — compact overview

Read `docs/context/api/api-index.json` for a compact, module-grouped overview of all endpoints (method, path, auth, params, response shape, curl example).

### Step 3: API tasks — full detail

For endpoint-level detail (full request/response schemas, examples), read the per-module OpenAPI files at `modules/<id>/interact/openapi.yaml`. If a project-level contract exists, it is at `docs/context/api/openapi.yaml`.

### Step 4: Terminology / concept tasks

Read `docs/context/knowledge/glossary.json` for project-specific term definitions, aliases, and relationships.

### Step 5: Architecture constraint tasks

Read `docs/context/knowledge/architecture-principles.md` for cross-cutting rules, conventions, and rejected alternatives.

### Step 6: Source code (only when needed)

Only if implementation detail is needed, follow `info.x-source-mapping` in the module's `openapi.yaml` to locate route/controller/schema source files.

### Step 7: Other tasks

Select artifacts from `registry.json` by tag or type. Open files by path. Do NOT scan folders.

## Rules

- **MUST** check context artifacts before reading source code for any context-available topic (API, DB, terms, architecture).
- **SHOULD** prefer `api-index.json` over per-module `openapi.yaml` when only endpoint discovery or overview is needed.
- **SHOULD** prefer `glossary.json` over code/doc scanning when resolving domain terms.
- **MUST NOT** infer API contracts from source code if a module's `openapi.yaml` exists — it is the authoritative source.

## Canonical Task Recipes

### Recipe: Find endpoint for business intent

1. Read `docs/context/api/api-index.json`.
2. Search `summary`, `tags`, or `moduleId` fields for the business concept.
3. If ambiguous, check `docs/context/knowledge/glossary.json` for term clarification.
4. For full schema detail, read the matching module's `modules/<moduleId>/interact/openapi.yaml`.
5. Only if code-level detail is needed, follow `x-source-mapping`.

### Recipe: Implement or change one endpoint safely

1. Read `docs/context/knowledge/architecture-principles.md` for relevant constraints.
2. Read `docs/context/api/api-index.json` to understand existing endpoint landscape.
3. Edit the target module's `modules/<moduleId>/interact/openapi.yaml` with the new/changed endpoint (contract-first).
4. Run `node .ai/scripts/ctl-openapi-quality.mjs verify --source modules/<moduleId>/interact/openapi.yaml --strict` to validate.
5. Run `node .ai/scripts/ctl-api-index.mjs generate --touch` to regenerate the aggregated index.
6. Implement the endpoint in source code following module conventions.
7. Run `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --strict` to confirm consistency.
