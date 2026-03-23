# Sprint 3, Item #14: Intent Graph Visibility — Implementation Complete

## Summary

Implemented intent graph visibility for spawned agents, allowing them to see their specific assignment, how it fits into the overall goal, relevant constraints, and acceptance criteria.

## What Was Implemented

### 1. Core Intent Graph Infrastructure

**Files Created:**
- `packages/squad-sdk/src/intent/types.ts` (42 lines)
  - Core types: `IntentNode`, `IntentEdge`, `IntentGraphData`, `IntentSummary`
  - Node types: goal, constraint, acceptance_criterion, task
  - Edge types: depends_on, blocks, enables, part_of

- `packages/squad-sdk/src/intent/IntentGraph.ts` (100 lines)
  - Graph data structure with node/edge operations
  - Filtering by type and agent
  - Root goal tracking
  - Serialization/deserialization
  - Metadata timestamp tracking

- `packages/squad-sdk/src/intent/IntentSummarizer.ts` (138 lines)
  - Agent-specific summarization logic
  - Markdown rendering
  - Context building (dependencies, enablers)
  - Extracts relevant constraints and acceptance criteria

- `packages/squad-sdk/src/intent/index.ts` (10 lines)
  - Module exports

### 2. System Prompt Integration

**File Created:**
- `packages/squad-sdk/src/agents/agent-lifecycle.ts` (69 lines)
  - `buildSystemPrompt()` — composes system prompts with optional intent context
  - `createSystemPromptWithConfig()` — wires config to prompt building
  - Opt-in via `includeIntentContext: boolean` config flag

**File Modified:**
- `packages/squad-sdk/src/agents/index.ts`
  - Added exports for intent graph lifecycle functions

### 3. Comprehensive Test Coverage

**Test Files Created:**
- `packages/squad-sdk/src/__tests__/intent/IntentGraph.test.ts` (178 lines)
  - 10 tests covering node/edge operations, filtering, serialization
  
- `packages/squad-sdk/src/__tests__/intent/IntentSummarizer.test.ts` (166 lines)
  - 12 tests covering summarization, markdown rendering, context building

- `packages/squad-sdk/src/__tests__/agents/agent-lifecycle.test.ts` (165 lines)
  - 8 tests covering system prompt building with/without intent context

**All 30 tests pass ✅**

### 4. Infrastructure Updates

**Files Modified:**
- `packages/squad-sdk/package.json`
  - Added vitest dev dependency
  - Added test scripts (`test`, `test:watch`)
  - Added `./intent` export path

- `packages/squad-sdk/vitest.config.ts` (created)
  - Vitest configuration for test running

- `packages/squad-sdk/src/index.ts`
  - Added intent graph exports to public API

### 5. Documentation

**File Created:**
- `packages/squad-sdk/src/intent/README.md` (346 lines)
  - Architecture overview
  - Usage examples
  - Integration patterns
  - Full pipeline flow example

## File Size Compliance

All files kept under 200 lines as required:
- IntentGraph.ts: 100 lines ✅
- IntentSummarizer.ts: 138 lines ✅
- agent-lifecycle.ts: 69 lines ✅
- types.ts: 42 lines ✅
- index.ts: 10 lines ✅

## Key Features

### 1. Intent Graph Construction

```typescript
const graph = new IntentGraph();

// Add goal
graph.addNode({
  id: 'goal-1',
  type: 'goal',
  description: 'Migrate Products blade to React',
  status: 'in_progress',
});
graph.setRootGoal('goal-1');

// Add constraints
graph.addNode({
  id: 'constraint-1',
  type: 'constraint',
  description: 'Keep files under 200 lines',
  status: 'pending',
});

// Add task assignments
graph.addNode({
  id: 'task-ui',
  type: 'task',
  description: 'Implement React UI components',
  status: 'in_progress',
  assignedTo: 'fenster',
});

// Define dependencies
graph.addEdge({ from: 'task-data', to: 'task-ui', type: 'enables' });
```

### 2. Agent-Specific Summarization

