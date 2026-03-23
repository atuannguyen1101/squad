---
"@bradygaster/squad-sdk": minor
---

Add agent-to-agent handoff protocol for mid-task delegation

Implements Sprint 3, Item #7: Agent-to-Agent Handoff Protocol

New features:
- `HandoffManager` class for validating and tracking delegation chains
- `squad_handoff` MCP tool for agents to delegate sub-tasks to peers
- Circular delegation detection with configurable depth limits
- Full delegation chain tracking for debugging and observability
- OpenTelemetry integration for handoff operations

Breaking changes: None (extends existing hub-spoke model)

API additions:
- `HandoffManager` exported from `@bradygaster/squad-sdk/coordinator`
- `HandoffRequest`, `HandoffResult`, `HandoffChainNode`, `HandoffConfig` types
- `ToolRegistry` constructor now accepts optional `handoffManager` parameter (3rd arg)

Test coverage: 23 new tests, all passing
