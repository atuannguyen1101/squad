/**
 * Tests for Pulse Protocol — structured agent status updates
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPulse,
  filterPulseForUser,
  formatPulseForUser,
  PulseCollector,
} from '../packages/squad-sdk/src/pulse/pulse.js';
import type { Pulse } from '../packages/squad-sdk/src/pulse/pulse.js';

function makePulse(overrides: Partial<Pulse> = {}): Pulse {
  return createPulse({
    agent: 'fenster',
    phase: 'implementing',
    status: 'ok',
    progressPct: 50,
    summary: 'Working on feature',
    blockers: [],
    questionsForUser: [],
    artifacts: [],
    nextStep: 'Write tests',
    ...overrides,
  });
}

describe('Pulse Protocol', () => {
  describe('createPulse', () => {
    it('should create a pulse with a timestamp', () => {
      const pulse = makePulse();

      expect(pulse.agent).toBe('fenster');
      expect(pulse.phase).toBe('implementing');
      expect(pulse.timestamp).toBeTruthy();
      expect(new Date(pulse.timestamp).getTime()).not.toBeNaN();
    });
  });

  describe('filterPulseForUser', () => {
    it('should flag pulses with user questions as relevant', () => {
      const pulse = makePulse({ questionsForUser: ['Which database?'] });
      const filter = filterPulseForUser(pulse);

      expect(filter.userRelevant).toBe(true);
      expect(filter.reason).toContain('questions');
    });

    it('should flag error pulses as relevant', () => {
      const pulse = makePulse({ status: 'error' });
      const filter = filterPulseForUser(pulse);

      expect(filter.userRelevant).toBe(true);
      expect(filter.reason).toContain('error');
    });

    it('should flag blocked pulses as relevant', () => {
      const pulse = makePulse({ blockers: ['Missing API key'] });
      const filter = filterPulseForUser(pulse);

      expect(filter.userRelevant).toBe(true);
      expect(filter.reason).toContain('blocked');
    });

    it('should flag done pulses as relevant', () => {
      const pulse = makePulse({ phase: 'done' });
      const filter = filterPulseForUser(pulse);

      expect(filter.userRelevant).toBe(true);
      expect(filter.reason).toContain('completed');
    });

    it('should not flag internal progress updates', () => {
      const pulse = makePulse();
      const filter = filterPulseForUser(pulse);

      expect(filter.userRelevant).toBe(false);
      expect(filter.reason).toContain('internal');
    });
  });

  describe('formatPulseForUser', () => {
    it('should format a basic pulse', () => {
      const pulse = makePulse();
      const formatted = formatPulseForUser(pulse);

      expect(formatted).toContain('[fenster]');
      expect(formatted).toContain('implementing');
      expect(formatted).toContain('50%');
    });

    it('should include blockers and questions', () => {
      const pulse = makePulse({
        blockers: ['Missing config'],
        questionsForUser: ['Which env?'],
        artifacts: ['src/api.ts'],
      });
      const formatted = formatPulseForUser(pulse);

      expect(formatted).toContain('Missing config');
      expect(formatted).toContain('Which env?');
      expect(formatted).toContain('src/api.ts');
    });
  });

  describe('PulseCollector', () => {
    let collector: PulseCollector;

    beforeEach(() => {
      collector = new PulseCollector();
    });

    it('should record pulses and track all', () => {
      collector.record(makePulse());
      collector.record(makePulse({ agent: 'hockney' }));

      expect(collector.getAll()).toHaveLength(2);
    });

    it('should queue user-relevant pulses', () => {
      collector.record(makePulse());
      collector.record(makePulse({ questionsForUser: ['Which DB?'] }));

      expect(collector.hasUserRelevantPulses()).toBe(true);
      const queued = collector.drainUserQueue();
      expect(queued).toHaveLength(1);
      expect(queued[0].questionsForUser).toContain('Which DB?');
    });

    it('should drain the user queue on read', () => {
      collector.record(makePulse({ phase: 'done' }));

      expect(collector.drainUserQueue()).toHaveLength(1);
      expect(collector.drainUserQueue()).toHaveLength(0);
    });

    it('should get latest pulse per agent', () => {
      collector.record(makePulse({ agent: 'fenster', progressPct: 25 }));
      collector.record(makePulse({ agent: 'hockney', progressPct: 10 }));
      collector.record(makePulse({ agent: 'fenster', progressPct: 75 }));

      const latest = collector.getLatestByAgent();
      expect(latest.get('fenster')?.progressPct).toBe(75);
      expect(latest.get('hockney')?.progressPct).toBe(10);
    });

    it('should filter by agent', () => {
      collector.record(makePulse({ agent: 'fenster' }));
      collector.record(makePulse({ agent: 'hockney' }));
      collector.record(makePulse({ agent: 'fenster' }));

      expect(collector.getByAgent('fenster')).toHaveLength(2);
      expect(collector.getByAgent('hockney')).toHaveLength(1);
    });

    it('should clear all state', () => {
      collector.record(makePulse({ phase: 'done' }));
      collector.clear();

      expect(collector.getAll()).toHaveLength(0);
      expect(collector.hasUserRelevantPulses()).toBe(false);
    });
  });
});
