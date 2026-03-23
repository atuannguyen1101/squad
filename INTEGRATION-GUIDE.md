# Quick Integration Guide: Intent Graph for Coordinators

## 1. Import the SDK

```typescript
import {
  IntentGraph,
  IntentSummarizer,
  buildSystemPrompt,
  type IntentNode,
  type SquadConfig,
} from '@bradygaster/squad-sdk';
```

## 2. Initialize Graph at Sprint Start

```typescript
function createIntentGraphFromPRD(prd: PRD): IntentGraph {
  const graph = new IntentGraph();
  
  // Add root goal
  const goalId = 'goal-' + Date.now();
  graph.addNode({
    id: goalId,
    type: 'goal',
    description: prd.objective,
    status: 'in_progress',
  });
  graph.setRootGoal(goalId);
  
  // Add constraints
  prd.constraints?.forEach((constraint, idx) => {
    graph.addNode({
      id: `constraint-${idx}`,
      type: 'constraint',
      description: constraint,
      status: 'pending',
    });
  });
  
  // Add acceptance criteria
  prd.acceptanceCriteria?.forEach((ac, idx) => {
    graph.addNode({
      id: `ac-${idx}`,
      type: 'acceptance_criterion',
      description: ac,
      status: 'pending',
    });
  });
  
  return graph;
}
```

## 3. Add Task Assignments

```typescript
function assignTask(
  graph: IntentGraph,
  agentName: string,
  taskDescription: string,
  dependencies?: string[]
): string {
  const taskId = `task-${agentName}-${Date.now()}`;
  
  graph.addNode({
    id: taskId,
    type: 'task',
    description: taskDescription,
    status: 'in_progress',
    assignedTo: agentName,
  });
  
  // Add dependency edges if provided
  dependencies?.forEach((depTaskId) => {
    graph.addEdge({
      from: depTaskId,
      to: taskId,
      type: 'enables',
    });
  });
  
  return taskId;
}
```

## 4. Spawn Agent with Intent Context

```typescript
async function spawnAgentWithIntent(
  agentName: string,
  charter: string,
  intentGraph: IntentGraph,
  config: SquadConfig
): Promise<void> {
  const systemPrompt = buildSystemPrompt({
    agentName,
    role: getAgentRole(agentName),
    charter,
    intentGraph,
    includeIntentContext: config.includeIntentContext ?? false,
  });
  
  // Use your existing agent spawn mechanism with systemPrompt
  await spawnAgent({
    name: agentName,
    systemPrompt,
    // ... other spawn options
  });
}
```

## 5. Update Status After Completion

```typescript
function markTaskComplete(graph: IntentGraph, taskId: string): void {
  graph.updateNode(taskId, { status: 'completed' });
}

function markTaskBlocked(
  graph: IntentGraph,
  taskId: string,
  reason: string
): void {
  graph.updateNode(taskId, {
    status: 'blocked',
    metadata: { blockReason: reason },
  });
}
```

## Complete Example: Two-Phase Migration

```typescript
// Phase 1: Data layer
const graph = createIntentGraphFromPRD(prd);

const dataTaskId = assignTask(
  graph,
  'mcmanus',
  'Create data layer: contracts, URIs, requests'
);

await spawnAgentWithIntent('mcmanus', mcmanusCharter, graph, config);
await waitForCompletion('mcmanus');
markTaskComplete(graph, dataTaskId);

// Phase 2: UI layer (depends on data)
const uiTaskId = assignTask(
  graph,
  'fenster',
  'Create UI layer: hooks, view, components',
  [dataTaskId]  // depends on data layer
);

await spawnAgentWithIntent('fenster', fensterCharter, graph, config);
await waitForCompletion('fenster');
markTaskComplete(graph, uiTaskId);
```

## 6. Enable in Config

```typescript
// In squad config (e.g., .squad/config.json or coordinator config)
const config: SquadConfig = {
  includeIntentContext: true,  // Enable intent graph visibility
  // ... other config options
};
```

## Serialization for Persistence

```typescript
// Save to file/cache
const data = graph.serialize();
await fs.writeFile('.squad/intent-graph.json', JSON.stringify(data, null, 2));

// Restore later
const data = JSON.parse(await fs.readFile('.squad/intent-graph.json', 'utf-8'));
const graph = new IntentGraph(data);
```

## Preview Intent Summary (for debugging)

```typescript
function previewAgentIntent(graph: IntentGraph, agentName: string): void {
  const summary = IntentSummarizer.summarizeForAgent(graph, agentName);
  const markdown = IntentSummarizer.toMarkdown(summary);
  console.log(`\n=== Intent Summary for ${agentName} ===`);
  console.log(markdown);
  console.log('=====================================\n');
}
```

## Minimal Integration (Start Here)

If you want to test it with minimal changes:

```typescript
// 1. Create a graph at the start of your existing flow
const graph = new IntentGraph();
graph.addNode({
  id: 'goal-1',
  type: 'goal',
  description: 'Your current goal',
  status: 'in_progress',
});
graph.setRootGoal('goal-1');

// 2. When spawning an agent, just add these two lines:
const intentGraph = graph;  // pass the graph
const includeIntentContext = true;  // enable the feature

// 3. Use buildSystemPrompt instead of your current prompt builder:
const prompt = buildSystemPrompt({
  agentName: 'your-agent',
  role: 'their-role',
  charter: existingCharter,
  intentGraph,
  includeIntentContext,
});

// 4. Spawn with the new prompt
await yourExistingSpawnMechanism(prompt);
```

That's it! The agent will now see the intent context in their system prompt.

## Rollback / Disable

To disable globally:

```typescript
const config: SquadConfig = {
  includeIntentContext: false,  // or just omit it
};
```

To disable for specific agents:

```typescript
const prompt = buildSystemPrompt({
  agentName: 'fenster',
  role: 'UI Developer',
  charter: fensterCharter,
  intentGraph: graph,
  includeIntentContext: false,  // override for this agent
});
```

## Questions?

See the full documentation: `packages/squad-sdk/src/intent/README.md`
