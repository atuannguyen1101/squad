# MCP Tool Visibility Refactoring Summary

## Changes Made

### 1. server.ts Refactoring
**File:** packages/squad-sdk/src/mcp/server.ts

**Before:**
- 12 internal tools wrapped in `if (false) mcp.addTool(...)` blocks
- 7 user-facing tools called `mcp.addTool(...)` directly
- Dead code pattern (if(false) blocks)

**After:**
- Created `publicTools` Set containing 7 user-facing tool names
- Created `registerTool()` helper function that checks publicTools Set
- All 19 tools (7 public + 12 internal) now use `registerTool()`
- Clean, maintainable code with explicit visibility control

**Code Added:**
```typescript
// Define which tools are exposed on the MCP surface
const publicTools = new Set([
  'squad_run',
  'squad_ask',
  'squad_respond',
  'squad_wait',
  'squad_status',
  'squad_cancel',
  'squad_analyze_run',
]);

// Helper to conditionally register tools based on visibility
const registerTool = (
  schema: {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  },
  handler: (args: Record<string, any>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
) => {
  if (publicTools.has(schema.name)) {
    mcp.addTool(schema, handler);
  }
  // Internal tools remain defined for documentation but are not registered
};
```

### 2. Test Updates
**File:** test/mcp-tool-visibility.test.ts

**Changes:**
- Updated tests to check for `registerTool()` pattern instead of `if (false)`
- Added verification that public tools are in the publicTools Set
- Added verification that internal tools are NOT in the publicTools Set
- All 5 tests pass

## Benefits

1. **No dead code:** Removed all `if (false)` blocks
2. **Clear visibility control:** publicTools Set is single source of truth
3. **Easy to maintain:** Add/remove tools from Set to change visibility
4. **Type-safe:** registerTool helper has proper TypeScript types
5. **Well-tested:** All existing tests pass with updated assertions

## Verification

-  All 5 tests in mcp-tool-visibility.test.ts pass
-  TypeScript compilation successful (only pre-existing pulse.ts errors remain)
-  19 tools total (7 public + 12 internal) properly registered
-  Zero `if (false)` blocks remain in codebase

## Files Modified

1. `packages/squad-sdk/src/mcp/server.ts` - Main refactoring
2. `test/mcp-tool-visibility.test.ts` - Test updates
3. `packages/squad-sdk/src/mcp/server.ts.backup` - Backup created

