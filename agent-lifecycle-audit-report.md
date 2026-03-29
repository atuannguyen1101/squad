# Critical Code Review: agent-lifecycle.ts - Sessions Map Audit

**File:** packages/squad-sdk/src/server/agent-lifecycle.ts
**Auditor:** GNC (Node.js Runtime)
**Date:** 2026-03-28 20:28:34
**Total Methods Analyzed:** 20

---

## Executive Summary

### Critical Findings
- **HIGH SEVERITY:** 4 methods do NOT use sessionKey with runId (lines 261, 561, 572, 1035)
- **MEDIUM SEVERITY:** 2 methods have incomplete session-not-found handling (lines 515, 1013)
- **LOW SEVERITY:** Multiple race conditions in message capture and session deletion

### Overview
The sessions Map is keyed using makeSessionKey(agentName, runId) which produces:
- \gentName::runId\ when runId is provided
- \gentName\ when runId is undefined (legacy mode)

---

## Detailed Method Audit

### 1. **constructor** (Line 245)
- **Uses sessionKey with runId:** N/A (initializes empty Map)
- **Session-not-found handling:** N/A
- **Race conditions:** None
- **Issues:** None

---

### 2. **getRegistryEntries** (Line 280)
- **Uses sessionKey with runId:**  YES - Reads all entries via Map.values()
- **Session-not-found handling:**  GRACEFUL - Returns empty array if no sessions
- **Race conditions:** None - read-only operation
- **Issues:** None

---

### 3. **getOrCreateSession** (Lines 309-424)
- **Uses sessionKey with runId:**  YES - Line 315: \const sessionKey = makeSessionKey(resolved, runId);\
- **Session-not-found handling:**  GRACEFUL - Creates new session if not found (line 317)
- **Race conditions:** 
  - **RACE #1:** Between checking \	his.sessions.get(sessionKey)\ (line 317) and creating session (line 378), another caller could create the same session
  - **Impact:** LOW - Would result in duplicate sessions briefly, but second caller would overwrite
