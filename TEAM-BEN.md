# Team Ben — Squad SDK Self-Improving Autonomous Team

## Vision

An autonomous AI team that lives in every Squad workspace. You call `squad_run`, Ben understands what you want, the Coordinator picks the right agents, the custom squad team does the work, you monitor via `squad_wait`, and Sage learns from each run to make the whole setup better over time.

## Architecture

```
You (user)
  |
  | squad_run / squad_ask / squad_respond
  v
Ben (SDK built-in) — understands intent, asks questions, gives updates
  |
  | PipelineRunner phase 1: understand
  v
Coordinator (SDK built-in) — reads routing.md + roster, picks implementer/reviewer via LLM
  |
  | PipelineRunner phase 2: route (returns JSON with agent names)
  v
Custom Squad Team (workspace black box) — implements and reviews
  |
  | PipelineRunner phases 3-4: implement + review (agents selected by Coordinator)
  v
Sage (SDK built-in) — post-run analysis via squad_analyze_run
```

## Three SDK-Level Actors

### Ben — User Representative
- SDK built-in (embedded charter in `built-in-actors.ts`)
- Exists in every workspace automatically, no `.squad/agents/ben/` needed
- Understands user intent, asks clarifying questions
- Translates between human language and agent-friendly task descriptions
- Reports progress and relays questions from the team
- Workspace can override by creating `.squad/agents/ben/charter.md`

### Coordinator — Work Router
- SDK built-in (embedded charter in `built-in-actors.ts`)
- LLM-based agent selection — understands semantics, not just keyword matching
- Reads routing.md + agent roster, returns JSON: `{"implementer": "name", "reviewer": "name", "architect": null}`
- Replaces broken regex matching that picked wrong agents alphabetically
- One cheap LLM call per run — no ongoing session

### Sage — Self-Improvement Analyst
- SDK built-in (embedded charter in `built-in-actors.ts`)
- Runs post-run via `squad_analyze_run` MCP tool
- Reads pulse history and agent session messages
- Produces structured improvement proposals for:
  - SDK configuration (`squad.config.ts`)
  - Squad definitions (`.squad/team.md`, `.squad/routing.md`, agent charters)
  - Agentic setup (`.github/instructions/`, `.github/skills/`, custom agents, MCP config)
  - Run efficiency (token spend, error rates, routing accuracy)
- All proposals require human approval

## Flow

1. `squad_run(message)` — user tells Ben what they want
2. Ben (understand phase) — parses intent, asks questions if unclear via `squad_pulse`
3. Coordinator (route phase) — reads routing.md + roster, picks implementer/reviewer via LLM, returns JSON
4. Implementer (implement phase) — workspace agent selected by Coordinator writes code, tests
5. Reviewer (review phase) — workspace agent selected by Coordinator reviews the implementation
6. Pipeline complete — Ben reports final result via `squad_pulse` with phase "done"
7. `squad_analyze_run()` — Sage analyzes the completed run (on-demand)

## Requirements

### MCP Entry Point
- `squad_run` to start a team run
- `squad_ask` to send follow-up to Ben
- `squad_respond` to answer team questions
- `squad_wait` to block until something needs attention
- `squad_status` for quick checks (bypasses Ben)
- `squad_analyze_run` for post-run analysis (Sage)
- `squad_cancel` to stop an active run

### No Polling — Event-Driven Monitoring
- `squad_wait` blocks until a user-relevant event occurs (question, error, blocker, done)
- Pulse Protocol: agents emit structured updates via `squad_pulse`
- `PulseCollector` with `setOnUserRelevantPulse` callback wakes `squad_wait` resolvers
- Both MCP tool and SquadTool `squad_pulse` share the same collector

### Inter-Agent Communication
- `squad_route` (async fire-and-forget) and `squad_send` (sync, 2min timeout)
- Agents inside CopilotSessions have these as SquadTools
- Shared scratchpad for parallel agents (not yet built)

### Deterministic Pipeline
- `PipelineRunner`: code-enforced DAG with typed `PhaseGate` validators
- Phases don't advance until gate passes
- Agent assignment by role regex from charters (no hardcoded names)
- Topological sort into parallel layers for independent phases
- Retry support per phase

### Context Management
- Intent Graph: structured representation of user intent (`goal`, `constraints`, `acceptanceCriteria`, etc.)
- Pulse Protocol: bounded structured updates instead of unbounded prose
- Context windowing: auto-summarize old messages (not yet built)
- Built-in actor charters are compact and focused

### Self-Improvement / Learning
- `squad_analyze_run` reads pulse history + session messages
- Produces structured report with concrete improvement proposals
- Scoped to: charters, routing rules, SDK config, instructions, prompts, skills, MCP setup
- All proposals require human approval before applying

