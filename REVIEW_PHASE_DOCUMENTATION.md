# Review Phase Execution - Technical Documentation

## Summary

**Review phases ARE correctly implemented and functional.** When the coordinator specifies a reviewer in its routing response, the pipeline automatically creates and executes a review phase after the implementation phase(s) complete.

## How It Works

### 1. Coordinator Routing Response

The coordinator can specify a reviewer in its routing JSON:

```json
// Single-agent with reviewer
{"implementer": "fenster", "reviewer": "hockney"}

// Multi-agent with reviewer  
{
  "subtasks": [
    {"agent": "fenster", "task": "fix auth"},
    {"agent": "eecom", "task": "add tests"}
  ],
  "reviewer": "hockney"
}

// No reviewer (optional)
{"implementer": "fenster", "reviewer": null}
```

### 2. Phase Generation

The `generateImplPhases` function in `packages/squad-sdk/src/pipeline/routing-parser.ts` processes the routing decision and creates phases:

**Single-agent routing:**
- If `reviewer` is specified: creates 2 phases
  - `implement` phase (assigned to implementer)
  - `review` phase (assigned to reviewer, depends on `implement`)
- If `reviewer` is null: creates 1 phase
  - `implement` phase only

**Multi-agent routing:**
- If `reviewer` is specified: creates N+1 phases
  - `implement-0`, `implement-1`, ..., `implement-N` (parallel implementation)
  - `review` phase (depends on all implement phases)
- If `reviewer` is null: creates N phases
  - `implement-0`, `implement-1`, ..., `implement-N` only

### 3. Review Phase Execution

The review phase:
- Runs AFTER all implementation phases complete
- Receives a task that includes:
  - Original user request
  - Instructions to use `squad_read_session` to inspect implementer's work
  - Guidance on what to check (code quality, tests, patterns, types)
  - Requirement to emit `squad_pulse` with phase "done" or "blocked"

**Single-agent review task template:**
```
Review the implementation for: {original message}

Use squad_read_session to read {implementer}'s session and see what was built.
Check: code quality, test coverage, pattern consistency, type safety.
Emit squad_pulse with phase "done" if approved or "blocked" with specific issues.
```

**Multi-agent review task template:**
```
Review the parallel implementation for: {original message}

{N} agents worked in parallel on subtasks:
- {agent1}: {task1}
- {agent2}: {task2}
...

- Use squad_read_session to read {agent1}'s session
- Use squad_read_session to read {agent2}'s session
...

NOTE: Some subtasks may have failed. Review the work that was completed.
Check: code quality, test coverage, pattern consistency, type safety.
IMPORTANT: Check for file conflicts between parallel agents — look for overlapping edits to the same files.
Emit squad_pulse with phase "done" if approved or "blocked" with specific issues.
```

### 4. Pipeline Execution Flow

```
User Request
    ↓
Coordinator routes → {"implementer": "fenster", "reviewer": "hockney"}
    ↓
generateImplPhases() creates:
  - Phase 1: implement (agent: fenster)
  - Phase 2: review (agent: hockney, dependsOn: ['implement'])
    ↓
PipelineRunner executes:
  1. Dispatches fenster with implementation task
  2. Waits for fenster's done pulse
  3. Dispatches hockney with review task
  4. Waits for hockney's done pulse
  5. Pipeline complete
```

## Code Locations

### Phase Generation
- **File:** `packages/squad-sdk/src/pipeline/routing-parser.ts`
- **Function:** `generateImplPhases()`
- **Lines:** 168-394
  - Single-agent review: 244-272
  - Multi-agent review: 356-390

### Pipeline Execution
- **File:** `packages/squad-sdk/src/mcp/server.ts`
- **Lines:** 1030-1093
  - Phase generation: 1030-1041
  - Pipeline execution: 1088-1093

### Routing Decision Parsing
- **File:** `packages/squad-sdk/src/pipeline/routing-parser.ts`
- **Function:** `parseRoutingDecision()`
- **Lines:** 123-153

## Tests

### Unit Tests
**File:** `test/bug-review-phase-execution.test.ts`
- ✅ Verifies review phases are created for single-agent routing
- ✅ Verifies review phases are created for multi-agent routing
- ✅ Verifies review phases are NOT created when reviewer is null

### Integration Tests
**File:** `test/review-phase-execution-integration.test.ts`
- ✅ Verifies review phase executes after implementation (single-agent)
- ✅ Verifies review phase executes after parallel implementations (multi-agent)
- ✅ Verifies dispatch order (implementer first, reviewer second)
- ✅ Verifies phase results contain both implementation and review

All tests pass ✅

## Common Misunderstandings

### "The reviewer field is parsed but never used"
**FALSE.** The reviewer field is:
1. Parsed by `parseRoutingDecision()` 
2. Used by `generateImplPhases()` to create the review phase
3. Passed to `PipelineRunner` as part of the phases array
4. Executed by the pipeline after implementation completes

### "Only implementation phases are created"
**FALSE.** When a reviewer is specified:
- Single-agent: 2 phases created (implement + review)
- Multi-agent: N+1 phases created (N implements + 1 review)

The tests confirm this behavior.

### "The pipeline ignores the reviewer"
**FALSE.** The pipeline executes ALL phases in the phases array, including review phases. The `PipelineRunner` respects phase dependencies (`dependsOn`), so the review phase runs after all implementation phases complete.

## Verification

To verify review phase execution in your own environment:

1. Enable debug logging (if available)
2. Make a request that should be reviewed
3. Check the coordinator's routing response - it should include a reviewer
4. Monitor pipeline execution - you should see:
   - Phase 1: implement (implementer agent)
   - Phase 2: review (reviewer agent)
5. Both phases should show as "completed" in the pipeline state

## Developer Notes

If you're modifying phase generation or execution:

1. **Keep review phase generation conditional** - Only create review phases when `reviewer` is not null
2. **Maintain dependency chain** - Review phase must depend on ALL implementation phases
3. **Update tests** - If you change phase generation logic, update both unit and integration tests
4. **Preserve task templates** - Reviewer tasks must include session reading instructions
5. **Handle partial failures** - For multi-agent, review should proceed even if some subtasks failed (`continueOnPartialFailure: true`)

## Related Files

- `packages/squad-sdk/src/pipeline/routing-parser.ts` - Phase generation
- `packages/squad-sdk/src/pipeline/runner.ts` - Pipeline execution
- `packages/squad-sdk/src/pipeline/types.ts` - Type definitions
- `packages/squad-sdk/src/mcp/server.ts` - MCP server integration
- `test/bug-review-phase-execution.test.ts` - Unit tests
- `test/review-phase-execution-integration.test.ts` - Integration tests

## Changelog

- **2024-03-25**: Added comprehensive documentation and integration tests
- Confirmed review phase execution is working correctly
- Added improved comments in `generateImplPhases()` function
