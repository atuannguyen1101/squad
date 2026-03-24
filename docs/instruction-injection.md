# Instruction Injection System

The Squad SDK now automatically injects relevant project instructions and skills into agent system prompts based on the files they're working on.

## Overview

When an agent is spawned and given file paths to work on, the SDK:

1. Discovers all instruction files in `.github/instructions/`
2. Discovers all skill files in `.squad/skills/`
3. Matches them against the file paths using glob patterns from frontmatter
4. Injects matching instructions into the agent's system prompt

This ensures agents **read and follow** project conventions automatically, rather than relying on them to discover instructions manually.

## Instruction File Format

Instruction files use YAML frontmatter to declare which files they apply to:

```markdown
---
title: TypeScript Code Standards
applyTo:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Code Standards

All TypeScript code must follow these standards:

## Type Safety
- Use `strict: true` in tsconfig.json
- Never use `any` type unless absolutely necessary
...
```

## Skill File Format

Skills in `.squad/skills/{name}/SKILL.md` can also use the same frontmatter format:

```markdown
---
title: Testing Best Practices
applyTo:
  - "**/*.test.ts"
  - "**/__tests__/**/*.ts"
---

# Testing Best Practices

When writing tests:
- Use descriptive test names
- Follow Arrange-Act-Assert pattern
...
```

## Pattern Matching

The `applyTo` field accepts glob patterns using [minimatch](https://github.com/isaacs/minimatch) syntax:

- `**/*.ts` - All TypeScript files
- `src/**/*.tsx` - All TSX files in src directory
- `**/components/**/*` - All files in any components directory
- `packages/*/src/*.ts` - TypeScript files in package src directories

## SDK API

### AgentSessionManager

The `AgentSessionManager` class provides methods to set working file paths:

```typescript
import { AgentSessionManager } from '@bradygaster/squad-sdk/server';

const manager = new AgentSessionManager(config);

// Set file paths for an agent
manager.setWorkingFilePaths('fenster', [
  'src/components/Button.tsx',
  'src/utils/helpers.ts'
]);

// Get current file paths
const paths = manager.getWorkingFilePaths('fenster');
```

When the agent's session is created, the system prompt will automatically include:

1. TypeScript instructions (matches `**/*.ts` and `**/*.tsx`)
2. React component instructions (matches `**/*.tsx`)
3. Any relevant skills (if they have matching `applyTo` patterns)

## Integration with Orchestration

The SDK orchestration layer should track which files are being modified during a task and call `setWorkingFilePaths()` before dispatching work to agents.

Example integration:

```typescript
// Track modified files during planning phase
const modifiedFiles = await detectModifiedFiles(task);

// Set file paths before dispatch
manager.setWorkingFilePaths(agentName, modifiedFiles);

// Dispatch work - agent now has relevant instructions
await manager.dispatch(agentName, taskMessage);
```

## Benefits

1. **Enforcement**: Agents must read instructions - they're in the system prompt
2. **Context-aware**: Only relevant instructions are injected (not everything)
3. **Automatic**: No manual "read the instructions" prompts needed
4. **Scalable**: Add new instructions without modifying charters

## Example Use Cases

### Code Standards

```markdown
---
title: API Route Standards
applyTo:
  - "**/api/**/*.ts"
  - "**/routes/**/*.ts"
---

All API routes must:
- Use async/await (no callbacks)
- Include error handling
- Validate input parameters
- Return typed responses
```

### Testing Requirements

```markdown
---
title: Component Testing
applyTo:
  - "**/*.test.tsx"
  - "**/components/**/*.tsx"
---

Component tests must:
- Test user interactions
- Check accessibility
- Verify error states
- Use Testing Library queries
```

### Security Guidelines

```markdown
---
title: Authentication
applyTo:
  - "**/auth/**/*.ts"
  - "**/middleware/**/*.ts"
---

Security requirements:
- Never log sensitive data
- Use bcrypt for password hashing
- Implement rate limiting
- Validate JWT tokens properly
```

## Testing

Run the instruction injection tests:

```bash
npm test -- instruction-injector
```

Tests cover:
- Discovery of instructions and skills
- Frontmatter parsing
- Pattern matching
- Section building
- Full injection pipeline