- **Issues:** 
  - Comments on lines 322-328 reference removed code (BLOCKER #4 FIX)
  - Line 334 checks sessionKey again redundantly (existingEntry will always be undefined at this point)

---

### 4. **dispatch** (Lines 435-552)
- **Uses sessionKey with runId:**  YES - Line 444: \const entry = this.sessions.get(sessionKey);\
- **Session-not-found handling:**  PARTIAL
  - **GOOD:** Handles expired sessions via "Session not found" error detection (lines 481-519)
  - **GOOD:** Deletes stale session and retries (line 486)
  - **ISSUE:** Line 515 \currentEntry\ uses sessionKey but session may have been deleted and recreated with different key
- **Race conditions:**
  - **RACE #2:** Lines 444-452 - Between getting entry and pushing message, entry could be deleted by closeSession
  - **RACE #3:** Lines 485-519 - Session recreation during error handling could collide with concurrent dispatch
- **Issues:**
  - Line 515: Uses old sessionKey after deleting and creating new session - should use newKey from line 488

---

### 5. **setWorkingFilePaths** (Lines 559-564)
- **Uses sessionKey with runId:**  NO - Line 561: Uses \esolved\ directly, not sessionKey
- **Session-not-found handling:**  GRACEFUL - Silent no-op if session doesn't exist
- **Race conditions:** 
  - **RACE #4:** Entry could be deleted between get and setting workingFilePaths
- **Issues:**
  - **CRITICAL:** This method doesn't support runId parameter - will fail for multi-run sessions
  - Missing runId parameter in signature

---

### 6. **getWorkingFilePaths** (Lines 570-574)
- **Uses sessionKey with runId:**  NO - Line 572: Uses \esolved\ directly, not sessionKey
- **Session-not-found handling:**  GRACEFUL - Returns undefined if session doesn't exist
- **Race conditions:** None - read-only
- **Issues:**
  - **CRITICAL:** This method doesn't support runId parameter - will fail for multi-run sessions
  - Missing runId parameter in signature

---

### 7. **closeSession** (Lines 828-871)
- **Uses sessionKey with runId:**  YES - Line 830: \const sessionKey = makeSessionKey(resolved, runId);\
- **Session-not-found handling:**  GRACEFUL - Early return if no session (line 832)
- **Race conditions:**
  - **RACE #5:** Lines 835-839 - Captures messages AFTER checking session exists, but before acquiring any lock. Concurrent dispatch could add messages during capture.
- **Issues:** None - proper cleanup order (capture, close, delete)

---

### 8. **closeRunSessions** (Lines 876-882)
- **Uses sessionKey with runId:**  YES - Line 877: Filters by \::\\ suffix
- **Session-not-found handling:**  GRACEFUL - Uses Promise.allSettled
- **Race conditions:**
  - **RACE #6:** Sessions could be created between key collection (line 877) and closure (lines 878-881)
- **Issues:** None - proper use of allSettled

---

### 9. **closeAll** (Lines 887-891)
- **Uses sessionKey with runId:**  YES - Uses Map.keys()
- **Session-not-found handling:**  GRACEFUL - Uses Promise.allSettled
- **Race conditions:**
  - **RACE #7:** Same as RACE #6 - sessions could be created during iteration
- **Issues:** None

---

### 10. **listActiveSessions** (Lines 896-906)
- **Uses sessionKey with runId:**  YES - Uses Map.values()
- **Session-not-found handling:**  GRACEFUL - Returns empty array if no sessions
- **Race conditions:** None - snapshot read
- **Issues:** None

---

### 11. **listSessionsForRun** (Lines 912-917)
- **Uses sessionKey with runId:**  YES - Filters by \::\\ suffix
- **Session-not-found handling:**  GRACEFUL - Returns empty array
- **Race conditions:** None - snapshot read
- **Issues:** None

---

### 12. **getMessagesBySessionId** (Lines 923-930)
- **Uses sessionKey with runId:**  YES - Iterates Map.values()
- **Session-not-found handling:**  GRACEFUL - Returns empty array
- **Race conditions:**
  - **RACE #8:** Messages could be added during iteration, but slice would miss them (acceptable)
- **Issues:** None

---

### 13. **getMessages** (Lines 936-940)
- **Uses sessionKey with runId:**  YES - Line 938: \const sessionKey = makeSessionKey(resolved, runId);\
- **Session-not-found handling:**  GRACEFUL - Returns empty array
- **Race conditions:** None - snapshot read
- **Issues:** None

---

### 14. **sendFollowUp** (Lines 949-1029)
- **Uses sessionKey with runId:**  YES - Line 951: \const sessionKey = makeSessionKey(resolved, runId);\
- **Session-not-found handling:**  THROWS - Line 953: Throws error if no session
- **Race conditions:**
  - **RACE #9:** Same as dispatch - lines 952-956 entry could be deleted
  - **RACE #10:** Lines 983-1017 - Session recreation during error handling
  - **ISSUE:** Line 1013 uses old sessionKey after deleting and creating new session
- **Issues:**
  - Line 1013: Uses old sessionKey (\currentEntry\) after session was deleted - should use newKey from line 986
  - Inconsistent error handling - throws on missing session instead of graceful fallback

---

### 15. **hasSession** (Lines 1034-1036)
- **Uses sessionKey with runId:**  NO - Uses agentName directly, not sessionKey
- **Session-not-found handling:**  GRACEFUL - Returns boolean
- **Race conditions:** None - snapshot check
- **Issues:**
  - **CRITICAL:** This method doesn't support runId parameter - will fail for multi-run sessions
  - Missing runId parameter in signature

---

### 16. **activeCount** (Lines 1041-1043)
- **Uses sessionKey with runId:**  YES - Uses Map.size
- **Session-not-found handling:** N/A
- **Race conditions:** None - atomic read
- **Issues:** None

---

### 17. **waitForIdle** (Lines 1049-1078)
- **Uses sessionKey with runId:**  YES - Line 1058: Uses Map.values()
- **Session-not-found handling:**  GRACEFUL - Handles empty sessions
- **Race conditions:**
  - **RACE #11:** Sessions could be added/removed during polling loop
  - **Impact:** LOW - Uses snapshot per iteration
- **Issues:** None - acceptable for idle detection

---

### 18. **maybeApplyContextWindow** (Lines 1088-1103)
- **Uses sessionKey with runId:** N/A - Operates on passed entry
- **Session-not-found handling:** N/A - Private helper
- **Race conditions:** None - operates on entry reference
- **Issues:** None

---

### 19. **buildHistoryInjection** (Lines 1112-1162)
- **Uses sessionKey with runId:** N/A - Reads from filesystem
- **Session-not-found handling:**  GRACEFUL - Returns null
- **Race conditions:** None
- **Issues:** None

---

### 20. **persistSessionLearnings** (Lines 1169-1194)
- **Uses sessionKey with runId:** N/A - Operates on passed data
- **Session-not-found handling:**  GRACEFUL - Try-catch
- **Race conditions:** None
- **Issues:** None

---

## Summary of Issues

### Critical Issues (Must Fix)

1. **setWorkingFilePaths** (Line 559-564)
   - Missing runId parameter - cannot work with multi-run sessions
   - Uses \esolved\ instead of \sessionKey\
   - **Fix:** Add runId parameter, use makeSessionKey

2. **getWorkingFilePaths** (Line 570-574)
   - Missing runId parameter - cannot work with multi-run sessions
   - Uses \esolved\ instead of \sessionKey\
   - **Fix:** Add runId parameter, use makeSessionKey

3. **hasSession** (Line 1034-1036)
   - Missing runId parameter - cannot work with multi-run sessions
   - Uses \gentName\ instead of \sessionKey\
   - **Fix:** Add runId parameter, use makeSessionKey

4. **dispatch** (Line 515)
   - After session recreation, uses old \sessionKey\ instead of \
ewKey\
   - **Fix:** Use \
ewKey\ from line 488

5. **sendFollowUp** (Line 1013)
   - After session recreation, uses old \sessionKey\ instead of \
ewKey\
   - **Fix:** Use \
ewKey\ from line 986

### Medium Issues (Should Fix)

6. **Race condition in message capture** (Multiple methods)
   - dispatch and sendFollowUp push messages without locking
   - Could result in message ordering issues during concurrent calls
   - **Fix:** Consider using a message queue or atomic append

7. **Redundant session check** (Line 334)
   - \xistingEntry\ is checked after already checking \xisting\ on line 317
   - This code path is unreachable
   - **Fix:** Remove redundant check and comments about removed code

### Low Issues (Nice to Have)

8. **Race condition in session creation** (Line 317-391)
   - Multiple concurrent getOrCreateSession calls could create duplicate sessions
   - **Fix:** Use atomic Map operations or mutex

9. **Session recreation race** (dispatch, sendFollowUp)
   - Concurrent error handling could create multiple sessions
   - **Fix:** Use mutex during session recreation

---

## Recommendations

1. **Immediate Actions:**
   - Add runId parameter to setWorkingFilePaths, getWorkingFilePaths, hasSession
   - Fix sessionKey usage in error handling paths (lines 515, 1013)

2. **Short-term Actions:**
   - Add mutex/locking for session creation and message appending
   - Remove dead code and redundant checks

3. **Long-term Actions:**
   - Consider event-driven message queue for better concurrency
   - Add comprehensive race condition testing

---

## Test Coverage Needed

1. Test multi-run isolation with concurrent sessions
2. Test setWorkingFilePaths/getWorkingFilePaths with runId
3. Test hasSession with runId
4. Test session expiration and recreation paths
5. Test concurrent dispatch to same agent
6. Test message ordering under concurrent load

---

## Code Examples

### Fix for setWorkingFilePaths
\\\	ypescript
setWorkingFilePaths(agentName: string, filePaths: string[], runId?: string): void {
  const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
  const sessionKey = makeSessionKey(resolved, runId);  // FIX: Use sessionKey
  const entry = this.sessions.get(sessionKey);
  if (entry) {
    entry.workingFilePaths = filePaths;
  }
}
\\\

### Fix for dispatch error handling (Line 515)
\\\	ypescript
// OLD (WRONG):
const currentEntry = this.sessions.get(sessionKey);

// NEW (CORRECT):
const currentEntry = this.sessions.get(newKey);
\\\

---

**End of Audit Report**
