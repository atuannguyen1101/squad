# Agent-to-Agent Handoff Protocol

**Sprint 3, Item #7**

## Overview

The agent-to-agent handoff protocol enables agents to delegate sub-tasks to peer agents during their session. All handoffs route through the coordinator for observability and governance, maintaining the existing hub-spoke architecture.

## Features

- **Circular Delegation Detection**: Prevents agents from creating delegation loops (A → B → A)
- **Depth Limits**: Configurable maximum delegation chain depth to prevent runaway delegation
- **Wait-for-Result or Fire-and-Forget**: Agents can either wait for the delegated task to complete or continue with other work
- **Chain Tracking**: Full delegation history for debugging and observability
- **Event Emission**: Integration with the OpenTelemetry tracing system

## Architecture

```
Agent A (doing work)
  ↓ squad_handoff tool call
Coordinator (validates + tracks)
  ↓ spawns session
Agent B (handles sub-task)
  ↓ result
Coordinator (returns result)
  ↓
Agent A (continues with result)
```

## Usage

### For Agents (via MCP Tool)

Agents can delegate work using the `squad_handoff` tool:

```typescript
// Example: Agent Fenster delegates test writing to McManus
{
  toAgent: "mcmanus",
  task: "Write unit tests for the handoff manager",
  context: "Test file should cover validation, chain tracking, and error cases",
  waitForResult: true,  // Wait for McManus to finish
  priority: "high"
}
```

### For SDK Integrators

```typescript
import { HandoffManager } from '@bradygaster/squad-sdk/coordinator';
import { ToolRegistry } from '@bradygaster/squad-sdk/tools';

// Create handoff manager
const handoffManager = new HandoffManager({
  maxDepth: 5,  // Maximum delegation chain depth
  enableTelemetry: true  // OpenTelemetry integration
});

// Wire into tool registry
const toolRegistry = new ToolRegistry(
  '.squad',
  sessionPoolGetter,
  handoffManager  // Pass handoff manager as 3rd argument
);

// Validate a handoff request
const validation = handoffManager.validateHandoff({
  fromAgent: 'fenster',
  toAgent: 'mcmanus',
  task: 'Write tests'
});

if (validation.valid) {
  // Record the handoff
  const chainId = handoffManager.recordHandoff(
    request,
    sessionId,
    parentChainId  // Optional: extends existing chain
  );
  
  // ... spawn agent session ...
}
```

## Validation Rules

The `validateHandoff()` method checks:

1. **Self-delegation**: Agent cannot delegate to itself
2. **Circular delegation**: Target agent must not already be in the delegation chain
3. **Depth limit**: Chain length must be less than `config.maxDepth`

Returns:
```typescript
{
  valid: boolean,
  reason?: string,  // Present when valid=false
  depth: number     // Current chain depth
}
```

## Chain Tracking

Each handoff creates or extends a delegation chain:

```typescript
// Get chain info
const chain = handoffManager.getChain(chainId);
// Returns: HandoffChainNode[]

interface HandoffChainNode {
  agent: string;         // Agent name
  sessionId?: string;    // Session ID
  task: string;          // Task description
  timestamp: Date;       // When delegated
}
```

## Integration Points

### 1. Tool Registry
The `squad_handoff` tool is registered in `ToolRegistry` and exposed to agents via MCP.

### 2. Coordinator
When a handoff is requested:
- Coordinator validates the request via `HandoffManager`
- Creates a new agent session for the target agent
- Tracks the delegation chain
- Returns the result to the requesting agent (if `waitForResult=true`)

### 3. Event Bus
Handoff events are emitted for observability:
- `handoff:requested` - When an agent calls squad_handoff
- `handoff:validated` - After validation completes
- `handoff:completed` - When the delegated task finishes

## Configuration

```typescript
interface HandoffConfig {
  /** Maximum delegation chain depth (default: 5) */
  maxDepth: number;
  
  /** Enable OpenTelemetry spans (default: true) */
  enableTelemetry?: boolean;
}
```

## Error Handling

When validation fails:
- The `squad_handoff` tool returns `resultType: 'failure'`
- The error message includes the validation reason
- No session is spawned
- The requesting agent can handle the error and retry or adjust

## Testing

See `test/handoff.test.ts` for comprehensive test coverage:
- ✅ Validation rules (self-delegation, circular delegation, depth limits)
- ✅ Chain tracking and recording
- ✅ Chain clearing and management
- ✅ Edge cases (long chains, multiple branches)

## Future Enhancements

- **Result Caching**: Cache results from common handoffs to avoid redundant work
- **Priority Scheduling**: Higher-priority handoffs get scheduled first
- **Timeout Handling**: Automatic timeout for long-running delegated tasks
- **Metrics**: Track handoff success rates, latencies, and patterns
- **Circular Detection Hints**: Suggest alternative agents when circular delegation is detected

## Files

- `packages/squad-sdk/src/coordinator/handoff.ts` - HandoffManager implementation
- `packages/squad-sdk/src/tools/index.ts` - squad_handoff tool registration
- `test/handoff.test.ts` - Test suite (23 tests, all passing)
- `docs/agent-handoff.md` - This documentation
