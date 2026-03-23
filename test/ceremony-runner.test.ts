/**
 * Tests for CeremonyRunner — Ceremony execution engine.
 *
 * Covers:
 * - CeremonyRunner.run() dispatch and response collection
 * - buildRetrospectivePrompt() template generation
 * - buildCeremonyContext() from pipeline data
 * - formatCeremonyReport() report formatting
 * - saveCeremonyReport() file persistence
 * - triggerCeremonyManually() manual trigger API
 * - Built-in retrospective ceremony config
 * - validateCeremonyConfig() validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CeremonyRunner,
  buildRetrospectivePrompt,
  buildCeremonyContext,
  formatCeremonyReport,
  saveCeremonyReport,
  triggerCeremonyManually,
  type CeremonyConfigExtended,
  type CeremonyContext,
  type CeremonyPulse,
  type CeremonyResult,
  type AppliedProposalSummary,
} from '@bradygaster/squad-sdk/server/ceremony-runner';
import {
  createDefaultRetrospective,
  createIdleRetrospective,
  validateCeremonyConfig,
} from '@bradygaster/squad-sdk/server/ceremonies/retrospective';

// ─── Test Helpers ───────────────────────────────────────────────────────────

let tempDir: string;

function setupTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-ceremony-test-'));
  fs.mkdirSync(path.join(dir, '.squad', 'ceremonies', 'retros'), { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function makePulse(overrides: Partial<CeremonyPulse> = {}): CeremonyPulse {
  return {
    agent: 'test-agent',
    phase: 'done',
    status: 'ok',
    progressPct: 100,
    summary: 'Test completed',
    blockers: [],
    questionsForUser: [],
    artifacts: [],
    nextStep: '',
    timestamp: '2026-03-23T05:00:00.000Z',
    ...overrides,
  };
}

function makeAppliedProposal(overrides: Partial<AppliedProposalSummary> = {}): AppliedProposalSummary {
  return {
    id: 'test-proposal-1',
    title: 'Fix routing',
    category: 'routing',
    targetFile: '.squad/routing.md',
    appliedAt: '2026-03-23T04:00:00.000Z',
    ...overrides,
  };
}

function makeContext(overrides: Partial<CeremonyContext> = {}): CeremonyContext {
  return {
    trigger: 'all-sessions-closed',
    triggeredAt: '2026-03-23T05:00:00.000Z',
    pulses: [makePulse()],
    appliedProposals: [],
    errors: [],
    blockers: [],
    ...overrides,
  };
}

function makeCeremony(overrides: Partial<CeremonyConfigExtended> = {}): CeremonyConfigExtended {
  return {
    name: 'test-ceremony',
    type: 'retrospective',
    trigger: 'all-sessions-closed',
    participants: ['@agent1', '@agent2'],
    agenda: 'Test agenda',
    enabled: true,
    ...overrides,
  };
}

// ─── buildRetrospectivePrompt Tests ─────────────────────────────────────────

describe('buildRetrospectivePrompt', () => {
  it('should include ceremony name', () => {
    const prompt = buildRetrospectivePrompt(
      makeCeremony({ name: 'Sprint Retro' }),
      makeContext(),
    );
    expect(prompt).toContain('Sprint Retro');
  });

  it('should include discussion framework sections', () => {
    const prompt = buildRetrospectivePrompt(makeCeremony(), makeContext());
    expect(prompt).toContain('What went well?');
    expect(prompt).toContain("What didn't go well?");
    expect(prompt).toContain('What should we change?');
  });

  it('should include run summary from pulses', () => {
    const pulses = [
      makePulse({ agent: 'agent1', phase: 'done' }),
      makePulse({ agent: 'agent2', phase: 'done' }),
      makePulse({ agent: 'agent1', status: 'error', phase: 'blocked', summary: 'Failed' }),
    ];
    const prompt = buildRetrospectivePrompt(makeCeremony(), makeContext({ pulses }));
    expect(prompt).toContain('Agents active:');
    expect(prompt).toContain('**Total pulses:** 3');
    expect(prompt).toContain('**Errors:** 1');
  });

  it('should include errors and blockers', () => {
    const prompt = buildRetrospectivePrompt(
      makeCeremony(),
      makeContext({
        errors: ['[agent1] Build failed'],
        blockers: ['[agent1] Missing dependency'],
      }),
    );
    expect(prompt).toContain('Errors Encountered');
    expect(prompt).toContain('Build failed');
    expect(prompt).toContain('Blockers');
    expect(prompt).toContain('Missing dependency');
  });

  it('should include applied proposals with effectiveness', () => {
    const proposals = [
      makeAppliedProposal({ effective: true, title: 'Good fix' }),
      makeAppliedProposal({ effective: false, title: 'Bad fix', id: 'p2' }),
      makeAppliedProposal({ effective: undefined, title: 'Unknown fix', id: 'p3' }),
    ];
    const prompt = buildRetrospectivePrompt(
      makeCeremony(),
      makeContext({ appliedProposals: proposals }),
    );
    expect(prompt).toContain('Applied Proposals');
    expect(prompt).toContain('✅ Effective');
    expect(prompt).toContain('❌ Same issue recurred');
    expect(prompt).toContain('⏳ Not yet checked');
  });

  it('should include custom agenda if provided', () => {
    const prompt = buildRetrospectivePrompt(
      makeCeremony({ agenda: 'Focus on API stability' }),
      makeContext(),
    );
    expect(prompt).toContain('Focus on API stability');
  });

  it('should include task instructions at the end', () => {
    const prompt = buildRetrospectivePrompt(makeCeremony(), makeContext());
    expect(prompt).toContain('squad_proposals');
    expect(prompt).toContain('squad_memory');
  });
});

// ─── buildCeremonyContext Tests ─────────────────────────────────────────────

describe('buildCeremonyContext', () => {
  it('should build context from pulses', () => {
    const pulses = [
      makePulse({ status: 'error', summary: 'Oops' }),
      makePulse({ blockers: ['blocked on auth'] }),
    ];
    const context = buildCeremonyContext('all-sessions-closed', pulses);
    expect(context.trigger).toBe('all-sessions-closed');
    expect(context.errors).toHaveLength(1);
    expect(context.errors[0]).toContain('Oops');
    expect(context.blockers).toHaveLength(1);
    expect(context.blockers[0]).toContain('blocked on auth');
    expect(context.triggeredAt).toBeTruthy();
  });

  it('should include applied proposals when provided', () => {
    const proposals = [makeAppliedProposal()];
    const context = buildCeremonyContext('manual', [], proposals);
    expect(context.appliedProposals).toHaveLength(1);
  });

  it('should default to empty arrays', () => {
    const context = buildCeremonyContext('pipeline-idle', []);
    expect(context.errors).toHaveLength(0);
    expect(context.blockers).toHaveLength(0);
    expect(context.appliedProposals).toHaveLength(0);
  });
});

// ─── formatCeremonyReport Tests ─────────────────────────────────────────────

describe('formatCeremonyReport', () => {
  it('should format a complete ceremony report', () => {
    const ceremony = makeCeremony({ name: 'Sprint Retro' });
    const context = makeContext({
      pulses: [makePulse()],
      errors: ['Build failed'],
    });
    const result: CeremonyResult = {
      ceremonyName: 'Sprint Retro',
      success: true,
      participantsDispatched: ['agent1'],
      participantsFailed: ['agent2'],
    };
    const responses = new Map<string, string>([['agent1', 'Looks good!']]);

    const report = formatCeremonyReport(ceremony, context, result, responses);
    expect(report).toContain('# Ceremony Report: Sprint Retro');
    expect(report).toContain('agent1');
    expect(report).toContain('agent2');
    expect(report).toContain('Looks good!');
    expect(report).toContain('Run Metrics');
    expect(report).toContain('Failed dispatches');
  });

  it('should not include failed dispatches section when none failed', () => {
    const result: CeremonyResult = {
      ceremonyName: 'test',
      success: true,
      participantsDispatched: ['agent1'],
      participantsFailed: [],
    };
    const report = formatCeremonyReport(makeCeremony(), makeContext(), result, new Map());
    expect(report).not.toContain('Failed dispatches');
  });
});

// ─── saveCeremonyReport Tests ───────────────────────────────────────────────

describe('saveCeremonyReport', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should save report to ceremonies/retros/ directory', () => {
    const filePath = saveCeremonyReport(tempDir, makeCeremony({ name: 'Sprint Retro' }), '# Test Report\n');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('# Test Report\n');
    expect(filePath).toContain('sprint-retro');
  });
});

// ─── CeremonyRunner Tests ───────────────────────────────────────────────────

describe('CeremonyRunner', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should dispatch to all participants', async () => {
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (name: string, _msg: string) => {
      dispatched.push(name);
      return { response: `Response from ${name}` };
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    const result = await runner.run(
      makeCeremony({ participants: ['@agent1', '@agent2'] }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.participantsDispatched).toEqual(['agent1', 'agent2']);
    expect(result.participantsFailed).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual(['agent1', 'agent2']);
  });

  it('should handle dispatch failures gracefully', async () => {
    const dispatch = vi.fn(async (name: string) => {
      if (name === 'agent2') throw new Error('Connection refused');
      return { response: 'ok' };
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    const result = await runner.run(
      makeCeremony({ participants: ['@agent1', '@agent2'] }),
      makeContext(),
    );

    expect(result.success).toBe(true); // Partial success
    expect(result.participantsDispatched).toEqual(['agent1']);
    expect(result.participantsFailed).toEqual(['agent2']);
  });

  it('should succeed with no participants', async () => {
    const dispatch = vi.fn();
    const runner = new CeremonyRunner(tempDir, dispatch);
    const result = await runner.run(
      makeCeremony({ participants: [] }),
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('should save ceremony report', async () => {
    const dispatch = vi.fn(async () => ({ response: 'Noted' }));
    const runner = new CeremonyRunner(tempDir, dispatch);
    const result = await runner.run(makeCeremony(), makeContext());

    expect(result.reportPath).toBeTruthy();
    expect(fs.existsSync(result.reportPath!)).toBe(true);
  });

  it('should use retrospective prompt for retrospective ceremonies', async () => {
    let capturedMessage = '';
    const dispatch = vi.fn(async (_name: string, msg: string) => {
      capturedMessage = msg;
      return {};
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    await runner.run(
      makeCeremony({ type: 'retrospective' }),
      makeContext(),
    );

    expect(capturedMessage).toContain('What went well?');
    expect(capturedMessage).toContain("What didn't go well?");
  });

  it('should use agenda for custom ceremonies', async () => {
    let capturedMessage = '';
    const dispatch = vi.fn(async (_name: string, msg: string) => {
      capturedMessage = msg;
      return {};
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    await runner.run(
      makeCeremony({ type: 'custom', agenda: 'Run status check' }),
      makeContext(),
    );

    expect(capturedMessage).toBe('Run status check');
  });

  it('should strip @ prefix from participant names', async () => {
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (name: string) => {
      dispatched.push(name);
      return {};
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    await runner.run(
      makeCeremony({ participants: ['@sage', 'scribe'] }),
      makeContext(),
    );

    expect(dispatched).toEqual(['sage', 'scribe']);
  });
});

// ─── Manual Trigger Tests ───────────────────────────────────────────────────

describe('triggerCeremonyManually', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should trigger ceremony with manual context', async () => {
    let capturedContext = '';
    const dispatch = vi.fn(async (_name: string, _msg: string, ctx?: string) => {
      capturedContext = ctx ?? '';
      return { response: 'ok' };
    });

    const runner = new CeremonyRunner(tempDir, dispatch);
    const result = await triggerCeremonyManually(
      runner,
      makeCeremony({ participants: ['@sage'] }),
      [makePulse()],
    );

    expect(result.success).toBe(true);
    expect(capturedContext).toContain('Ceremony');
  });
});

// ─── Built-in Retrospective Config Tests ────────────────────────────────────

describe('createDefaultRetrospective', () => {
  it('should create a retrospective ceremony config', () => {
    const config = createDefaultRetrospective(['@sage', '@scribe']);
    expect(config.name).toBe('retrospective');
    expect(config.type).toBe('retrospective');
    expect(config.trigger).toBe('all-sessions-closed');
    expect(config.participants).toEqual(['@sage', '@scribe']);
    expect(config.enabled).toBe(true);
    expect(config.agenda).toContain('What went well');
  });

  it('should work with empty participants', () => {
    const config = createDefaultRetrospective();
    expect(config.participants).toEqual([]);
  });
});

describe('createIdleRetrospective', () => {
  it('should create an idle-triggered retrospective', () => {
    const config = createIdleRetrospective(['@sage'], 60000);
    expect(config.name).toBe('idle-retrospective');
    expect(config.trigger).toBe('pipeline-idle');
    expect(config.idleTimeoutMs).toBe(60000);
  });
});

// ─── validateCeremonyConfig Tests ───────────────────────────────────────────

describe('validateCeremonyConfig', () => {
  it('should pass for valid config', () => {
    const errors = validateCeremonyConfig(makeCeremony());
    expect(errors).toHaveLength(0);
  });

  it('should reject empty name', () => {
    const errors = validateCeremonyConfig(makeCeremony({ name: '' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('name');
  });

  it('should reject invalid type', () => {
    const errors = validateCeremonyConfig(makeCeremony({ type: 'invalid' as any }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Invalid ceremony type');
  });

  it('should reject schedule trigger', () => {
    const errors = validateCeremonyConfig(makeCeremony({ trigger: 'schedule' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cron');
  });
});
