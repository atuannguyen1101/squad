### 2026-03-23T17-10-56: feat/orchestration-server — BLOCKED, not ready to merge into dev
**By:** Flight
**What:** # Code Review: feat/orchestration-server → dev

**Verdict: BLOCKED**
**Reviewed by:** Flight (Lead)
**Date:** 2026-03-23T17:09Z

---

## Exact Git Command Output

### 1. git log feat/orchestration-server --oneline -10
```
fdd7907 (HEAD -> feat/orchestration-server) chore: apply stash@{1} orchestration-server WIP
075a332 feat: add monitoring dashboard with event history (Phase 3)
597b021 fix: add MCP entry point and skip empty stdin lines
f4c7d20 feat: add crash recovery with session persistence (Phase 4)
f0fba37 feat: add MCP bridge for Copilot integration (Phase 2)
333a710 test: add integration tests for orchestration server
7ea1b7a feat: add orchestration server with inter-agent communication
43a624b deleted images
d092ef0 Merge pull request #331 from diberry/squad/289-squad-dir-explainer
6d99e26 Merge remote-tracking branch 'origin/main' into squad/289-squad-dir-explainer
```

### 2. git log dev --oneline -10
```
28cf984 (dev) test: learning persistence E2E tests + history-shadow regex fix
37c7531 Merge branch 'feat/self-improve-pipeline' into dev
268a133 feat: proposal pipeline and ceremony execution engine
525075a feat: runtime role registration API and custom universe loading (#3, #8)
8d49066 feat: Machine Capability Discovery & needs:* Label Routing (#514) (#520)
677b7cf docs: KEDA External Scaler Template for Agent Autoscaling (#516) (#519)
7f86e0e feat: Cooperative Rate Limiting & Predictive Circuit Breaker (#515) (#518)
b39e5f3 feat(coordinator): add worktree creation to spawn flow (#529) (#537)
66578ec test: add personal squad unit and integration tests (#508) (#541)
fa1b416 feat(templates): create issue-lifecycle.md template document (#527) (#543)
```

### 3. git diff feat/orchestration-server..dev --stat (total)
```
561 files changed, 73071 insertions(+), 14491 deletions(-)
```
(What dev has that the feature branch does not)

### 4. git diff dev..feat/orchestration-server --stat (total)
```
561 files changed, 14137 insertions(+), 72717 deletions(-)
```
(What the feature branch has that dev does not)

### 5. git merge-base feat/orchestration-server dev
```
ba906cd00d1545d2bd98bb548e519d9adff118f1
```
Merge base commit: `ba906cd feat: integrate base role catalog into Init Mode (#368)`
- **39 commits unique to feat/orchestration-server** (not in dev)
- **129 commits unique to dev** (not in feat/orchestration-server)

---

## What Was Built

Surgeon delivered a complete 5-module orchestration server:

| File | Description |
|------|-------------|
| `packages/squad-sdk/src/server/index.ts` | `SquadServer` — wires ClientPool → AgentSessionManager → Coordinator → EventBus → RemoteBridge |
| `packages/squad-sdk/src/server/agent-lifecycle.ts` | `AgentSessionManager` — lazy session creation, charter compilation, fuzzy name resolution |
| `packages/squad-sdk/src/server/persistence.ts` | `ServerPersistence` — atomic writes (UUID tmp + rename), crash recovery, auto-save |
| `packages/squad-sdk/src/server/event-history.ts` | `EventHistory` — 100-event ring buffer with type/agent filtering |
| `packages/squad-sdk/src/mcp/server.ts` | MCP stdio bridge — 5 tools: squad_dispatch, squad_status, squad_list_agents, squad_close_session, squad_monitor |
| `packages/squad-cli/src/cli/commands/serve.ts` | CLI `squad serve` command — wired into cli-entry.ts ✓ |

Architecture is sound. The layering is clean. Atomic writes, unref() timers, lazy MCP start, fuzzy agent name resolution — all correct patterns.

---

