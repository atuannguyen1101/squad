# MCP Tool Visibility Pattern

## Overview

The Squad MCP server exposes different sets of tools to different audiences:
- **Public tools**: User-facing tools exposed on the MCP surface for Copilot discovery
- **Internal tools**: Agent coordination tools available inside sessions but not exposed via MCP

## Architecture

### Configuration-Driven Visibility

All tools are defined using the `registerTool()` helper, which conditionally registers them with the MCP server based on a `publicTools` Set:

```typescript
const publicTools = options.publicTools ?? DEFAULT_PUBLIC_TOOLS;

const registerTool = (schema, handler) => {
  if (publicTools.has(schema.name)) {
    mcp.addTool(schema, handler);
  }
  // Tool handler exists regardless - available to agents via SquadTools
};
```

### Default Configuration

```typescript
export const DEFAULT_PUBLIC_TOOLS = new Set([
  'squad_run',
  'squad_ask',
  'squad_respond',
  'squad_wait',
  'squad_status',
  'squad_cancel',
  'squad_analyze_run',
]);

export const INTERNAL_TOOLS = new Set([
  'squad_dispatch',
  'squad_send',
  'squad_read_session',
  'squad_close_session',
  'squad_pulse',
  'squad_roster',
  'squad_list_agents',
  'squad_monitor',
  'squad_memory',
  'squad_decide',
  'squad_intent',
  'squad_wait_for_idle',
]);
```

## Customization

### Exposing Internal Tools

For testing or advanced scenarios, you can expose internal tools:

```typescript
import { createSquadMCPServer, ALL_TOOLS } from '@bradygaster/squad-sdk/mcp';

await createSquadMCPServer({
  squadRoot: '.squad',
  publicTools: ALL_TOOLS, // Expose all tools including internal ones
});
```

### Custom Tool Sets

Create custom visibility configurations:

```typescript
const customTools = new Set([
  'squad_run',
  'squad_status',
  'squad_dispatch', // Expose this internal tool
]);

await createSquadMCPServer({
  squadRoot: '.squad',
  publicTools: customTools,
});
```

## Benefits Over if(false) Pattern

The previous implementation used `if (false) { mcp.addTool(...) }` to hide tools. This had several problems:

1. **Dead code**: Code inside `if (false)` blocks is never executed, making it vulnerable to removal by minifiers or refactoring tools
2. **Not configurable**: No way to change visibility without editing source code
3. **Hard to test**: Can't verify internal tools exist or work correctly
4. **Type safety issues**: TypeScript may warn about unreachable code

The new pattern solves all of these:

1. **All code executes**: Tool handlers are always defined, just not always registered
2. **Configurable**: Pass a custom `publicTools` Set via options
3. **Testable**: Can expose internal tools in test environments
4. **Type-safe**: No dead code branches, proper TypeScript inference

## Usage in Tests

```typescript
import { createSquadMCPServer, INTERNAL_TOOLS } from '@bradygaster/squad-sdk/mcp';

// Test internal tools
await createSquadMCPServer({
  squadRoot: '.squad',
  publicTools: new Set(['squad_dispatch', 'squad_send']),
});
```

## Migration Guide

If you were relying on the old `if (false)` pattern or accessing tools directly:

### Before
```typescript
// Tools were hidden via if(false) - no configuration option existed
```

### After
```typescript
import { createSquadMCPServer, DEFAULT_PUBLIC_TOOLS } from '@bradygaster/squad-sdk/mcp';

// Default: only public tools exposed
await createSquadMCPServer({ squadRoot: '.squad' });

// Custom: expose specific internal tools
const myTools = new Set([
  ...DEFAULT_PUBLIC_TOOLS,
  'squad_dispatch', // Add internal tool
]);
await createSquadMCPServer({ squadRoot: '.squad', publicTools: myTools });
```

## See Also

- `src/mcp/server.ts` - Implementation
- `src/tools/index.ts` - SquadTools interface (how agents access tools)
- `src/server/agent-lifecycle.ts` - Agent session tool access
