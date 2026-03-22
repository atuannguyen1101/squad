/**
 * Tests for built-in actors — SDK-level agents available in every workspace
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ACTORS,
  isBuiltInActor,
  getBuiltInActor,
  getBuiltInActorNames,
} from '../packages/squad-sdk/src/agents/built-in-actors.js';

describe('Built-in Actors', () => {
  it('should include ben, coordinator, and sage', () => {
    const names = getBuiltInActorNames();
    expect(names).toContain('ben');
    expect(names).toContain('coordinator');
    expect(names).toContain('sage');
  });

  it('should identify built-in actors by name', () => {
    expect(isBuiltInActor('ben')).toBe(true);
    expect(isBuiltInActor('coordinator')).toBe(true);
    expect(isBuiltInActor('sage')).toBe(true);
    expect(isBuiltInActor('fenster')).toBe(false);
    expect(isBuiltInActor('random')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isBuiltInActor('Ben')).toBe(true);
    expect(isBuiltInActor('COORDINATOR')).toBe(true);
    expect(isBuiltInActor('SAGE')).toBe(true);
  });

  it('should return ben with correct structure', () => {
    const ben = getBuiltInActor('ben');
    expect(ben).toBeDefined();
    expect(ben!.name).toBe('ben');
    expect(ben!.role).toBe('User Liaison');
    expect(ben!.charter).toContain('User Liaison');
    expect(ben!.charter).toContain('Intent Graph');
    expect(ben!.expertise).toContain('Intent clarification');
  });

  it('should return sage with correct structure', () => {
    const sage = getBuiltInActor('sage');
    expect(sage).toBeDefined();
    expect(sage!.name).toBe('sage');
    expect(sage!.role).toBe('Self-Improvement Analyst');
    expect(sage!.charter).toContain('Self-Improvement');
    expect(sage!.charter).toContain('improvement proposals');
    expect(sage!.expertise).toContain('Run analysis');
  });

  it('should return undefined for unknown actors', () => {
    expect(getBuiltInActor('unknown')).toBeUndefined();
  });

  it('coordinator charter should return JSON format', () => {
    const coord = getBuiltInActor('coordinator');
    expect(coord).toBeDefined();
    expect(coord!.name).toBe('coordinator');
    expect(coord!.role).toBe('Work Router');
    expect(coord!.charter).toContain('implementer');
    expect(coord!.charter).toContain('reviewer');
    expect(coord!.charter).toContain('JSON');
  });

  it('sage charter should cover all 5 analysis scopes', () => {
    const sage = getBuiltInActor('sage');
    expect(sage!.charter).toContain('SDK config');
    expect(sage!.charter).toContain('Squad definitions');
    expect(sage!.charter).toContain('Agentic setup');
    expect(sage!.charter).toContain('MCP setup');
    expect(sage!.charter).toContain('Run efficiency');
  });

  it('ben charter should not contain code implementation responsibilities', () => {
    const ben = getBuiltInActor('ben');
    expect(ben!.charter).toContain('I never write code');
  });

  it('sage charter should require human approval', () => {
    const sage = getBuiltInActor('sage');
    expect(sage!.charter).toContain('human approval');
  });
});