## BLOCKERS (3)

### Blocker 1 — WIP Commit at Branch Tip
Top commit: `fdd7907 chore: apply stash@{1} orchestration-server WIP`
This is a raw stash pop applied as a commit. The message literally says WIP. Contains real code (MCP imports, resolveAgentName function) but cannot be the tip of a merge-ready branch. Must be squashed into its parent commit with a proper message.

### Blocker 2 — 129 Commits Behind dev, Full Rebase Required
The branch forked from `ba906cd` on old main — it has never been rebased onto dev. The conflict surface is 561 files. Critical conflict zones:
- `.github/agents/squad.agent.md` (+503 lines on dev) — coordinator needs to know about the orchestration server
- `.copilot/skills/` migration — skills moved from `.squad/skills/` on dev; feature branch still uses old path
- `packages/squad-sdk/src/` — runtime additions on dev that overlap with server module additions
- `squad-templates/` — multiple new templates on dev absent from feature branch

Cannot assess merge safety without seeing the rebase output. The branch must be rebased onto `dev` HEAD before any merge review is meaningful.

### Blocker 3 — Type Safety Violations
Team decision: `strict: true`, `noUncheckedIndexedAccess: true`, no `any`.

**`serve.ts`:**
```typescript
let squadConfig: any;              // must be: SquadConfig | undefined
async (event: any) => { ... }     // EventBus exposes typed event; use it
```

**`server/index.ts`:**
```typescript
createSession: async (config: any) // fan-out config shape must be typed
eventBus as any                    // acknowledged in comment but must be fixed by aligning interfaces
```

**All 4 test files** (`server.test.ts`, `recovery.test.ts`, `monitoring.test.ts`, `mcp.test.ts`) declare `let MCPServer: any`, `let EventHistory: any`, `let ServerPersistence: any` for dynamic imports. Violates strict mode in tests.

---

## Non-Blocking Issues (Must Fix Before Merge)

**Logic bug — poolCapacity always returns pool.size:**
```typescript
// Both branches are identical — bug:
poolCapacity: this.client?.pool.atCapacity ? this.client.pool.size : (this.client?.pool.size ?? 0)
// Should report max capacity, not current size
```

**serve.ts monkey-patches server.stop():**
```typescript
const _origStop = server.stop.bind(server);
server.stop = async () => { dashServer.close(); await _origStop(); };
// Fragile — use try/finally or explicit lifecycle instead
```

**loadDirBasedConfig returns partial config missing `models` field:**
```typescript
return { team: { name: 'squad' }, routing: { rules: [] } };
// Missing: models, version — runtime error when SquadServer accesses squadConfig.models
```

**MCP version hardcoded:**
```typescript
serverVersion ?? '0.8.25'  // will drift — import from package.json
```

---

## Strengths (Genuine)

- Atomic writes for persistence prevent half-written JSON on crash ✓
- `unref()` on auto-save timer — won't block process exit ✓
- Fuzzy agent name resolution (`"koba"` → `"kobayashi"`) — good UX ✓
- Lazy `ensureStarted()` in MCP server — correct initialization pattern ✓
- Both `session:created` and `session.created` event variants handled — compat ✓
- Tests cover: corrupt files, missing files, dispatch errors, ring buffer overflow, atomic write cleanup ✓
- CLI wired correctly (`serve` and `mcp` commands both in `cli-entry.ts`) ✓

---

## Required Before Re-Review

1. Rebase `feat/orchestration-server` onto `dev` HEAD — resolve all conflicts
2. Squash `fdd7907` WIP commit into its parent commit with a real message
3. Replace `any` types in `serve.ts`, `server/index.ts`, and all 4 test files
4. Fix `poolCapacity` logic bug in `getStatus()`
5. Fix `loadDirBasedConfig` to return a complete `SquadConfig` (add `models`, `version`)
6. Remove `server.stop()` monkey-patch from `serve.ts`

The feature is worth landing. Block is on branch hygiene and type safety, not the design.

