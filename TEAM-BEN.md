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
- `squad_cancel` to stop an active run (not yet implemented)

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
| Unit Tests | `test/pipeline.test.ts`, `test/pulse.test.ts`, `test/intent-graph.test.ts`, `test/built-in-actors.test.ts` | 42/42 passing |

## What's Incomplete

| Item | Impact |
|------|--------|
| Pipeline understand phase vs Q&A loop | Ben asks questions via squad_pulse, user answers via squad_respond, but pipeline waitForResponse grabs Ben's question as the "response" instead of waiting for Ben's final answer after clarification |
| Intent Graph not updated mid-run | Ben creates it once, never maintains it |
| Context windowing | Old messages accumulate unbounded in agent sessions |
| Shared scratchpad | No cross-agent artifact sharing mechanism |
| Concurrent `squad_run` race | Module-scoped singletons overwritten by second run |
| `squad_cancel` | No way to stop an active pipeline |
| MCP wiring tests | The most complex code has zero test coverage |
| Sage end-to-end test | `squad_analyze_run` exists but not tested with Sage as dispatched agent |
| Dashboard port stability | Port changes on restart if old process didn't fully exit |
