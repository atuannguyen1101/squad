/**
 * Tests for Coordinator built-in actor charter content
 *
 * Verifies the Coordinator's charter string includes:
 * - Expected role description (Work Router)
 * - JSON output format with implementer/reviewer/architect fields
 * - Boundaries (never writes code, always responds with JSON)
 */

import { describe, it, expect } from 'vitest';
import {
  getBuiltInActor,
} from '../packages/squad-sdk/src/agents/built-in-actors.js';

describe('Coordinator built-in actor charter', () => {
  const coord = getBuiltInActor('coordinator');

  it('should exist as a built-in actor', () => {
    expect(coord).toBeDefined();
  });

  it('has the Work Router role', () => {
    expect(coord!.role).toBe('Work Router');
  });

  it('charter describes the role as Work Router', () => {
    expect(coord!.charter).toContain('Work Router');
  });

  it('charter specifies JSON response format', () => {
    expect(coord!.charter).toContain('JSON');
    expect(coord!.charter).toContain('Response Format');
  });

  it('charter output includes implementer field', () => {
    expect(coord!.charter).toContain('"implementer"');
  });

  it('charter output includes reviewer field', () => {
    expect(coord!.charter).toContain('"reviewer"');
  });

  it('charter output includes architect field', () => {
    expect(coord!.charter).toContain('"architect"');
  });

  it('charter states coordinator never writes code', () => {
    expect(coord!.charter).toContain('I NEVER implement, review, or write code');
  });

  it('charter states only JSON responses', () => {
    expect(coord!.charter).toContain('ALWAYS respond with ONLY a JSON object');
  });

  it('charter references reading the routing table and roster', () => {
    expect(coord!.charter).toContain('routing.md');
    expect(coord!.charter).toContain('roster');
  });
});
