# Agent Lifecycle Sessions Map Audit - Executive Summary

**Date:** 2026-03-28
**File Audited:** packages/squad-sdk/src/server/agent-lifecycle.ts
**Total Methods:** 20
**Lines of Code:** 1,207

---

## Critical Issues Requiring Immediate Fix

### 1. Missing runId Support (3 methods)
**Severity:** CRITICAL - Breaks multi-run session isolation

#### Affected Methods:
- **setWorkingFilePaths** (line 559)
- **getWorkingFilePaths** (line 570)
- **hasSession** (line 1034)

**Problem:** These methods use \gentName\ directly instead of \sessionKey\, making them incompatible with multi-run sessions.

**Impact:** When multiple runs are active for the same agent, these methods will:
- Set/get working files for the wrong session
- Check existence of wrong session
- Cause data corruption across runs

**Fix Required:**
\\\	ypescript
// Add runId parameter and use makeSessionKey
setWorkingFilePaths(agentName: string, filePaths: string[], runId?: string): void {
  const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
  const sessionKey = makeSessionKey(resolved, runId);  // FIX
  const entry = this.sessions.get(sessionKey);
  // ...
}
\\\

---

### 2. Stale sessionKey After Recreation (2 methods)
**Severity:** CRITICAL - Causes session corruption

#### Affected Methods:
- **dispatch** (line 515)
- **sendFollowUp** (line 1013)

**Problem:** After deleting expired session and creating new one, code uses old \sessionKey\ instead of \
ewKey\.

**Impact:**
- Messages sent to wrong session or lost
- Session state corruption
- Unpredictable behavior in error recovery

**Fix Required:**
\\\	ypescript
// dispatch line 515 - WRONG:
const currentEntry = this.sessions.get(sessionKey);  // OLD KEY

// FIX:
const currentEntry = this.sessions.get(newKey);  // NEW KEY from line 488

// sendFollowUp line 1013 - same fix needed
\\\

---

## Race Conditions Identified

### High Priority (Data Corruption Risk)

**RACE #2 & #9:** Message capture without locking
- **Location:** dispatch (lines 444-452), sendFollowUp (lines 952-956)
- **Issue:** Entry could be deleted between get() and message push
- **Impact:** Lost messages or null pointer crashes

**RACE #3 & #10:** Concurrent session recreation
- **Location:** dispatch (lines 485-519), sendFollowUp (lines 983-1017)
- **Issue:** Multiple error handlers could create duplicate sessions
- **Impact:** Session pool exhaustion, memory leaks

### Medium Priority (Transient Issues)

**RACE #1:** Duplicate session creation
- **Location:** getOrCreateSession (lines 317-391)
- **Issue:** Concurrent calls could create duplicate sessions
- **Impact:** Wasted resources, second creation overwrites first

**RACE #4:** Working files update during deletion
- **Location:** setWorkingFilePaths (lines 561-564)
- **Issue:** Entry could be deleted between get and set
- **Impact:** Silent failure, working files not updated

**RACE #5:** Message capture during closure
- **Location:** closeSession (lines 835-839)
- **Issue:** Messages captured after checking session exists
- **Impact:** Missing messages in learning extraction

### Low Priority (Acceptable)

**RACE #6, #7, #8, #11:** Iterator snapshot races
- **Impact:** Negligible - operations use snapshot at iteration time

---

## Session-Not-Found Handling Analysis

###  Graceful Handling (15 methods)
- getRegistryEntries, getOrCreateSession, closeSession, closeRunSessions
- closeAll, listActiveSessions, listSessionsForRun, getMessagesBySessionId
- getMessages, setWorkingFilePaths, getWorkingFilePaths, hasSession
- waitForIdle, persistSessionLearnings, buildHistoryInjection

###  Partial Handling (2 methods)
- **dispatch**: Handles expired sessions but has stale key bug (line 515)
- **sendFollowUp**: Handles expired sessions but has stale key bug (line 1013)

###  Throws Error (1 method)
- **sendFollowUp**: Throws error on missing session (line 953)
  - Inconsistent with other methods that return gracefully

---

## Testing Gaps

### Required Tests:
1. Multi-run session isolation with concurrent sessions
2. setWorkingFilePaths with runId parameter
3. getWorkingFilePaths with runId parameter
4. hasSession with runId parameter
5. Session expiration and recreation with concurrent dispatch
6. Message ordering under concurrent load
7. Race condition in session creation
8. Race condition in message capture
9. Concurrent closeSession and dispatch

---

## Recommendations

### Immediate (Block Release):
1.  Add runId parameter to setWorkingFilePaths, getWorkingFilePaths, hasSession
2.  Fix stale sessionKey usage in dispatch (line 515) and sendFollowUp (line 1013)
3.  Add comprehensive tests for multi-run scenarios

### Short-term (Next Sprint):
4. Add mutex/locking for message append operations
5. Add mutex for session creation to prevent duplicates
6. Make sendFollowUp error handling consistent (graceful return vs throw)
7. Remove dead code (lines 322-328, 334)

### Long-term (Future):
8. Consider event-driven message queue for better concurrency
9. Add circuit breaker for session recreation attempts
10. Implement comprehensive race condition testing suite

---

## Verification Checklist

Before merging fixes:
- [ ] All 3 methods accept runId parameter
- [ ] All sessionKey usages use makeSessionKey(agentName, runId)
- [ ] dispatch line 515 uses newKey not sessionKey
- [ ] sendFollowUp line 1013 uses newKey not sessionKey
- [ ] Tests added for multi-run scenarios
- [ ] Tests added for concurrent access patterns
- [ ] Build passes with no TypeScript errors
- [ ] No regressions in existing tests

---

**Full Report:** See agent-lifecycle-audit-report.md for detailed method-by-method analysis.
