# CAPCOM — History

## Core Context

- **Project:** Squad — AI agent orchestration framework
- **Role:** SDK Expert
- **Joined:** 2025-01-25

## Learnings

### 2025-01-25: SDK Init Implementation Deep Dive

Completed deep technical analysis of `squad init --sdk` code paths. Key findings:

**CastingEngine is orphaned** — The SDK has a full universe-based casting system (`packages/squad-sdk/src/casting/casting-engine.ts`) with themed characters (The Usual Suspects, Ocean's Eleven), personality traits, backstories, and role-matching algorithms. **But no code calls it.** The CLI bypasses it with a hardcoded `personalityForRole()` function that generates generic personalities based on role patterns.

**Config/team sync is one-way** — The REPL init flow generates team.md, routing.md, and registry.json when casting a team, but never updates squad.config.ts. Meanwhile, `squad init --sdk` generates squad.config.ts with only Scribe, missing Ralph and all other agents. The disconnect: CLI init writes a skeleton + prompt, REPL auto-cast generates the team, but the two paths never merge into a unified config.

**Built-in agents are inconsistent** — Ralph is added by the REPL casting flow (`cli/core/cast.ts:385-386`) but not by SDK init (`cli/core/init.ts:109-115`). @copilot is a pseudo-agent — a Markdown table row inserted via `team-md.ts:insertCopilotSection()`, not a real agent with charter/history files.

**Universe selection is a dead end** — The coordinator init prompt asks the LLM to pick a universe (line 52: "Pick a fictional universe for character names"), and the coordinator responds with `UNIVERSE: Alien`, which gets stored in `casting/history.json`... and then **nothing uses it**. There's no mapping from freeform universe names to CastingEngine templates.

**The fix path is clear** — Three priority levels:
- **P0 (trivial):** Add Ralph to SDK init agents array, guide coordinator to existing CastingEngine universes
- **P1 (small/medium):** Integrate CastingEngine into CLI casting, make REPL init write squad.config.ts
- **P2 (design-heavy):** Decide config sync strategy (config-as-source vs. bidirectional), decide if @copilot should be a real agent

Written full technical analysis to `.squad/identity/sdk-init-technical-analysis.md` with file/line references, complexity estimates, and actionable recommendations for Brady's PRD.

**SDK patterns observed:**
- `defineSquad()` / `defineAgent()` builder pattern is clean and works well
- `configFormat` enum supports 'sdk' | 'typescript' | 'json' | 'markdown' — flexible but undertested
- Init flow is two-phase (CLI writes skeleton, REPL auto-casts) — intentional design but creates sync issues
- Template system in SDK (`templates/` directory) is well-structured, used correctly by `initSquad()`

📌 **Team update (2026-03-11T01:25:00Z):** 5 SDK Init decisions merged to decisions.md: Phase-based quality improvement (3-phase approach), CastingEngine canonical casting, squad.config.ts as source of truth, Ralph always-included, implementation priority order. Full technical analysis informed Flight's unified PRD and EECOM's roadmap.
