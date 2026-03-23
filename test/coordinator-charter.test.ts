/**
 * Tests for the coordinator built-in actor charter content
 */
import { describe, it, expect } from 'vitest';
import { getBuiltInActor } from '../packages/squad-sdk/src/agents/built-in-actors.js';

describe('Coordinator charter', () => {
  const coordinator = getBuiltInActor('coordinator');

  it('should return the coordinator actor', () => {
    expect(coordinator).not.toBeNull();
  });

  it('charter should contain Work Router', () => {
    expect(coordinator!.charter).toContain('Work Router');
  });

  it('charter should contain JSON', () => {
    expect(coordinator!.charter).toContain('JSON');
  });
});