**References:** feat/orchestration-server, EECOM, Surgeon, packages/squad-sdk/src/server, packages/squad-sdk/src/mcp, packages/squad-cli/src/cli/commands/serve.ts
**Why:** # Code Review: feat/orchestration-server → dev

**Verdict: BLOCKED**
**Reviewed by:** Flight (Lead)
**Date:** 2026-03-23T17:09Z

---

## Exact Git Command Output

### 1. git log feat/orchestration-server --oneline -10
```
fdd7907 (HEAD -> feat/orchestration-server) chore: apply stash@{1} orchestration-server WIP
075a332 feat: add monitoring dashboard with event history (Phase 3)
597b021 fix: add MCP entry point and skip empty stdin lines
f4c7d20 feat: add crash recovery with session persistence (Phase 4)
f0fba37 feat: add MCP bridge for Copilot integration (Phase 2)
333a710 test: add integration tests for orchestration server
7ea1b7a feat: add orchestration server with inter-agent communication
43a624b deleted images
d092ef0 Merge pull request #331 from diberry/squad/289-squad-dir-explainer
6d99e26 Merge remote-tracking branch 'origin/main' into squad/289-squad-dir-explainer
```

### 2. git log dev --oneline -10
```
28cf984 (dev) test: learning persistence E2E tests + history-shadow regex fix
37c7531 Merge branch 'feat/self-improve-pipeline' into dev
268a133 feat: proposal pipeline and ceremony execution engine
525075a feat: runtime role registration API and custom universe loading (#3, #8)
8d49066 feat: Machine Capability Discovery & needs:* Label Routing (#514) (#520)
677b7cf docs: KEDA External Scaler Template for Agent Autoscaling (#516) (#519)
7f86e0e feat: Cooperative Rate Limiting & Predictive Circuit Breaker (#515) (#518)
b39e5f3 feat(coordinator): add worktree creation to spawn flow (#529) (#537)
66578ec test: add personal squad unit and integration tests (#508) (#541)
fa1b416 feat(templates): create issue-lifecycle.md template document (#527) (#543)
```

### 3. git diff feat/orchestration-server..dev --stat (total)
```
561 files changed, 73071 insertions(+), 14491 deletions(-)
```
(What dev has that the feature branch does not)

### 4. git diff dev..feat/orchestration-server --stat (total)
```
561 files changed, 14137 insertions(+), 72717 deletions(-)
```
(What the feature branch has that dev does not)

### 5. git merge-base feat/orchestration-server dev
```
ba906cd00d1545d2bd98bb548e519d9adff118f1
```
Merge base commit: `ba906cd feat: integrate base role catalog into Init Mode (#368)`
- **39 commits unique to feat/orchestration-server** (not in dev)
- **129 commits unique to dev** (not in feat/orchestration-server)

---

## What Was Built

Surgeon delivered a complete 5-module orchestration server:

| File | Description |
|------|-------------|
| `packages/squad-sdk/src/server/index.ts` | `SquadServer` — wires ClientPool → AgentSessionManager → Coordinator → EventBus → RemoteBridge |
| `packages/squad-sdk/src/server/agent-lifecycle.ts` | `AgentSessionManager` — lazy session creation, charter compilation, fuzzy name resolution |
| `packages/squad-sdk/src/server/persistence.ts` | `ServerPersistence` — atomic writes (UUID tmp + rename), crash recovery, auto-save |
| `packages/squad-sdk/src/server/event-history.ts` | `EventHistory` — 100-event ring buffer with type/agent filtering |
| `packages/squad-sdk/src/mcp/server.ts` | MCP stdio bridge — 5 tools: squad_dispatch, squad_status, squad_list_agents, squad_close_session, squad_monitor |
| `packages/squad-cli/src/cli/commands/serve.ts` | CLI `squad serve` command — wired into cli-entry.ts ✓ |

Architecture is sound. The layering is clean. Atomic writes, unref() timers, lazy MCP start, fuzzy agent name resolution — all correct patterns.

