/**
 * Tests for Pulse Protocol enhancements
 * - Progress regression detection
 * - Auto-pulse safety net
 * - Message count threshold alerts
 * - Case-insensitive agent name matching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PulseCollector, createPulse, type Pulse } from '../pulse/pulse.js';

describe('PulseCollector - Progress Regression Detection', () => {
  let collector: PulseCollector;
  let regressionCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    collector = new PulseCollector();
    regressionCallback = vi.fn();
    collector.setOnProgressRegression(regressionCallback);
  });

  it('should detect backward progress movement', () => {
    const pulse1 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 80,
      summary: 'Making progress',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Continue',
    });

    const pulse2 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 30,
      summary: 'Regressed',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Fix',
    });

    collector.record(pulse1);
    collector.record(pulse2);

    expect(regressionCallback).toHaveBeenCalledWith('testagent', 80, 30);
  });

  it('should emit a warning pulse for regression', () => {
    const pulse1 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 100,
      summary: 'Done',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Verify',
    });

    const pulse2 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 30,
      summary: 'Regressed',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Fix',
    });

    collector.record(pulse1);
    collector.record(pulse2);

    const allPulses = collector.getAll();
    const warningPulse = allPulses.find(p => p.agent === 'System' && p.status === 'warning');
    
    expect(warningPulse).toBeDefined();
    expect(warningPulse?.summary).toContain('Progress regression detected');
    expect(warningPulse?.summary).toContain('100%');
    expect(warningPulse?.summary).toContain('30%');
  });

  it('should not trigger for small backward movements (<10%)', () => {
    const pulse1 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 50,
      summary: 'Progress',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Continue',
    });

    const pulse2 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 45,
      summary: 'Slight adjustment',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Continue',
    });

    collector.record(pulse1);
    collector.record(pulse2);

    expect(regressionCallback).not.toHaveBeenCalled();
  });
});

describe('PulseCollector - Message Count Tracking', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should track message count per agent', () => {
    collector.trackMessage('Agent1');
    collector.trackMessage('Agent1');
    collector.trackMessage('Agent2');
    
    expect(collector['messageCountsByAgent'].get('agent1')).toBe(2);
    expect(collector['messageCountsByAgent'].get('agent2')).toBe(1);
  });

  it('should emit warning when threshold exceeded', () => {
    // Track 25 messages
    for (let i = 0; i < 25; i++) {
      collector.trackMessage('BusyAgent');
    }

    const allPulses = collector.getAll();
    const warningPulse = allPulses.find(
      p => p.agent === 'System' && p.summary.includes('Message count threshold exceeded')
    );
    
    expect(warningPulse).toBeDefined();
    expect(warningPulse?.summary).toContain('BusyAgent');
    expect(warningPulse?.summary).toContain('25');
  });

  it('should only emit warning once per agent', () => {
    // Track 30 messages
    for (let i = 0; i < 30; i++) {
      collector.trackMessage('BusyAgent');
    }

    const allPulses = collector.getAll();
    const warningPulses = allPulses.filter(
      p => p.agent === 'System' && p.summary.includes('Message count threshold exceeded')
    );
    
    expect(warningPulses).toHaveLength(1);
  });
});

describe('PulseCollector - Case-Insensitive Agent Matching', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
  });

  it('should match agent names case-insensitively in getByAgent', () => {
    const pulse1 = createPulse({
      agent: 'TestAgent',
      phase: 'implementing',
      status: 'ok',
      progressPct: 50,
      summary: 'Working',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: 'Continue',
    });

    collector.record(pulse1);

    const pulses1 = collector.getByAgent('TestAgent');
    const pulses2 = collector.getByAgent('testagent');
    const pulses3 = collector.getByAgent('TESTAGENT');

    expect(pulses1).toHaveLength(1);
    expect(pulses2).toHaveLength(1);
    expect(pulses3).toHaveLength(1);
  });

  it('should match agent names case-insensitively in waitForDonePulse', async () => {
    const pulse = createPulse({
      agent: 'TestAgent',
      phase: 'done',
      status: 'ok',
      progressPct: 100,
      summary: 'Complete',
      blockers: [],
      questionsForUser: [],
      artifacts: [],
      nextStep: '',
    });

    collector.record(pulse);

    const result1 = await collector.waitForDonePulse('TestAgent', 100);
    const result2 = await collector.waitForDonePulse('testagent', 100);
    const result3 = await collector.waitForDonePulse('TESTAGENT', 100);

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result3).toBeDefined();
    expect(result1?.agent).toBe('testagent');
    expect(result2?.agent).toBe('testagent');
    expect(result3?.agent).toBe('testagent');
  });
});

describe('PulseCollector - Auto-Pulse Safety Net', () => {
  let collector: PulseCollector;

  beforeEach(() => {
    collector = new PulseCollector();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should generate auto-pulse if agent silent too long', async () => {
    const waitPromise = collector.waitForDonePulse('SilentAgent', 120000, 'done', 1000);

    // Fast-forward time to trigger auto-pulse
    await vi.advanceTimersByTimeAsync(1100);

    const allPulses = collector.getAll();
    const autoPulse = allPulses.find(
      p => p.agent === 'silentagent' && p.summary.includes('Still working')
    );

    expect(autoPulse).toBeDefined();
    expect(autoPulse?.summary).toContain('auto-generated');

    vi.clearAllTimers();
  });
});