```typescript
const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
// {
//   overallGoal: "Migrate Products blade to React",
//   agentAssignment: {
//     taskId: "task-ui",
//     description: "Implement React UI components",
//     status: "in_progress"
//   },
//   relevantConstraints: ["Keep files under 200 lines"],
//   relevantAcceptanceCriteria: ["All tests pass"],
//   contextInPipeline: "This task depends on: Create data layer hooks"
// }
```

### 3. System Prompt Integration

```typescript
const prompt = buildSystemPrompt({
  agentName: 'fenster',
  role: 'UI Developer',
  charter: '...',
  history: ['...'],
  intentGraph: graph,
  includeIntentContext: true,  // opt-in
});
```

Output includes:
```markdown
# fenster — UI Developer

## Charter
...

# Intent Context

**Overall Goal:** Migrate Products blade to React

## Your Assignment
**Task:** Implement React UI components
**Status:** in_progress

## How This Fits
This task depends on: Create data layer hooks

## Constraints
- Keep files under 200 lines

## Acceptance Criteria
- All tests pass

## Recent Context
...
```

## Opt-In Design

The feature is **disabled by default** to preserve existing behavior:

```typescript
// Without config flag, intent context is NOT included
const prompt1 = buildSystemPrompt({ ... });

// Must explicitly enable it
const prompt2 = buildSystemPrompt({ ..., includeIntentContext: true });

// Or via config
const config: SquadConfig = { includeIntentContext: true };
const prompt3 = createSystemPromptWithConfig({ ... }, config);
```

## Boundaries Respected

- ✅ Did NOT touch `tools/index.ts` (fenster's zone)
- ✅ Did NOT touch routing modules (eecom's zone)
- ✅ Implementation lives in `intent/` and `agents/` modules
- ✅ All files under 200 lines
- ✅ Comprehensive test coverage

## Integration Points

The coordinator can integrate this by:

1. **Building the intent graph from a PRD:**
   - Parse goal, constraints, acceptance criteria
   - Create task nodes for each agent assignment
   - Add edges to represent dependencies

2. **Passing it to agent spawns:**
   - Include `intentGraph` in `SystemPromptOptions`
   - Set `includeIntentContext: true` in config

3. **Updating status as work progresses:**
   - Call `graph.updateNode(taskId, { status: 'completed' })`
   - Agents spawned later see the updated state

## Example End-to-End Flow

```typescript
// 1. Coordinator parses PRD and builds intent graph
const graph = new IntentGraph();
graph.addNode({
  id: 'goal-1',
  type: 'goal',
  description: 'Migrate Subscriptions blade',
  status: 'in_progress',
});
graph.setRootGoal('goal-1');

// 2. Add constraints from project standards
graph.addNode({
  id: 'constraint-1',
  type: 'constraint',
  description: 'Files under 200 lines',
  status: 'pending',
});

// 3. Assign tasks
graph.addNode({
  id: 'task-data',
  type: 'task',
  description: 'Data layer: contracts, URIs, requests',
  status: 'in_progress',
  assignedTo: 'mcmanus',
});

graph.addNode({
  id: 'task-ui',
  type: 'task',
  description: 'UI layer: hooks, view, components',
  status: 'pending',
  assignedTo: 'fenster',
});

graph.addEdge({ from: 'task-data', to: 'task-ui', type: 'enables' });

// 4. Spawn McManus with intent context
const mcmanusPrompt = buildSystemPrompt({
  agentName: 'mcmanus',
  role: 'Data Layer Developer',
  charter: mcmanusCharter,
  intentGraph: graph,
  includeIntentContext: true,
});
// McManus sees: "Your work enables: UI layer: hooks, view, components"

// 5. After data layer completes, update graph and spawn Fenster
graph.updateNode('task-data', { status: 'completed' });
graph.updateNode('task-ui', { status: 'in_progress' });

const fensterPrompt = buildSystemPrompt({
  agentName: 'fenster',
  role: 'UI Developer',
  charter: fensterCharter,
  intentGraph: graph,
  includeIntentContext: true,
});
// Fenster sees: "This task depends on: Data layer: contracts, URIs, requests"
```

## Status

✅ **Implementation Complete**
✅ **All 30 tests passing**
✅ **Documentation complete**
✅ **Ready for integration**

The intent graph infrastructure is now available for the coordinator to use when spawning agents. It's opt-in via config, so it won't affect existing behavior until explicitly enabled.