---

## BLOCKERS (3)

### Blocker 1 — WIP Commit at Branch Tip
Top commit: `fdd7907 chore: apply stash@{1} orchestration-server WIP`
This is a raw stash pop applied as a commit. The message literally says WIP. Contains real code (MCP imports, resolveAgentName function) but cannot be the tip of a merge-ready branch. Must be squashed into its parent commit with a proper message.

### Blocker 2 — 129 Commits Behind dev, Full Rebase Required
The branch forked from `ba906cd` on old main — it has never been rebased onto dev. The conflict surface is 561 files. Critical conflict zones:
- `.github/agents/squad.agent.md` (+503 lines on dev) — coordinator needs to know about the orchestration server
- `.copilot/skills/` migration — skills moved from `.squad/skills/` on dev; feature branch still uses old path
- `packages/squad-sdk/src/` — runtime additions on dev that overlap with server module additions
- `squad-templates/` — multiple new templates on dev absent from feature branch

Cannot assess merge safety without seeing the rebase output. The branch must be rebased onto `dev` HEAD before any merge review is meaningful.

### Blocker 3 — Type Safety Violations
Team decision: `strict: true`, `noUncheckedIndexedAccess: true`, no `any`.

**`serve.ts`:**
```typescript
let squadConfig: any;              // must be: SquadConfig | undefined
async (event: any) => { ... }     // EventBus exposes typed event; use it
```

**`server/index.ts`:**
```typescript
createSession: async (config: any) // fan-out config shape must be typed
eventBus as any                    // acknowledged in comment but must be fixed by aligning interfaces
```

**All 4 test files** (`server.test.ts`, `recovery.test.ts`, `monitoring.test.ts`, `mcp.test.ts`) declare `let MCPServer: any`, `let EventHistory: any`, `let ServerPersistence: any` for dynamic imports. Violates strict mode in tests.

---

## Non-Blocking Issues (Must Fix Before Merge)

**Logic bug — poolCapacity always returns pool.size:**
```typescript
// Both branches are identical — bug:
poolCapacity: this.client?.pool.atCapacity ? this.client.pool.size : (this.client?.pool.size ?? 0)
// Should report max capacity, not current size
```

**serve.ts monkey-patches server.stop():**
```typescript
const _origStop = server.stop.bind(server);
server.stop = async () => { dashServer.close(); await _origStop(); };
// Fragile — use try/finally or explicit lifecycle instead
```

**loadDirBasedConfig returns partial config missing `models` field:**
```typescript
return { team: { name: 'squad' }, routing: { rules: [] } };
// Missing: models, version — runtime error when SquadServer accesses squadConfig.models
```

**MCP version hardcoded:**
```typescript
serverVersion ?? '0.8.25'  // will drift — import from package.json
```

---

## Strengths (Genuine)

- Atomic writes for persistence prevent half-written JSON on crash ✓
- `unref()` on auto-save timer — won't block process exit ✓
- Fuzzy agent name resolution (`"koba"` → `"kobayashi"`) — good UX ✓
- Lazy `ensureStarted()` in MCP server — correct initialization pattern ✓
- Both `session:created` and `session.created` event variants handled — compat ✓
- Tests cover: corrupt files, missing files, dispatch errors, ring buffer overflow, atomic write cleanup ✓
- CLI wired correctly (`serve` and `mcp` commands both in `cli-entry.ts`) ✓

---

## Required Before Re-Review

1. Rebase `feat/orchestration-server` onto `dev` HEAD — resolve all conflicts
2. Squash `fdd7907` WIP commit into its parent commit with a real message
3. Replace `any` types in `serve.ts`, `server/index.ts`, and all 4 test files
4. Fix `poolCapacity` logic bug in `getStatus()`
5. Fix `loadDirBasedConfig` to return a complete `SquadConfig` (add `models`, `version`)
6. Remove `server.stop()` monkey-patch from `serve.ts`

The feature is worth landing. Block is on branch hygiene and type safety, not the design.
