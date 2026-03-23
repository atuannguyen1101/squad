# SURGEON

> Flight Surgeon

## Learnings

### Release History
v0.8.24 released successfully. npm packages: @bradygaster/squad-sdk@0.8.24, @bradygaster/squad-cli@0.8.24. publish.yml triggers on `release: published` (NOT draft). Test baseline at release: 3,931 tests, 149 files.

### Version Mutation Bug (P0)
bump-build.mjs mutates versions during local builds despite SKIP_BUILD_BUMP=1 and CI=true env vars. Workaround: set versions with `node -e` script and commit IMMEDIATELY before building. This is a P0 fix item in docs/proposals/cicd-gitops-prd.md.

### Known Incidents
v0.8.22: 4-part version 0.8.21.4 mangled by npm to 0.8.2-1.4. v0.8.23: versions reverted from 0.8.23 to 0.8.22 during build despite env vars. Both resolved with the node -e script + immediate commit workaround.

## Issues
### 2026-03-23

- error: you need to resolve your current index first
- index.ts resolved. Now resolve tools/index.ts (keep both `handoffManager` and `dispatchGetter`):
- cli-entry.ts already had conflict markers resolved, but lines 623-633 are malformed — `economy` block is missing `return;` and `}` before `serve`. Fix that:
- Good. Now mark all resolved files and continue the cherry-pick:

## References
### 2026-03-23

Session artifacts:
- When done, emit squad_pulse with phase "done" listing the files you created or modified.
