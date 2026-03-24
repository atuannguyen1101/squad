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
- Prefer explicit type annotations over inference for public APIs
- Use `unknown` instead of `any` for truly unknown types

## Naming Conventions

- Use PascalCase for types, interfaces, and classes
- Use camelCase for variables, functions, and properties
- Use UPPER_SNAKE_CASE for constants
- Prefix interfaces with 'I' only when necessary to avoid conflicts

## Code Organization

- One export per file for large modules
- Group related functions into cohesive modules
- Use barrel exports (index.ts) sparingly
- Prefer named exports over default exports

## Error Handling

- Always throw Error instances (never strings or objects)
- Include actionable error messages
- Use custom error classes for domain-specific errors
- Log errors with sufficient context for debugging

## Testing

- Write unit tests for all exported functions
- Use descriptive test names that explain the scenario
- Mock external dependencies appropriately
- Aim for 80%+ code coverage on critical paths
