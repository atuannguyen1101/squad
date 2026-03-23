# Sage Proposals Priority Summary
**Date:** 2026-03-23  
**Reviewed by:** Flight (Lead)

## Executive Summary

Sage analyzed the most recent orchestration run and identified **6 critical/high-priority issues** that are blocking effective multi-agent coordination. Two are classified as CRITICAL and must be fixed immediately.

## Critical Issues (P0 - Fix This Sprint)

### 1. Agent Name Case-Sensitivity Bug 🔴 CRITICAL
**Proposal:** `2026-03-23T22-08-44-agent-name-case-sensitivity-bug-causing-duplicate-.md`  
**Priority:** CRITICAL  
**Category:** architecture  
**Target:** `packages/squad-sdk/src/runtime/session-pool.ts`

**Problem:** Both 'capcom' (76 messages, 2 pulses) and 'CAPCOM' (0 messages, 8 pulses) appeared in the same run, indicating duplicate sessions for the same agent with different casing. This splits metrics across duplicate entries and makes analysis impossible.

**Solution:**
1. Enforce lowercase normalization for all agent names in session creation
2. Add validation to reject spawn requests if normalized name already has active session  
3. Audit pulse routing to ensure case-insensitive matching

**Impact:** Data integrity issue affecting ALL metrics and analysis

---

### 2. Automatic Pulse Emission Safety Net 🔴 CRITICAL  
**Proposal:** `2026-03-23T22-08-44-implement-automatic-pulse-emission-safety-net-for-.md`  
**Priority:** CRITICAL  
**Category:** architecture  
**Target:** `packages/squad-sdk/src/runtime/session-wrapper.ts`

**Problem:** Fenster (185 messages across 3 runs) and Sage (15 messages) have emitted ZERO pulses despite being active. Charter instructions alone are insufficient for pulse discipline.

**Solution:** Implement runtime pulse enforcement in session wrapper:
1. Auto-emit 'starting' pulse when agent session begins if no pulse within first 2 messages
2. Auto-emit warning pulse at 20 messages if no pulse yet
3. Auto-emit 'unknown' status pulse at session end if agent never reported

**Impact:** Observability blind spots preventing effective coordination

---

## High Priority Issues (P1 - Next Sprint)

### 3. Mandatory Coordinator Reasoning for Work Concentration 🟡 HIGH
**Proposal:** `2026-03-23T22-08-44-add-mandatory-coordinator-reasoning-for-work-conce.md`  
**Priority:** HIGH  
**Category:** routing  
**Target:** `.squad/skills/routing/SKILL.md`

**Problem:** 179/207 messages (86%) concentrated in just 3 agents: capcom (76), fenster (70), strausz (33). Ben and coordinator handled only 9 messages each (4% each) despite being available. Pattern worsening: Run 1 (88%), Run 2 (80%), Run 3 (86%).

**Solution:** Add MANDATORY coordinator check at 30-message threshold:
- Coordinator must emit pulse explaining why decomposition was not chosen
- If decomposition skipped 3 times for same agent, flag for human review
- Forces explicit reasoning about work distribution

**Impact:** Forces better load distribution and utilizes underutilized agents

---

### 4. Ben's Systematic Progress Regression 🟡 HIGH
**Proposal:** `2026-03-23T22-08-44-ben-s-progress-regression-is-systematic-requires-r.md`  
**Priority:** HIGH  
**Category:** performance  
**Target:** `.squad/agents/ben/charter.md`

**Problem:** IDENTICAL progress pattern across 3 consecutive runs: 0→100→30→30→100. Probability of this being coincidental: <0.001. Root cause must be systematic.

**Likely causes:**
1. Ben's charter has 'report 100% when task assigned' trigger before work starts
2. Ben's model struggles with complexity assessment
3. Coordinator's task descriptions don't match actual scope

**Investigation protocol:**
1. Review Ben's charter starting section for premature completion
2. Check Ben's model tier in config
3. Review 3 consecutive coordinator→Ben handoff messages to identify pattern
4. Consider A/B test with different model

**Impact:** Affects progress tracking accuracy and coordination decisions

---

### 5. Integration Test for Pulse Discipline 🟡 HIGH
**Proposal:** `2026-03-23T22-08-45-create-integration-test-enforcing-pulse-emission-f.md`  
**Priority:** HIGH  
**Category:** testing  
**Target:** `test/integration/pulse-discipline.test.ts` (new file)

**Problem:** Fenster received 185 messages across 3 runs without emitting a single pulse. Agent clearly missing pulse emission capability or has charter that doesn't include squad_pulse calls.

**Solution:** Create integration test:
- Spawn each squad member with a test task
- Verify they emit at least 1 pulse within 5 messages
- Fail CI if any agent is 'silent'

**Impact:** Catches pulse discipline violations before they reach production

---

## Medium Priority Issues (P2 - Backlog)

### 6. Throughput Efficiency Metric 🟢 MEDIUM
**Proposal:** `2026-03-23T22-08-45-add-throughput-efficiency-metric-to-detect-coordin.md`  
**Priority:** MEDIUM  
**Category:** performance  
**Target:** `packages/squad-sdk/src/analysis/run-analyzer.ts`

**Problem:** Run duration increased to 16 minutes (13 msg/min) vs Run 2's 3 minutes (29 msg/min). Throughput collapsed by 55% despite more agents (7 vs 4).

**Possible causes:**
1. Agent coordination overhead with 7 concurrent agents
2. Long-session context degradation (3 agents with 33-76 messages each)
3. Silent agents forcing coordinator to wait/retry

**Solution:** Add 'efficiency score' to run analysis: messages per minute per active agent. Flag runs where throughput drops >40% compared to baseline.

**Impact:** Performance insight for detecting coordination overhead

---

## Sprint Prioritization Recommendation

### This Sprint (P0):
1. ✅ **Agent name case-sensitivity bug** - Fix in `session-pool.ts`
2. ✅ **Auto pulse safety net** - Implement in `session-wrapper.ts`

### Next Sprint (P1):
3. **Pulse discipline integration test** - New test file
4. **Ben's progress regression investigation** - Root cause analysis
5. **Work concentration reasoning** - Update routing skill

### Backlog (P2):
6. **Throughput efficiency metric** - Nice-to-have performance insight

---

## Additional Context

**Pattern Detection:**  
Sage has now analyzed 3 consecutive runs and identified systematic patterns:
- Work concentration is WORSENING (88% → 80% → 86%)
- Ben's progress regression is IDENTICAL across all runs (statistically impossible)
- Pulse discipline violations are CONSISTENT (Fenster: 0 pulses in 185 messages)

These are not random failures—they are systematic architectural issues that require code-level fixes, not just governance updates.

---

## Implementation Notes

**CRITICAL items block effective coordination** - without proper session management (case sensitivity) and observability (pulses), the team operates blind.

**HIGH items prevent optimal resource utilization** - work concentration and Ben's regression waste available agent capacity and slow overall throughput.

**MEDIUM items provide insights** - throughput metrics help diagnose performance but aren't blocking.

---

**Next Steps:**
1. EECOM: Implement agent name case normalization in session-pool.ts
2. EECOM: Implement automatic pulse emission in session-wrapper.ts
3. FIDO: Create pulse discipline integration test
4. Procedures: Investigate Ben's charter for premature completion triggers
5. Procedures: Update routing skill with 30-message decomposition checkpoint

