# MCP Tool Visibility Implementation

## Summary
Implemented filtering of MCP tools to expose only user-facing tools on the MCP surface while keeping internal tools available to agents as SquadTools.

## Changes Made

### 1. Modified `packages/squad-sdk/src/mcp/server.ts`

**Tool Filtering:**
- Wrapped 12 internal tools in `if (false)` blocks to prevent registration on MCP surface
- Added `[INTERNAL - Not exposed on MCP]` markers to internal tool comments
- Updated file header documentation to explain the tool visibility split

**User-Facing Tools (7 total - EXPOSED on MCP):**
1. `squad_run` - Start a new coordinated agent run through Ben
2. `squad_ask` - Send a follow-up question to a running squad
3. `squad_respond` - Respond to a question from the squad
4. `squad_wait` - Wait for all agents to reach idle or specific status
5. `squad_status` - Get server status and dashboard URL
6. `squad_cancel` - Cancel a running session
7. `squad_analyze_run` - Analyze completed run and generate report

**Internal Tools (12 total - NOT exposed on MCP):**
1. `squad_dispatch` - Agent-to-agent task routing
2. `squad_send` - Agent-to-agent synchronous communication
3. `squad_read_session` - Agent session history inspection
4. `squad_close_session` - Session lifecycle management
5. `squad_pulse` - Status update reporting
6. `squad_roster` - Team roster access
7. `squad_list_agents` - Agent discovery
8. `squad_monitor` - Session monitoring
9. `squad_memory` - Agent memory management
10. `squad_decide` - Decision recording
11. `squad_intent` - Intent graph state management
12. `squad_wait_for_idle` - Internal coordination primitive

### 2. Created `test/mcp-tool-visibility.test.ts`

**Test Coverage:**
- Verifies exactly 7 user-facing tools are defined
- Verifies 12 internal tools are documented but not exposed
- Checks server.ts source code for correct `if (false)` wrapping
- Verifies all internal tools have `[INTERNAL - Not exposed on MCP]` markers
- Validates tool visibility documentation in server.ts header
- Enforces count invariant: 7 + 12 = 19 total tools

**All tests passing:** 5/5 ✅

### 3. Added Documentation

**In server.ts:**
- Comprehensive "Tool Visibility Strategy" section explaining the split
- Lists all user-facing tools with descriptions
- Lists all internal tools with descriptions
- Explains the `if (false)` pattern for keeping implementation intact

## Build Status

- TypeScript compilation: ✅ PASS
- New tool visibility tests: ✅ 5/5 PASS  
- Existing MCP tests: ✅ 20/20 PASS
- No regressions detected

## Verification Steps

To verify the implementation:

1. **Check tool registration count:**
   ```bash
   grep -c "mcp.addTool(" packages/squad-sdk/src/mcp/server.ts
   # Should show 19 total registrations
   ```

2. **Check if(false) guards:**
   ```bash
   grep -c "if (false) mcp.addTool" packages/squad-sdk/src/mcp/server.ts
   # Should show 12 (all internal tools)
   ```

3. **Check internal markers:**
   ```bash
   grep -c "\[INTERNAL - Not exposed on MCP\]" packages/squad-sdk/src/mcp/server.ts
   # Should show 12
   ```

4. **Run tests:**
   ```bash
   npx vitest run test/mcp-tool-visibility.test.ts
   # Should pass 5/5 tests
   ```

## Implementation Details

**Why `if (false)` instead of commenting out?**
- Preserves implementation code for reference
- TypeScript type-checks the disabled code
- Easy to enable for debugging if needed
- Clean git diffs when re-enabling

**Why keep internal tools in server.ts?**
- They remain available as SquadTools in `src/tools/index.ts`
- Documentation value for understanding the full tool surface
- Easy reference when agents need to invoke these tools

## Related Files
- Modified: `packages/squad-sdk/src/mcp/server.ts`
- Created: `test/mcp-tool-visibility.test.ts`
- Backup: `packages/squad-sdk/src/mcp/server.ts.backup`
