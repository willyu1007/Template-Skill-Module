# Context Awareness Feature (Optional)

## Conclusions (read first)

- The feature installs a **stable, verifiable project context layer** under `docs/context/` (API, DB schema mapping, BPMN, and additional artifacts).
- The feature also provides **environment configuration management** under `docs/context/config/` and `config/environments/`.
- The feature provides **project-level scripts** that MUST be used to change the context:
  - `node .ai/skills/features/context-awareness/scripts/ctl-context.mjs` (context artifacts + registry + environments)
  - `node .ai/scripts/ctl-project-state.mjs` (project state/config)
  - `node .ai/skills/_meta/ctl-skillpacks.mjs` (skills pack switching + wrapper sync)
- The goal is to make an LLM "context-aware" without relying on ad-hoc folder scans:
  - The LLM reads `docs/context/INDEX.md` and `docs/context/registry.json` as the entry point.
  - Environment constraints are in `docs/context/config/environment-registry.json`.
  - CI can run `ctl-context verify --strict` to enforce "changes go through scripts".

## What this feature writes (blast radius)

New files/directories (created if missing):

- `docs/context/**` (context artifacts and registry)
- `docs/context/config/**` (environment registry)
- `.ai/skills/features/context-awareness/**` (documentation for this feature)
- `config/environments/**` (environment config templates)
- `.ai/skills/features/context-awareness/scripts/ctl-context.mjs`
- `.ai/scripts/ctl-project-state.mjs`
- `.ai/skills/_meta/ctl-skillpacks.mjs` (pack controller)
- `.ai/project/{state.json,state.schema.json}`
- `.ai/skills/_meta/packs/context-core.json` (pack definition)


## Install

1. Copy the feature templates into the repository root (merge, copy-if-missing):
   - Source: `.ai/skills/features/context-awareness/templates/`
   - Destination: repo root
2. Initialize (idempotent):

   ```bash
   node .ai/scripts/ctl-project-state.mjs init
   node .ai/scripts/ctl-project-state.mjs set-context-mode contract
   node .ai/scripts/ctl-project-state.mjs set context.enabled true
   node .ai/skills/features/context-awareness/scripts/ctl-context.mjs init
   node .ai/skills/features/context-awareness/scripts/ctl-context.mjs touch
   ```

3. (Optional) Enable the `context-core` pack and sync wrappers:

   ```bash
   node .ai/skills/_meta/ctl-skillpacks.mjs enable-pack context-core --providers both
   ```


## Environment Configuration

The feature includes environment configuration management:

### Environment Registry

`docs/context/config/environment-registry.json` defines:
- Available environments (dev, staging, prod, etc.)
- Database access policies per environment
- Deployment permissions
- Secrets source information

### Config Templates

`config/environments/` contains YAML templates:
- `dev.yaml.template` - Development configuration
- `staging.yaml.template` - Staging configuration
- `prod.yaml.template` - Production configuration

Copy templates to actual config files (remove `.template` suffix) and fill in values.
**Never commit actual secrets to version control.**

### Environment Commands

```bash
# Add a new environment
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-env --id qa --description "QA environment"

# List all environments
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs list-envs

# Verify environment configuration
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify-config --env staging
```

## Artifact Commands

```bash
# Add a project-level artifact
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-artifact --artifact-id my-api --type openapi --path docs/context/api/my-api.yaml

# Add a module-level artifact
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs add-artifact --module-id user-api --artifact-id openapi --type openapi --path modules/user-api/interact/openapi.yaml

# Remove an artifact
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs remove-artifact --artifact-id old-api

# Update checksums after editing artifacts
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs touch

# List all artifacts (SSOT)
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs list

# List derived (aggregated) artifacts
node .ai/skills/features/context-awareness/scripts/ctl-context.mjs list --derived
```

## Verification

- Context layer exists and is consistent:
  ```bash
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify --strict
  ```
- Environment configuration is valid:
  ```bash
  node .ai/skills/features/context-awareness/scripts/ctl-context.mjs verify-config
  ```
- Project state is valid:
  ```bash
  node .ai/scripts/ctl-project-state.mjs verify
  ```
- Skills wrappers are synced (if you enabled packs):
  ```bash
  node .ai/skills/_meta/ctl-skillpacks.mjs sync --providers both
  ```

## Rollback / Uninstall

Delete these paths (if you want a clean uninstall):

- `docs/context/`
- `.ai/skills/features/context-awareness/`
- `config/environments/`
- `.ai/skills/features/context-awareness/scripts/ctl-context.mjs`
- `.ai/scripts/ctl-project-state.mjs`
- `.ai/skills/_meta/ctl-skillpacks.mjs`
- `.ai/project/`
- `.ai/skills/_meta/packs/context-core.json`

Then re-sync wrappers:
```bash
node .ai/scripts/sync-skills.mjs --scope current --providers both --mode update
```