### Cross-Workspace Portability
- Ben and Sage embedded in SDK (`built-in-actors.ts`)
- No `.squad/agents/ben/` or `.squad/agents/sage/` needed
- Charter compiler: workspace file > SDK built-in > generic fallback
- Agent discovery by role pattern, not by name
- Custom squad team is a black box — whatever agents the workspace defines

### Dashboard
- HTTP server at dynamic port
- `/api/status`, `/api/dispatch`, `/api/sessions/:name`, `/api/send`, `/api/close`
- URL shown by `squad_status`

## What's Built

| Component | Files | Status |
|-----------|-------|--------|
| PipelineRunner | `src/pipeline/` | Working, wired into `squad_run` |
| Intent Graph | `src/intent/` | Types built, write-once (not updated mid-run) |
| Pulse Protocol | `src/pulse/` | Working, callback wakes `squad_wait` |
| Built-in Actors | `src/agents/built-in-actors.ts` | Ben + Coordinator + Sage charters embedded |
| Charter Fallback | `src/server/agent-lifecycle.ts` | 3-tier: workspace > built-in > generic |
| MCP Tools | `src/mcp/server.ts` | squad_run, squad_wait, squad_ask, squad_respond, squad_pulse, squad_analyze_run |
| Run Analysis | `src/mcp/analyze-run.ts` | Reads pulses + sessions, produces report |
| SquadTool pulse | `src/tools/index.ts` | squad_pulse registered for agent sessions |
| Cancellation | `src/pipeline/runner.ts` | PipelineRunner.cancel() + squad_cancel MCP tool |
| Unit Tests | `test/pipeline.test.ts`, `test/pulse.test.ts`, `test/intent-graph.test.ts`, `test/built-in-actors.test.ts` | 46/46 passing |

## What's Incomplete

| Item | Impact |
|------|--------|
| ~~Pipeline understand phase vs Q&A loop~~ | **FIXED** — waitForResponse now detects pending user questions and waits for Q&A resolution before accepting a response |
| Intent Graph not updated mid-run | Ben creates it once, never maintains it |
| Context windowing | Old messages accumulate unbounded in agent sessions |
| Shared scratchpad | No cross-agent artifact sharing mechanism |
| Concurrent `squad_run` race | Module-scoped singletons overwritten by second run |
| ~~`squad_cancel`~~ | **BUILT** — cancels all active pipelines, closes sessions, resolves waiters |
| MCP wiring tests | The most complex code has zero test coverage |
| Sage end-to-end test | `squad_analyze_run` exists but not tested with Sage as dispatched agent |
| Dashboard port stability | Port changes on restart if old process didn't fully exit |

## Session Log (2026-03-22, Session 2)

### What was done this session

1. **Fixed pipeline Q&A loop (Priority 1)**: Modified `waitForResponse` in `server.ts` to be Q&A-aware. When Ben asks clarifying questions via `squad_pulse` (setting `questionsForUser`), the pipeline now detects `pendingUserQuestions.length > 0` and waits for the user to call `squad_respond` before accepting Ben's response. This prevents the pipeline from grabbing Ben's questions as the "understanding" and prematurely advancing to the route phase.

2. **Built `squad_cancel` (Priority 3)**: Added cancellation support to `PipelineRunner` (`cancel()` method with immediate state transition to `'cancelled'`). Cancellation checks at three points: before each layer, before each phase, and before each retry attempt. Added `squad_cancel` MCP tool that cancels all active pipelines, closes all agent sessions, resolves pending `squad_wait` callers, and returns a summary.

3. **Added 'cancelled' status**: Extended `PhaseStatus` and `PipelineState.status` type unions with `'cancelled'` variant in `types.ts`.

4. **Pipeline tracking for cancel**: Server now tracks active `PipelineRunner` instances in `activePipelines` array (both the initial understand+route pipeline and the chained implement+review pipeline). `squad_cancel` iterates all of them.

5. **Tests**: Added 4 new cancel tests to `pipeline.test.ts` covering: cancel before execution, cancel mid-pipeline (skips remaining phases), completedAt set on cancel, and cancelled phase results. All 46 tests pass (up from 42).

6. **Type check clean**: `tsc --noEmit` passes with zero errors.

### What the next session should do

**Priority 1: Verify Coordinator routing end-to-end**
Restart the MCP server (dist is built) and call `squad_run` to verify the Coordinator LLM actor correctly reads routing.md + roster and picks the right agents. Test with different task types to verify semantics-based routing.

