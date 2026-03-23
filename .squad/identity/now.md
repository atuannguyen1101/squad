---
updated_at: 2026-03-11T01:35:00Z
focus_area: SDK Init Shore-Up (PRD in progress)
version: v0.8.24
branch: main
tests_passing: 3931
tests_todo: 46
tests_skipped: 5
test_files: 149
team_size: 19 active agents + Scribe + Ralph + @copilot
team_identity: Apollo 13 / NASA Mission Control
process: All work through PRs. Branch naming squad/{issue-number}-{slug}. Never commit to main directly.
---

# What We're Focused On

**Status:** SDK Init Shore-Up initiative. Unified PRD drafted consolidating 6 SDK-related issues (#337-#342) into a 3-phase plan. Technical analysis and implementation roadmap complete. Awaiting Brady's decisions on open questions before Phase 1 kickoff.

## Current Initiative: SDK Init Shore-Up

**PRD:** `.squad/identity/prd-sdk-init-shoreup.md`
**Technical Analysis:** `.squad/identity/sdk-init-technical-analysis.md`
**Implementation Roadmap:** `.squad/identity/sdk-init-implementation-roadmap.md`

### Phase 1: Fix the Gaps (P1, Small scope)
- #337 — Config ↔ team.md sync broken → EECOM + CAPCOM
- #338 — Ralph missing from generated config → EECOM + CAPCOM
- #339 — @copilot routing without roster entry → EECOM + CAPCOM

### Phase 2: Wire CastingEngine (P1, Medium scope)
- #342 — CLI casting bypasses CastingEngine → EECOM + Procedures

### Phase 3: Exercise Test Matrix (P2, Large scope)
- #340 — 29 features need active exercise testing → FIDO + CAPCOM
- #341 — Full test results (32/50 verified) → FIDO + CAPCOM

### Open Design Questions
1. AST vs regex for squad.config.ts mutations
2. CastingEngine: augment LLM proposals (recommended) or replace entirely?
3. Ralph charter: create one, or document as "built-in, no charter"?

## 🚨 Next Session: Start Here

**Pick up the SDK Init PRDs.** The unified PRD at `.squad/identity/prd-sdk-init-shoreup.md` is ready for implementation. This is up for grabs — the team's next priority.

Before starting:
1. Fix EMU auth: `gh auth logout --user bradyg_microsoft`
2. Apply triage labels to the 10 unlabeled issues
3. Get Brady's decisions on open design questions (AST vs regex, CastingEngine approach, Ralph charter)
4. Kick off Phase 1 implementation

## Current State

**Version:** v0.8.24 (released, on npm)
- **Packages:** @bradygaster/squad-sdk, @bradygaster/squad-cli
- **Branch:** main
- **Build:** ✅ clean (0 errors)
- **Tests:** 3,931 passed, 46 todo, 5 skipped, 149 test files (~89s)

**Open Issues:** 30 total. 10 newly triaged this session (labels blocked by EMU auth — need `gh auth logout --user bradyg_microsoft`).

## Process

All work through PRs. Branch naming: `squad/{issue-number}-{slug}`. Never commit to main directly. Squad member review before merge.
