### 2026-03-23T16-57-36: BLOCKED: cross-session learning persistence doesn't fire at runtime despite 17/17 tests passing
**By:** FIDO
**What:** ## Quality Gate: Cross-Session Learning Persistence (M4-12)

**Test result:** 17/17 passing (after \Z regex fix applied ~5 min after initial report)

**BLOCKED reason:** enableLearningPersistence() has zero call sites in production code. AgentSessionManager.destroy() emits 'session.destroyed' (dot, client bus, empty payload) — the handler subscribes to 'session:destroyed' (colon, runtime bus, expects messages in payload). Feature never fires for real users.

**Three required fixes before merge:**
1. Wire enableLearningPersistence() into server/coordinator startup path
2. Fix AgentSessionManager.destroy() to emit 'session:destroyed' on runtime bus with messages in payload
3. Delete or consolidate session-learnings.ts (dead code — never imported, has better patterns than the extractor in use)

**What is solid:** atomic writes, per-file mutex, fire-and-forget error isolation, TypeScript clean, extraction patterns correct, unsubscribe lifecycle correct. SDK components are production-quality. Integration path is the only gap.
**References:** sims, learning-persistence.ts, history-shadow.ts, agents/index.ts
**Why:** ## Quality Gate: Cross-Session Learning Persistence (M4-12)

**Test result:** 17/17 passing (after \Z regex fix applied ~5 min after initial report)

**BLOCKED reason:** enableLearningPersistence() has zero call sites in production code. AgentSessionManager.destroy() emits 'session.destroyed' (dot, client bus, empty payload) — the handler subscribes to 'session:destroyed' (colon, runtime bus, expects messages in payload). Feature never fires for real users.

**Three required fixes before merge:**
1. Wire enableLearningPersistence() into server/coordinator startup path
2. Fix AgentSessionManager.destroy() to emit 'session:destroyed' on runtime bus with messages in payload
3. Delete or consolidate session-learnings.ts (dead code — never imported, has better patterns than the extractor in use)

**What is solid:** atomic writes, per-file mutex, fire-and-forget error isolation, TypeScript clean, extraction patterns correct, unsubscribe lifecycle correct. SDK components are production-quality. Integration path is the only gap.