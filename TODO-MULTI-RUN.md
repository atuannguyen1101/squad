# Multi-Run Isolation Implementation TODO

## Completed (Phase 1)
- ✅ Created RunContext class with per-run state isolation
- ✅ Created DispatchSemaphore to serialize sendAndWait calls (landmine #5)
- ✅ Created safeSendAndWait wrapper with Promise.race + settled flag (landmines #2, #3)
- ✅ Updated AgentSessionManager for runId-based session keys (agentName::runId)
- ✅ Updated dispatch() and sendFollowUp() with optional runId parameter
- ✅ Added closeRunSessions() method
- ✅ Imported RunContextManager into server.ts
- ✅ Started squad_run refactoring to use RunContext

## Remaining Work (Phase 2) - server.ts Refactoring

### Critical Changes Needed

1. **Update squad_run tool handler** (lines 790-1200)
   - ✅ Create RunContext instead of setting singleton variables
   - ⏳ Pass runId to mgr.dispatch() calls
   - ⏳ Use runContext.intentGraph instead of activeIntentGraph
   - ⏳ Use runContext.pendingUserQuestions
   - ⏳ Use runContext.activePipelines
   - ⏳ Use runContext.pulseCollector instead of global pulseCollector
   - ⏳ Update waitForResponse to use runContext
   - ⏳ Pass runId in implPipelineDeps.dispatch
   - ⏳ CRITICAL: Remove waitForDonePulse call after dispatch (landmine #1)
   - ⏳ Auto-close run sessions on pipeline completion (call mgr.closeRunSessions(runId))

2. **Update squad_ask tool handler**
   - Add runId parameter (optional, defaults to most recent)
   - Use runContextManager.get(runId) to find context
   - Pass runId to mgr.sendFollowUp()

3. **Update squad_respond tool handler**
   - Add runId parameter (optional, defaults to most recent)
   - Use runContext.pendingUserQuestions
   - Pass runId to mgr.sendFollowUp()

4. **Update squad_wait tool handler**
   - Add runId parameter (optional, defaults to most recent)
   - Use runContext.waitResolvers
   - Use runContext.pulseCollector

5. **Update squad_cancel tool handler**
   - Add runId parameter (optional)
   - Add all: true flag to cancel all runs
   - Use runContextManager.cancel(runId) or cancelAll()
   - Call mgr.closeRunSessions(runId) for cleanup

6. **Update squad_analyze_run tool handler**
   - Add runId parameter (required after multi-run is live)
   - Query sessions by runId via mgr.listActiveSessions()

7. **Update squad_status tool handler**
   - Show all active runs with their runIds
   - Group sessions by runId in output

### Helper Functions to Update

8. **waitForResponse function** (line 836)
   - Accept runId parameter
   - Call mgr.getMessages(agentName, runId)
   - Use runContext.pendingUserQuestions

9. **implPipelineDeps object** (line 1000+)
   - Pass runId to dispatch calls
   - CRITICAL: Do NOT call waitForDonePulse (landmine #1)
   - Emit done pulse immediately after dispatch returns

### Dashboard Integration (Phase 3)

10. **Update dashboard API** (/api/agents endpoint)
    - Include runId in session metadata
    - Group agents by runId in response

11. **Update dashboard HTML** (packages/squad-cli/src/dashboard/index.html)
    - Add run grouping UI
    - Show runId headers above agent groups
    - Filter/toggle runs

## Testing Checklist

After Phase 2 is complete:

- [ ] Single squad_run works (legacy behavior)
- [ ] squad_ask works with runId
- [ ] squad_respond works with runId
- [ ] squad_wait works with runId
- [ ] squad_cancel cancels specific run
- [ ] squad_cancel --all cancels all runs
- [ ] Sessions are properly keyed by agentName::runId
- [ ] Sessions auto-close when run completes
- [ ] safeSendAndWait enforces 90s timeout
- [ ] Semaphore prevents concurrent sendAndWait calls
- [ ] Dashboard groups agents by runId
- [ ] No deadlocks on done pulse (landmine #1 avoided)
- [ ] No stale sessions from client.disconnect() (landmine #3 avoided)

## Known Landmines to Avoid

1. **implPipelineDeps.dispatch waitForDonePulse** - Do NOT call waitForDonePulse after dispatch. Emit done pulse immediately.
2. **sendAndWait timeout** - Always use safeSendAndWait, never raw session.sendAndWait
3. **client.disconnect()** - NEVER call in per-session/per-run cleanup. It's global.
4. **SessionPool.findByAgent()** - Do NOT use. It searches by name only, will corrupt multi-run.
5. **Concurrent sendAndWait** - Always use semaphore. Backend can only handle 1 at a time.

## Files Modified

- ✅ packages/squad-sdk/src/mcp/run-context.ts (new)
- ✅ packages/squad-sdk/src/mcp/dispatch-utils.ts (new)
- ✅ packages/squad-sdk/src/server/agent-lifecycle.ts (updated)
- ⏳ packages/squad-sdk/src/mcp/server.ts (in progress)
- ⏳ packages/squad-cli/src/dashboard/index.html (pending)

## Next Session

Start with finishing server.ts refactoring following this TODO. The foundation (RunContext, agent-lifecycle) is solid and building. Server.ts needs systematic updates to all tool handlers.
