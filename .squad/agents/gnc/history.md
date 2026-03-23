# GNC

> Guidance, Navigation, and Control Officer

## Learnings

### ESM Compatibility Layer
@github/copilot-sdk@0.1.32 has broken ESM import (session.js uses 'vscode-jsonrpc/node' missing .js extension). Two-layer fix: (1) lazy-load copilot-sdk so init/build/watch don't trigger it, (2) postinstall patch in packages/squad-cli/scripts/patch-esm-imports.mjs. Runtime Module._resolveFilename patch in cli-entry.ts for npx where postinstall doesn't run.

### Node Version Requirements
Node.js ≥20 required. Node 24+ enforces strict ESM resolution (no extensionless imports). cli-entry.ts has runtime check that warns about node:sqlite availability (≥22.5.0).

### PR #474 Review & Merge — Node 22 ESM Fix (2026-03-22)

Reviewed and merged PR #474 (Node 22 ESM compatibility + bonus exports key fix). Addresses module resolution failures on Node 22 strict ESM enforcement.

**Fix pattern:** Node 22 ESM compatibility requires two checks: (1) explicit exports map in package.json (exports key with conditions), (2) actual module paths must match exports map entries. Mismatch between declared exports and actual files causes MODULE_NOT_FOUND errors. Build-time validation: check that every exports entry points to a file that exists.

**Key learning:** ESM exports key and actual module structure must stay in sync. When adding new entry points, update both package.json (exports) and create the corresponding module file. Missing either step breaks consumers on Node 22+. Test matrix must include Node 22+ to catch these errors early.
### Dual-Layer ESM Fix (Issue #449)
Upgraded from single-layer session.js patch to dual-layer approach: (1) Inject `exports` field into vscode-jsonrpc@8.2.1 package.json at postinstall — this is the canonical fix that resolves ALL subpath imports at once, matching vscode-jsonrpc v9.x. (2) Keep session.js `.js` extension patch as defense-in-depth. Added `squad doctor` detection for both layers (checks vscode-jsonrpc exports field and copilot-sdk session.js import syntax). Runtime Module._resolveFilename patch in cli-entry.ts remains as Layer 3 for npx cache hits where postinstall never runs.
### 2026-03-23

- I've already completed this refactoring.. Added `registerTool()` Helper Function**
### 2026-03-23

- - Ensure test/mcp-tool-visibility.test.ts still passes
- Excellent! Now let's run the test to make sure everything still works:
## Decisions
### 2026-03-23

- Now I'll create the refactored file.
- I see there's an issue - the registerTool function is calling itself recursively instead of calling mcp.addTool.

## Issues

### 2026-03-23

- The test failure is expected - we need to update the test to check for the new pattern.
### 2026-03-23

- I see there's an issue - the registerTool function is calling itself recursively instead of calling mcp.addTool. Let me fix that:
- Perfect! The test failure is expected - we need to update the test to check for the new pattern. The test is currently looking for `if (false) mcp.addTool` which we've successfully removed. Let me upd
- Perfect! All tests pass. Now let's rebuild the SDK to make sure there are no TypeScript errors:
- Good! The TypeScript errors are pre-existing (the pulse.ts err...
## Patterns

### 2026-03-23

- Now I need to update this test to check for the new pattern:
- I've successfully refactored the MCP server tool visibility from the `if(false)` pattern to a clean Set-based approach!
- ✅ Consistent pattern for both public and internal tools
### 2026-03-23

- Refactor MCP server tool visibility from if(false) pattern to publicTools Set
- 2. **Refactor tool registration pattern:**
- This is cleanup from Strausz's code review. The if(false) pattern works but is not maintainable. A Set-based approach is cleaner and more explicit.
- I'll refactor the MCP server tool visibility to use a clean Set-based approach. Let me start by examining the current implementation.
- 3. Remove all `if (false)` blocks and replace with a cleaner pattern

## References
### 2026-03-23

Session artifacts:
- 1. **Created `publicTools` Set** - Contains the 7 user-facing tools that should be exposed on the MCP surface
- 2. **Added `registerTool()` helper** - A properly-typed function that conditionally registers tools based on Set membership
- **1. Created `publicTools` Set**
- **2. Added `registerTool()` Helper Function**
- 3. **`packages/squad-sdk/src/mcp/server.ts.backup`** - Backup created
