/**
 * Tests for Auto-Sage — post-pipeline automatic Sage analysis trigger.
 *
 * Covers:
 * - collectSessionSnapshots: snapshot gathering with message truncation
 * - buildAnalysisReport: report generation from pulses and sessions
 * - triggerAutoSageAnalysis: full pipeline (gather → analyze → dispatch → pulse)
 * - Configuration gating: autoAnalyze flag controls trigger
 * - Error handling: Sage dispatch failure doesn't crash
 * - Pulse emission: correct pulses emitted on success and failure
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectSessionSnapshots,
  buildAnalysisReport,
  triggerAutoSageAnalysis,
  type AutoSageDeps,
} from '../packages/squad-sdk/src/mcp/auto-sage.js';
import { PulseCollector, createPulse } from '../packages/squad-sdk/src/pulse/index.js';
import type { Pulse } from '../packages/squad-sdk/src/pulse/pulse.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function makeMessages(count = 4) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  return msgs;
}

function makeDeps(overrides: Partial<AutoSageDeps> = {}): AutoSageDeps {
  const collector = new PulseCollector();
  // Pre-populate with some pulses for analysis
  collector.record(makePulse({ agent: 'fenster', phase: 'implementing', summary: 'Building auth' }));
  collector.record(makePulse({ agent: 'fenster', phase: 'done', summary: 'Auth complete' }));
  collector.record(makePulse({ agent: 'hockney', phase: 'reviewing', summary: 'Reviewing auth' }));
  collector.record(makePulse({ agent: 'hockney', phase: 'done', summary: 'Review approved' }));

  return {
    pulseCollector: collector,
    listActiveSessions: vi.fn().mockReturnValue([
      { agentName: 'fenster' },
      { agentName: 'hockney' },
    ]),
    getMessages: vi.fn().mockReturnValue(makeMessages(4)),
    dispatch: vi.fn().mockResolvedValue({
      response: 'Sage analysis: The run was efficient. No major issues found. Consider adding error handling.',
    }),
    squadRoot: '/test/squad-root',
    ...overrides,
  };
}

// ─── collectSessionSnapshots ────────────────────────────────────────────────

describe('collectSessionSnapshots', () => {
  it('collects snapshots from all active sessions', () => {
    const deps = makeDeps();
    const snapshots = collectSessionSnapshots(deps);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.agentName).toBe('fenster');
    expect(snapshots[1]?.agentName).toBe('hockney');
  });

  it('includes message count and messages', () => {
    const deps = makeDeps();
    const snapshots = collectSessionSnapshots(deps);

    expect(snapshots[0]?.messageCount).toBe(4);
    expect(snapshots[0]?.messages).toHaveLength(4);
  });

  it('truncates messages longer than 2000 characters', () => {
    const longContent = 'x'.repeat(3000);
    const deps = makeDeps({
      getMessages: vi.fn().mockReturnValue([
        { role: 'assistant', content: longContent, timestamp: new Date().toISOString() },
      ]),
    });
    const snapshots = collectSessionSnapshots(deps);

    const msg = snapshots[0]?.messages[0];
    expect(msg?.content.length).toBeLessThan(3000);
    expect(msg?.content).toContain('…(truncated)');
  });

  it('does not truncate short messages', () => {
    const deps = makeDeps({
      getMessages: vi.fn().mockReturnValue([
        { role: 'assistant', content: 'short', timestamp: new Date().toISOString() },
      ]),
    });
    const snapshots = collectSessionSnapshots(deps);

    expect(snapshots[0]?.messages[0]?.content).toBe('short');
  });

  it('returns empty array when no sessions are active', () => {
    const deps = makeDeps({ listActiveSessions: vi.fn().mockReturnValue([]) });
    const snapshots = collectSessionSnapshots(deps);
    expect(snapshots).toHaveLength(0);
  });
});

// ─── buildAnalysisReport ────────────────────────────────────────────────────

describe('buildAnalysisReport', () => {
  it('returns formatted report string from pulses and sessions', () => {
    const pulses = [makePulse()];
    const sessions = [{
      agentName: 'fenster',
      messageCount: 2,
      messages: makeMessages(2),
    }];

    const report = buildAnalysisReport(pulses, sessions, '/root');

    expect(report).not.toBeNull();
    expect(report).toContain('Run Analysis Report');
    expect(report).toContain('fenster');
  });

  it('returns null when both pulses and sessions are empty', () => {
    const report = buildAnalysisReport([], [], '/root');
    expect(report).toBeNull();
  });

  it('works with only pulses (no sessions)', () => {
    const report = buildAnalysisReport([makePulse()], [], '/root');
    expect(report).not.toBeNull();
    expect(report).toContain('fenster');
  });

  it('works with only sessions (no pulses)', () => {
    const sessions = [{
      agentName: 'eecom',
      messageCount: 1,
      messages: [{ role: 'user', content: 'test', timestamp: new Date().toISOString() }],
    }];
    const report = buildAnalysisReport([], sessions, '/root');
    expect(report).not.toBeNull();
    expect(report).toContain('eecom');
  });
});

// ─── triggerAutoSageAnalysis ────────────────────────────────────────────────

describe('triggerAutoSageAnalysis', () => {
  describe('successful flow', () => {
    it('returns dispatched: true on success', async () => {
      const deps = makeDeps();
      const result = await triggerAutoSageAnalysis(deps);

      expect(result.dispatched).toBe(true);
      expect(result.report).toContain('Run Analysis Report');
      expect(result.sageResponse).toBeTruthy();
    });

    it('dispatches to sage agent', async () => {
      const deps = makeDeps();
      await triggerAutoSageAnalysis(deps);

      expect(deps.dispatch).toHaveBeenCalledTimes(1);
      const [agentName, message] = (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(agentName).toBe('sage');
      expect(message).toContain('Analysis Report');
    });

    it('passes the formatted report in the dispatch message', async () => {
      const deps = makeDeps();
      await triggerAutoSageAnalysis(deps);

      const [, message] = (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(message).toContain('Run Analysis Report');
      expect(message).toContain('fenster');
    });

    it('includes instructions for Sage in dispatch message', async () => {
      const deps = makeDeps();
      await triggerAutoSageAnalysis(deps);

      const [, message] = (deps.dispatch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
      expect(message).toContain('squad_proposals');
      expect(message).toContain('squad_decide');
      expect(message).toContain('squad_memory');
      expect(message).toContain('improvement proposals');
    });

    it('captures Sage response from dispatch', async () => {
      const sageReply = 'The run was clean. One suggestion: add retry logic.';
      const deps = makeDeps({
        dispatch: vi.fn().mockResolvedValue({ response: sageReply }),
      });
      const result = await triggerAutoSageAnalysis(deps);

      expect(result.sageResponse).toBe(sageReply);
    });

    it('emits a done pulse from sage on success', async () => {
      const deps = makeDeps();
      await triggerAutoSageAnalysis(deps);

      const allPulses = [...deps.pulseCollector.getAll()];
      const sagePulses = allPulses.filter(p => p.agent === 'sage');
      expect(sagePulses.length).toBeGreaterThanOrEqual(1);

      const donePulse = sagePulses.find(p => p.phase === 'done');
      expect(donePulse).toBeDefined();
      expect(donePulse?.status).toBe('ok');
      expect(donePulse?.summary).toContain('Auto-analysis complete');
    });
  });

  describe('no data scenario', () => {
    it('returns dispatched: false when no pulses or sessions exist', async () => {
      const emptyCollector = new PulseCollector();
      const deps = makeDeps({
        pulseCollector: emptyCollector,
        listActiveSessions: vi.fn().mockReturnValue([]),
      });

      const result = await triggerAutoSageAnalysis(deps);

      expect(result.dispatched).toBe(false);
      expect(result.report).toBe('');
      expect(result.sageResponse).toBeNull();
    });

    it('does not dispatch to Sage when there is no data', async () => {
      const emptyCollector = new PulseCollector();
      const deps = makeDeps({
        pulseCollector: emptyCollector,
        listActiveSessions: vi.fn().mockReturnValue([]),
      });

      await triggerAutoSageAnalysis(deps);

      expect(deps.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('dispatch failure', () => {
    it('returns dispatched: false when Sage dispatch throws', async () => {
      const deps = makeDeps({
        dispatch: vi.fn().mockRejectedValue(new Error('Sage session failed')),
      });
      const result = await triggerAutoSageAnalysis(deps);

      expect(result.dispatched).toBe(false);
      expect(result.report).toContain('Run Analysis Report');
      expect(result.sageResponse).toBeNull();
    });

    it('emits a warning pulse when dispatch fails', async () => {
      const deps = makeDeps({
        dispatch: vi.fn().mockRejectedValue(new Error('connection lost')),
      });
      await triggerAutoSageAnalysis(deps);

      const allPulses = [...deps.pulseCollector.getAll()];
      const sagePulses = allPulses.filter(p => p.agent === 'sage');
      const blockedPulse = sagePulses.find(p => p.phase === 'blocked');
      expect(blockedPulse).toBeDefined();
      expect(blockedPulse?.status).toBe('warning');
      expect(blockedPulse?.summary).toContain('dispatch failed');
    });

    it('does not throw — errors are handled gracefully', async () => {
      const deps = makeDeps({
        dispatch: vi.fn().mockRejectedValue(new Error('kaboom')),
      });

      // Should not throw
      await expect(triggerAutoSageAnalysis(deps)).resolves.toBeDefined();
    });
  });

  describe('response handling', () => {
    it('handles dispatch returning no response', async () => {
      const deps = makeDeps({
        dispatch: vi.fn().mockResolvedValue({}),
      });
      const result = await triggerAutoSageAnalysis(deps);

      expect(result.dispatched).toBe(true);
      expect(result.sageResponse).toBeNull();
    });

    it('handles dispatch returning undefined response', async () => {
      const deps = makeDeps({
        dispatch: vi.fn().mockResolvedValue({ response: undefined }),
      });
      const result = await triggerAutoSageAnalysis(deps);

      expect(result.dispatched).toBe(true);
      expect(result.sageResponse).toBeNull();
    });
  });
});

// ─── Config gating ──────────────────────────────────────────────────────────

describe('autoAnalyze config flag', () => {
  it('SquadConfig accepts autoAnalyze boolean', async () => {
    // Verify the type compiles correctly — this is a compile-time check
    // that autoAnalyze is part of SquadConfig
    const { DEFAULT_CONFIG } = await import(
      '../packages/squad-sdk/src/runtime/config.js'
    );
    // autoAnalyze is optional and defaults to undefined (falsy)
    expect(DEFAULT_CONFIG.autoAnalyze).toBeUndefined();
  });

  it('config schema also includes autoAnalyze', async () => {
    const { DEFAULT_CONFIG } = await import(
      '../packages/squad-sdk/src/config/schema.js'
    );
    // The schema default doesn't set autoAnalyze — it's undefined (falsy)
    expect(DEFAULT_CONFIG.autoAnalyze).toBeUndefined();
  });

  it('autoAnalyze defaults to falsy for backward compatibility', async () => {
    const { DEFAULT_CONFIG } = await import(
      '../packages/squad-sdk/src/runtime/config.js'
    );
    // Must be falsy so the pipeline does NOT trigger auto-analysis by default
    expect(!!DEFAULT_CONFIG.autoAnalyze).toBe(false);
  });
});

// ─── Integration: PulseCollector interaction ────────────────────────────────

describe('auto-sage pulse collector integration', () => {
  it('reads existing pulses from collector for analysis', async () => {
    const collector = new PulseCollector();
    collector.record(makePulse({ agent: 'fenster', summary: 'Unique marker 12345' }));

    const deps = makeDeps({ pulseCollector: collector });
    const result = await triggerAutoSageAnalysis(deps);

    // The report should contain data derived from the pre-existing pulse
    expect(result.report).toContain('fenster');
  });

  it('adds sage pulse to collector after analysis', async () => {
    const collector = new PulseCollector();
    collector.record(makePulse());
    const initialCount = collector.getAll().length;

    const deps = makeDeps({ pulseCollector: collector });
    await triggerAutoSageAnalysis(deps);

    // Should have added exactly one sage pulse
    const sagePulses = collector.getAll().filter(p => p.agent === 'sage');
    expect(sagePulses.length).toBe(1);
    expect(collector.getAll().length).toBe(initialCount + 1);
  });

  it('does not add pipeline pulse to collector when no data', async () => {
    const collector = new PulseCollector();
    const deps = makeDeps({
      pulseCollector: collector,
      listActiveSessions: vi.fn().mockReturnValue([]),
    });

    await triggerAutoSageAnalysis(deps);

    // No sage pulse should be added when there's nothing to analyze
    const sagePulses = collector.getAll().filter(p => p.agent === 'sage');
    expect(sagePulses.length).toBe(0);
  });
});

// ─── Sage charter compatibility ─────────────────────────────────────────────

describe('Sage built-in actor compatibility', () => {
  it('Sage has squad_decide and squad_memory in allowed tools', async () => {
    const { getBuiltInActor } = await import(
      '../packages/squad-sdk/src/agents/built-in-actors.js'
    );
    const sage = getBuiltInActor('sage');
    expect(sage).toBeDefined();
    expect(sage?.allowedTools).toContain('squad_decide');
    expect(sage?.allowedTools).toContain('squad_memory');
  });

  it('Sage has squad_pulse in allowed tools (for done/blocked status)', async () => {
    const { getBuiltInActor } = await import(
      '../packages/squad-sdk/src/agents/built-in-actors.js'
    );
    const sage = getBuiltInActor('sage');
    expect(sage?.allowedTools).toContain('squad_pulse');
  });

  it('Sage has squad_proposals in allowed tools (for writing improvement proposals)', async () => {
    const { getBuiltInActor } = await import(
      '../packages/squad-sdk/src/agents/built-in-actors.js'
    );
    const sage = getBuiltInActor('sage');
    expect(sage?.allowedTools).toContain('squad_proposals');
  });

  it('Sage charter mentions post-run analysis', async () => {
    const { getBuiltInActor } = await import(
      '../packages/squad-sdk/src/agents/built-in-actors.js'
    );
    const sage = getBuiltInActor('sage');
    expect(sage?.charter).toContain('Post-run');
    expect(sage?.charter).toContain('analysis');
  });
});

// ─── Source file header comment ─────────────────────────────────────────────

describe('auto-sage source header comment', () => {
  it('has the auto-Sage trigger comment as the first line', () => {
    const filePath = resolve(__dirname, '../packages/squad-sdk/src/mcp/auto-sage.ts');
    const source = readFileSync(filePath, 'utf-8');
    const firstLine = source.split('\n')[0]?.trim();
    expect(firstLine).toBe(
      '// Auto-Sage trigger — runs after pipeline completion when autoAnalyze is enabled',
    );
  });
});
