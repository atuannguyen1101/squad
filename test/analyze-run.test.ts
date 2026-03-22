/**
 * Tests for Run Analysis Engine — Sage's analytical core.
 *
 * Tests the pure analysis functions that power squad_analyze_run.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeRun,
  formatAnalysisReport,
  type RunAnalysisInput,
  type SessionSnapshot,
} from '../packages/squad-sdk/src/mcp/analyze-run.js';
import { createPulse } from '../packages/squad-sdk/src/pulse/pulse.js';
import type { Pulse } from '../packages/squad-sdk/src/pulse/pulse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePulse(overrides: Partial<Omit<Pulse, 'timestamp'>> = {}): Pulse {
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

function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    agentName: 'fenster',
    messageCount: 4,
    messages: [
      { role: 'user', content: 'Build the login page', timestamp: '2026-03-22T09:00:00Z' },
      { role: 'assistant', content: 'On it.', timestamp: '2026-03-22T09:00:05Z' },
      { role: 'user', content: 'Add tests too', timestamp: '2026-03-22T09:05:00Z' },
      { role: 'assistant', content: 'Done.', timestamp: '2026-03-22T09:10:00Z' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// analyzeRun — core analysis
// ---------------------------------------------------------------------------

describe('analyzeRun', () => {
  it('should produce a report from empty input', () => {
    const report = analyzeRun({ pulses: [], sessions: [] });

    expect(report.analyzedAt).toBeTruthy();
    expect(report.agents).toHaveLength(0);
    expect(report.proposals).toHaveLength(0);
    expect(report.metrics.totalAgents).toBe(0);
    expect(report.metrics.totalPulses).toBe(0);
    expect(report.metrics.totalMessages).toBe(0);
  });

  it('should summarize a clean run with one agent', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'starting', progressPct: 0 }),
      makePulse({ agent: 'fenster', phase: 'implementing', progressPct: 50 }),
      makePulse({ agent: 'fenster', phase: 'done', progressPct: 100 }),
    ];
    const sessions = [makeSession({ agentName: 'fenster' })];

    const report = analyzeRun({ pulses, sessions });

    expect(report.metrics.totalAgents).toBe(1);
    expect(report.metrics.totalPulses).toBe(3);
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]!.agentName).toBe('fenster');
    expect(report.agents[0]!.finalPhase).toBe('done');
    expect(report.agents[0]!.finalStatus).toBe('ok');
    expect(report.agents[0]!.progressArc).toEqual([0, 50, 100]);
    expect(report.agents[0]!.errorCount).toBe(0);
    expect(report.summary).toContain('All agents completed successfully');
  });

  it('should summarize a multi-agent run', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'done', progressPct: 100 }),
      makePulse({ agent: 'hockney', phase: 'done', progressPct: 100 }),
      makePulse({ agent: 'mcmanus', phase: 'implementing', progressPct: 60 }),
    ];
    const sessions = [
      makeSession({ agentName: 'fenster' }),
      makeSession({ agentName: 'hockney', messageCount: 6 }),
      makeSession({ agentName: 'mcmanus', messageCount: 2 }),
    ];

    const report = analyzeRun({ pulses, sessions });

    expect(report.metrics.totalAgents).toBe(3);
    expect(report.summary).toContain('2/3');
    expect(report.summary).toContain('mcmanus');
  });

  it('should detect routing issues — agent with messages but no pulses', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'done', progressPct: 100 }),
    ];
    const sessions = [
      makeSession({ agentName: 'fenster' }),
      makeSession({ agentName: 'ghost-agent', messageCount: 3 }),
    ];

    const report = analyzeRun({ pulses, sessions });

    const routingProposals = report.proposals.filter(p => p.category === 'routing');
    expect(routingProposals.length).toBeGreaterThanOrEqual(1);
    expect(routingProposals[0]!.title).toContain('ghost-agent');
    expect(routingProposals[0]!.targetFile).toBe('.squad/routing.md');
  });

  it('should detect repeated blockers', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'implementing', progressPct: 20, blockers: ['Missing API key'] }),
      makePulse({ agent: 'fenster', phase: 'implementing', progressPct: 20, blockers: ['Config not found'] }),
      makePulse({ agent: 'fenster', phase: 'done', progressPct: 100 }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    const charterProposals = report.proposals.filter(
      p => p.category === 'charter' && p.title.includes('blocked'),
    );
    expect(charterProposals.length).toBe(1);
    expect(charterProposals[0]!.priority).toBe('high');
    expect(charterProposals[0]!.evidence).toContain('Blocker: Missing API key');
  });

  it('should detect error patterns', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'implementing', status: 'error', summary: 'Build failed' }),
      makePulse({ agent: 'fenster', phase: 'implementing', status: 'error', summary: 'Build failed again' }),
      makePulse({ agent: 'fenster', phase: 'implementing', status: 'error', summary: 'Still broken' }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    const errorProposals = report.proposals.filter(
      p => p.category === 'charter' && p.title.includes('error'),
    );
    expect(errorProposals.length).toBe(1);
    expect(errorProposals[0]!.priority).toBe('high');
    expect(errorProposals[0]!.evidence).toHaveLength(3);
    expect(report.metrics.errorRate).toBeCloseTo(1.0);
  });

  it('should detect progress stalls', () => {
    const pulses = [
      makePulse({ agent: 'fenster', progressPct: 25 }),
      makePulse({ agent: 'fenster', progressPct: 25 }),
      makePulse({ agent: 'fenster', progressPct: 25 }),
      makePulse({ agent: 'fenster', progressPct: 50 }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    const stallProposals = report.proposals.filter(
      p => p.category === 'sdk-config' && p.title.includes('stalled'),
    );
    expect(stallProposals.length).toBe(1);
    expect(stallProposals[0]!.targetFile).toBe('squad.config.ts');
  });

  it('should detect long sessions', () => {
    const manyMessages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      timestamp: `2026-03-22T09:${String(i).padStart(2, '0')}:00Z`,
    }));
    const sessions = [
      makeSession({ agentName: 'chatty', messageCount: 25, messages: manyMessages }),
    ];

    const report = analyzeRun({ pulses: [], sessions });

    const longProposals = report.proposals.filter(
      p => p.title.includes('long session'),
    );
    expect(longProposals.length).toBe(1);
    expect(longProposals[0]!.category).toBe('routing');
  });

  it('should sort proposals by priority (high first)', () => {
    const pulses = [
      // Error pattern → high priority
      makePulse({ agent: 'fenster', status: 'error', summary: 'fail1' }),
      makePulse({ agent: 'fenster', status: 'error', summary: 'fail2' }),
      makePulse({ agent: 'fenster', status: 'error', summary: 'fail3' }),
      // Blocker pattern → high priority
      makePulse({ agent: 'hockney', blockers: ['b1'] }),
      makePulse({ agent: 'hockney', blockers: ['b2'] }),
      // Stall pattern → low priority
      makePulse({ agent: 'keaton', progressPct: 10 }),
      makePulse({ agent: 'keaton', progressPct: 10 }),
      makePulse({ agent: 'keaton', progressPct: 10 }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.proposals.length).toBeGreaterThanOrEqual(3);
    // High-priority proposals should come first
    const priorities = report.proposals.map(p => p.priority);
    const highIdx = priorities.indexOf('high');
    const lowIdx = priorities.indexOf('low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('should compute duration estimate from pulse timestamps', () => {
    const t0 = new Date('2026-03-22T09:00:00Z');
    const t1 = new Date('2026-03-22T09:05:00Z');
    const pulses = [
      { ...makePulse({ progressPct: 0 }), timestamp: t0.toISOString() },
      { ...makePulse({ progressPct: 100 }), timestamp: t1.toISOString() },
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.metrics.durationEstimate).toBe('5m');
  });

  it('should include error and blocker agents in summary', () => {
    const pulses = [
      makePulse({ agent: 'fenster', status: 'error', summary: 'failed' }),
      makePulse({ agent: 'hockney', blockers: ['stuck'] }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.summary).toContain('Errors reported by');
    expect(report.summary).toContain('fenster');
    expect(report.summary).toContain('Blockers reported by');
    expect(report.summary).toContain('hockney');
  });
});

// ---------------------------------------------------------------------------
// formatAnalysisReport — text rendering
// ---------------------------------------------------------------------------

describe('formatAnalysisReport', () => {
  it('should format an empty report', () => {
    const report = analyzeRun({ pulses: [], sessions: [] });
    const text = formatAnalysisReport(report);

    expect(text).toContain('# Run Analysis Report');
    expect(text).toContain('## Summary');
    expect(text).toContain('## Metrics');
    expect(text).toContain('No issues detected');
  });

  it('should include agent breakdown with status icons', () => {
    const pulses = [
      makePulse({ agent: 'fenster', phase: 'done', status: 'ok', progressPct: 100 }),
      makePulse({ agent: 'hockney', phase: 'implementing', status: 'error', progressPct: 30 }),
    ];
    const sessions = [
      makeSession({ agentName: 'fenster' }),
      makeSession({ agentName: 'hockney', messageCount: 2 }),
    ];

    const text = formatAnalysisReport(analyzeRun({ pulses, sessions }));

    expect(text).toContain('✅ fenster');
    expect(text).toContain('❌ hockney');
  });

  it('should include proposal details with priority labels', () => {
    const pulses = [
      makePulse({ agent: 'fenster', status: 'error', summary: 'Build crashed' }),
    ];

    const text = formatAnalysisReport(analyzeRun({ pulses, sessions: [] }));

    expect(text).toContain('## Improvement Proposals');
    expect(text).toContain('**Category:** charter');
    expect(text).toContain('**Target:**');
    expect(text).toContain('**Evidence:**');
  });

  it('should format metrics section with rates', () => {
    const pulses = [
      makePulse({ status: 'error' }),
      makePulse({ status: 'ok' }),
    ];

    const text = formatAnalysisReport(analyzeRun({ pulses, sessions: [] }));

    expect(text).toContain('Error rate: 50.0%');
    expect(text).toContain('Pulses: 2');
  });

  it('should render progress arcs', () => {
    const pulses = [
      makePulse({ progressPct: 0 }),
      makePulse({ progressPct: 50 }),
      makePulse({ progressPct: 100 }),
    ];

    const text = formatAnalysisReport(analyzeRun({ pulses, sessions: [] }));

    expect(text).toContain('0 → 50 → 100%');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('analyzeRun edge cases', () => {
  it('should handle agents present only in sessions (no pulses)', () => {
    const sessions = [makeSession({ agentName: 'silent-agent', messageCount: 5 })];

    const report = analyzeRun({ pulses: [], sessions });

    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]!.agentName).toBe('silent-agent');
    expect(report.agents[0]!.finalPhase).toBe('unknown');
    expect(report.agents[0]!.messageCount).toBe(5);
  });

  it('should handle agents present only in pulses (no sessions)', () => {
    const pulses = [makePulse({ agent: 'pulse-only', phase: 'done', progressPct: 100 })];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]!.messageCount).toBe(0);
  });

  it('should handle a run with only stalls and no errors', () => {
    const pulses = [
      makePulse({ agent: 'slow', progressPct: 10 }),
      makePulse({ agent: 'slow', progressPct: 10 }),
      makePulse({ agent: 'slow', progressPct: 10 }),
      makePulse({ agent: 'slow', progressPct: 10 }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.metrics.errorRate).toBe(0);
    expect(report.proposals.some(p => p.title.includes('stalled'))).toBe(true);
  });

  it('should not flag a single blocker as a pattern', () => {
    const pulses = [
      makePulse({ agent: 'fenster', blockers: ['one-time issue'] }),
      makePulse({ agent: 'fenster', phase: 'done', progressPct: 100 }),
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    // A single blocker should NOT trigger the repeated-blocker proposal
    const blockerProposals = report.proposals.filter(
      p => p.category === 'charter' && p.title.includes('blocked'),
    );
    expect(blockerProposals).toHaveLength(0);
  });

  it('should handle unknown duration with < 2 pulses', () => {
    const pulses = [makePulse()];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.metrics.durationEstimate).toBe('unknown');
  });

  it('should report duration in seconds for short runs', () => {
    const t0 = new Date('2026-03-22T09:00:00Z');
    const t1 = new Date('2026-03-22T09:00:30Z');
    const pulses = [
      { ...makePulse({ progressPct: 0 }), timestamp: t0.toISOString() },
      { ...makePulse({ progressPct: 100 }), timestamp: t1.toISOString() },
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.metrics.durationEstimate).toBe('30s');
  });

  it('should report duration in hours for long runs', () => {
    const t0 = new Date('2026-03-22T09:00:00Z');
    const t1 = new Date('2026-03-22T11:30:00Z');
    const pulses = [
      { ...makePulse({ progressPct: 0 }), timestamp: t0.toISOString() },
      { ...makePulse({ progressPct: 100 }), timestamp: t1.toISOString() },
    ];

    const report = analyzeRun({ pulses, sessions: [] });

    expect(report.metrics.durationEstimate).toBe('2.5h');
  });
});
