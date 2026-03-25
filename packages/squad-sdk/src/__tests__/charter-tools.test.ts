/**
 * Tests for charter ## Tools section parsing.
 * 
 * Validates that parseCharterMarkdown correctly extracts:
 *   - allowed: tool1, tool2
 *   - excluded: tool1, tool2
 *   - Both allowed and excluded in same section
 *   - Whitespace trimming in tool names
 *   - undefined when no ## Tools section
 *   - Empty ## Tools section handling
 */

import { describe, it, expect } from 'vitest';
import { parseCharterMarkdown, compileCharterFull } from '../agents/charter-compiler.js';

describe('Charter ## Tools Section Parsing', () => {
  it('should parse "allowed: tool1, tool2" from ## Tools section', () => {
    const charter = `
# Test Agent

## Tools

allowed: squad_run, squad_ask, squad_status
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toEqual(['squad_run', 'squad_ask', 'squad_status']);
    expect(parsed.excludedTools).toBeUndefined();
  });

  it('should parse "excluded: squad_route, squad_send" from ## Tools section', () => {
    const charter = `
# Test Agent

## Tools

excluded: squad_route, squad_send
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.excludedTools).toEqual(['squad_route', 'squad_send']);
    expect(parsed.allowedTools).toBeUndefined();
  });

  it('should handle both allowed and excluded in same ## Tools section', () => {
    const charter = `
# Test Agent

## Tools

allowed: squad_run, squad_ask
excluded: squad_route, squad_send
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toEqual(['squad_run', 'squad_ask']);
    expect(parsed.excludedTools).toEqual(['squad_route', 'squad_send']);
  });

  it('should return undefined when no ## Tools section exists', () => {
    const charter = `
# Test Agent

## Identity

**Name:** Test Agent
**Role:** Tester
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toBeUndefined();
    expect(parsed.excludedTools).toBeUndefined();
  });

  it('should handle empty ## Tools section', () => {
    const charter = `
# Test Agent

## Tools

## Next Section
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toBeUndefined();
    expect(parsed.excludedTools).toBeUndefined();
  });

  it('should trim whitespace in tool names', () => {
    const charter = `
# Test Agent

## Tools

allowed:  squad_run  ,  squad_ask  ,  squad_status  
excluded:  squad_route  ,  squad_send  
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toEqual(['squad_run', 'squad_ask', 'squad_status']);
    expect(parsed.excludedTools).toEqual(['squad_route', 'squad_send']);
  });

  it('should filter out empty strings after splitting and trimming', () => {
    const charter = `
# Test Agent

## Tools

allowed: squad_run,,squad_ask,
excluded: squad_route,
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toEqual(['squad_run', 'squad_ask']);
    expect(parsed.excludedTools).toEqual(['squad_route']);
  });

  it('should be case-insensitive for "allowed" and "excluded" keywords', () => {
    const charter = `
# Test Agent

## Tools

ALLOWED: squad_run
Excluded: squad_send
`;
    const parsed = parseCharterMarkdown(charter);
    expect(parsed.allowedTools).toEqual(['squad_run']);
    expect(parsed.excludedTools).toEqual(['squad_send']);
  });
});

describe('CharterCompiler.compile() - Tools Integration', () => {
  it('should pass allowedTools through compilation when present in charter', () => {
    const charter = `
# Test Agent

## Identity

**Name:** Test Agent
**Role:** Tester

## Tools

allowed: squad_run, squad_ask
`;
    const compiled = compileCharterFull({
      agentName: 'test-agent',
      charterPath: '/test/charter.md',
      charterContent: charter,
    });

    expect(compiled.parsed.allowedTools).toEqual(['squad_run', 'squad_ask']);
  });

  it('should pass excludedTools through compilation when present in charter', () => {
    const charter = `
# Test Agent

## Identity

**Name:** Test Agent
**Role:** Tester

## Tools

excluded: squad_route, squad_send
`;
    const compiled = compileCharterFull({
      agentName: 'test-agent',
      charterPath: '/test/charter.md',
      charterContent: charter,
    });

    expect(compiled.parsed.excludedTools).toEqual(['squad_route', 'squad_send']);
  });

  it('should pass both allowedTools and excludedTools when both present', () => {
    const charter = `
# Test Agent

## Tools

allowed: squad_run
excluded: squad_route
`;
    const compiled = compileCharterFull({
      agentName: 'test-agent',
      charterPath: '/test/charter.md',
      charterContent: charter,
    });

    expect(compiled.parsed.allowedTools).toEqual(['squad_run']);
    expect(compiled.parsed.excludedTools).toEqual(['squad_route']);
  });

  it('should have undefined allowedTools/excludedTools when no ## Tools section', () => {
    const charter = `
# Test Agent

## Identity

**Name:** Test Agent
`;
    const compiled = compileCharterFull({
      agentName: 'test-agent',
      charterPath: '/test/charter.md',
      charterContent: charter,
    });

    expect(compiled.parsed.allowedTools).toBeUndefined();
    expect(compiled.parsed.excludedTools).toBeUndefined();
  });
});