**Priority 2: Run Sage end-to-end**
Call `squad_analyze_run` after a completed run and verify it produces useful improvement proposals. Dispatch to Sage as an agent to interpret the analysis.

**Priority 3: Remaining items from "What's Incomplete" table:**
- Intent Graph not updated mid-run (Ben creates it once, never maintains it)
- Context windowing (old messages accumulate unbounded)
- Shared scratchpad (no cross-agent artifact sharing)
- Concurrent `squad_run` race (closure-scoped vars + collector.clear())
- MCP wiring tests (zero integration test coverage for squad_run flow)
- Sage end-to-end test
- Dashboard port stability

### What was done this session

1. Read and understood the entire Squad SDK codebase (architecture, MCP tools, coordinator, session pool, charter compiler, casting, hooks, remote control)
2. Designed the Team Ben architecture: three SDK-level actors (Ben, Coordinator, Sage) + custom workspace agents as a black box
3. Built PipelineRunner — code-enforced DAG executor with typed phase gates, topological sort, parallel layers, retry support (`src/pipeline/`)
4. Built Pulse Protocol — structured agent status updates with PulseCollector, user-relevant filtering, `setOnUserRelevantPulse` callback that wakes `squad_wait` (`src/pulse/`)
5. Built Intent Graph — structured user intent representation with create/update/serialize (`src/intent/`)
6. Built MCP tools: `squad_run`, `squad_wait`, `squad_ask`, `squad_respond`, `squad_pulse`, `squad_analyze_run` in `src/mcp/server.ts`
7. Built built-in actors registry with 3-tier charter fallback (workspace file > SDK built-in > generic) in `src/agents/built-in-actors.ts` and `src/server/agent-lifecycle.ts`
8. Built `squad_analyze_run` with `analyze-run.ts` for Sage's post-run analysis
9. Registered `squad_pulse` as both MCP tool and SquadTool (so agents inside sessions can emit pulses)
10. Wired PulseCollector's callback to trigger `squad_wait` resolvers — both MCP and SquadTool paths share the same collector
11. Added Coordinator as SDK built-in LLM actor that reads routing.md + roster and returns JSON agent selection (replaces broken regex matching)
12. Set up `.vscode/mcp.json` for local testing
13. Created workspace agents: fenster (SDK Developer), hockney (SDK Reviewer), strausz (SDK Architect)
14. Removed workspace-level Ben charter — now uses SDK built-in only
15. Multiple successful end-to-end runs: Ben understood intent, dispatched to correct agents, agents implemented code, reviewer caught real issues, pipeline auto-transitioned between phases
16. 42 unit tests across 4 test files all passing
17. All changes committed to main branch

### What the next session should do

**Priority 1: Fix the pipeline Q&A loop (blocking)**
The pipeline's `waitForResponse` polling grabs Ben's first reply (which is his clarifying questions) as the "response" and fails the gate. When Ben asks questions via `squad_pulse` and the user answers via `squad_respond`, the pipeline doesn't know to wait for Ben's post-clarification answer. Fix: make the understand phase wait for a response that comes AFTER any `squad_respond` calls, or have Ben's charter instruct him to NOT ask questions during understand phase (include all context upfront in `squad_run`), or rework `waitForResponse` to track the latest reply timestamp.

**Priority 2: Verify Coordinator routing end-to-end**
The Coordinator LLM actor is built and wired into the pipeline (understand → route → implement + review). It needs a clean test run on a fresh server to verify it picks the right agents. The dist is built and committed — just restart the MCP server and call `squad_run`.

**Priority 3: Build `squad_cancel`**
The team already spec'd this out (Ben produced a full spec in one of the runs). Implement: close all active sessions via session manager, return summary.

**Priority 4: Run Sage end-to-end**
Call `squad_analyze_run` after a completed run and verify it produces useful improvement proposals. Optionally dispatch to Sage as an agent to interpret the analysis.

**Priority 5: Remaining items from "What's Incomplete" table above**

### Key files to read first
- `TEAM-BEN.md` — this file, the full spec
- `packages/squad-sdk/src/mcp/server.ts` — the main `squad_run` implementation with pipeline, coordinator, and all MCP tools
- `packages/squad-sdk/src/agents/built-in-actors.ts` — Ben, Coordinator, Sage embedded charters
- `packages/squad-sdk/src/pipeline/runner.ts` — PipelineRunner DAG executor
- `packages/squad-sdk/src/pulse/pulse.ts` — PulseCollector with callback
- `.vscode/mcp.json` — MCP server config for local testing
- `.squad/agents/` — workspace agents (fenster, hockney, strausz)
- `.squad/routing.md` — routing rules the Coordinator reads
