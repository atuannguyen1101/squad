---
title: React Component Standards
applyTo:
  - "**/*.tsx"
  - "**/components/**/*.ts"
---

# React Component Standards

When working with React components, follow these guidelines:

## Component Structure

- Use functional components with hooks (no class components)
- Keep components small and focused (single responsibility)
- Extract complex logic into custom hooks
- Use React.memo for expensive components

## Props

- Define props interfaces at the top of the file
- Use destructuring in function parameters
- Provide default values where appropriate
- Document complex prop types with JSDoc comments

## State Management

- Use useState for local component state
- Use useReducer for complex state logic
- Consider context for cross-component state
- Avoid prop drilling (max 2 levels)

## Performance

- Memoize expensive calculations with useMemo
- Use useCallback for event handlers passed to children
- Lazy load components that aren't immediately needed
- Profile before optimizing

## Styling

- Prefer CSS modules over inline styles
- Use semantic class names
- Follow BEM naming convention
- Avoid magic numbers (use CSS variables)
