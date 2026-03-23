# Intent Graph Visibility for Agents

**Sprint 3, Item #14**

## Overview

Provides spawned agents with a summarized view of the overall intent graph, so they can see their specific assignment, how it fits into the bigger picture, and relevant constraints/acceptance criteria.

## Architecture

```
IntentGraph (core)
    ↓
IntentSummarizer (extract agent-relevant info)
    ↓
buildSystemPrompt() (inject into system prompt)
    ↓
Agent spawns with full context
```

## Core Components

### 1. `IntentGraph` (`intent/IntentGraph.ts`)

Tracks goals, constraints, acceptance criteria, and task assignments:

```typescript
const graph = new IntentGraph();

graph.addNode({
  id: 'goal-1',
  type: 'goal',
  description: 'Migrate Products blade to React',
  status: 'in_progress',
});

graph.addNode({
  id: 'task-ui',
  type: 'task',
  description: 'Implement React UI components',
  status: 'in_progress',
  assignedTo: 'fenster',
});

graph.addEdge({ from: 'task-data', to: 'task-ui', type: 'enables' });
```

**Node types:**
- `goal` — high-level objective
- `constraint` — rule that must be followed
- `acceptance_criterion` — success criteria
- `task` — specific work item

**Edge types:**
- `depends_on` — task A depends on task B completing
- `blocks` — task A blocks task B
- `enables` — task A enables task B to proceed
- `part_of` — hierarchical relationship

### 2. `IntentSummarizer` (`intent/IntentSummarizer.ts`)

Produces focused markdown summaries for specific agents:

```typescript
const summary = IntentSummarizer.summarizeForAgent(graph, 'fenster');
// Returns: {
//   overallGoal: "Migrate Products blade to React",
//   agentAssignment: { taskId: "task-ui", description: "...", status: "..." },
//   relevantConstraints: ["Keep files under 200 lines"],
//   relevantAcceptanceCriteria: ["All existing tests must pass"],
//   contextInPipeline: "This task depends on: Create data layer hooks"
// }

const markdown = IntentSummarizer.toMarkdown(summary);
```

**Output format:**
```markdown
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

- All existing tests must pass
```

### 3. `buildSystemPrompt()` (`agents/agent-lifecycle.ts`)

Wires intent context into agent system prompts:

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

## Usage

### Opt-in via Config

```typescript
const config: SquadConfig = {
  includeIntentContext: true,
};

const prompt = createSystemPromptWithConfig(
  {
    agentName: 'fenster',
    role: 'UI Developer',
    intentGraph: graph,
  },
  config
);
```

### Building an Intent Graph

```typescript
const graph = new IntentGraph();

// 1. Add root goal
graph.addNode({
  id: 'goal-1',
  type: 'goal',
  description: 'Migrate feature X',
  status: 'in_progress',
});
graph.setRootGoal('goal-1');

// 2. Add constraints
graph.addNode({
  id: 'constraint-1',
  type: 'constraint',
  description: 'No breaking changes',
  status: 'pending',
});

// 3. Add acceptance criteria
graph.addNode({
  id: 'ac-1',
  type: 'acceptance_criterion',
  description: 'E2E tests pass',
  status: 'pending',
});

// 4. Add tasks and assign them
graph.addNode({
  id: 'task-1',
  type: 'task',
  description: 'Data layer',
  status: 'in_progress',
  assignedTo: 'mcmanus',
});

graph.addNode({
  id: 'task-2',
  type: 'task',
  description: 'UI layer',
  status: 'pending',
  assignedTo: 'fenster',
});

// 5. Define dependencies
graph.addEdge({ from: 'task-1', to: 'task-2', type: 'enables' });

// 6. Update status as work progresses
graph.updateNode('task-1', { status: 'completed' });
```

### Integration with Pipeline Phases

```typescript
// At task assignment phase:
graph.addNode({
  id: `task-${agentName}`,
  type: 'task',
  description: taskDescription,
  status: 'in_progress',
  assignedTo: agentName,
});

// When spawning the agent:
const prompt = buildSystemPrompt({
  agentName,
  role: agent.role,
  charter: agent.charter,
  intentGraph: graph,
  includeIntentContext: config.includeIntentContext,
});

// At completion:
graph.updateNode(`task-${agentName}`, { status: 'completed' });
```

## Constraints

- **Concise summaries:** Agents have limited context windows. Summaries focus on what's directly relevant.
- **File size:** All files kept under 200 lines (IntentGraph: 100, IntentSummarizer: 138, agent-lifecycle: 69).
- **Opt-in:** Feature is disabled by default to preserve existing behavior.
- **No side effects:** Summarizer is pure — doesn't modify the graph.

## Testing

```bash
npm test -- IntentGraph
npm test -- IntentSummarizer
npm test -- agent-lifecycle
```

All core functionality is tested:
- Node/edge operations
- Filtering by type/agent
- Root goal detection
- Serialization/deserialization
- Summary generation
- Markdown rendering
- System prompt building

## Example: Full Pipeline Flow

```typescript
// 1. Coordinator builds intent graph from PRD
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

// 3. Assign tasks to agents
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

// 5. After data layer completes, spawn Fenster
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

## Boundaries

**This module handles:**
- Intent graph data structure
- Agent-specific summarization
- System prompt injection

**This module does NOT handle:**
- MCP tool integration (fenster's zone)
- Routing/dispatch logic (eecom's zone)
- PRD parsing (separate concern)

## Future Enhancements

- **Filtering:** Show only constraints/criteria relevant to specific task types
- **Progress tracking:** Visual indicators of what's blocked vs ready
- **Dynamic updates:** Push graph updates to active agents
- **Persistence:** Save/restore intent graphs across sessions
