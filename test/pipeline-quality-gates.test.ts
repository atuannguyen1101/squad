/**
 * Tests for pipeline quality gate bug fixes (Bugs 4-5)
 * 
 * Bug 4: Quality gates mandatory regardless of throwaway flag
 * Bug 5: Verify agent claims match file content
 */

import { describe, it, expect } from 'vitest';
import { generateImplPhases } from '../packages/squad-sdk/src/pipeline/routing-parser.js';

describe('Bug 4: Quality Gates Mandatory Regardless of Throwaway Flag', () => {
  it('should include quality requirements in task even with throwaway flag', () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix auth bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        isThrowawayWork: true,
      },
    );

    const implPhase = phases[0]!;
    // Quality requirements are always included
    expect(implPhase.task).toContain('IMPORTANT QUALITY REQUIREMENTS (always mandatory)');
    expect(implPhase.task).toContain('Read and understand all relevant sections');
    expect(implPhase.task).toContain('Verify the build passes');
    expect(implPhase.task).toContain('Test your changes');
    
    // But git operations are disabled
    expect(implPhase.task).toContain('⚠️ THROWAWAY MODE');
    expect(implPhase.task).toContain('Do NOT commit to git');
    expect(implPhase.task).toContain('Do NOT create PR or ADO items');
  });

  it('should not include throwaway warnings when flag is false', () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix auth bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        isThrowawayWork: false,
      },
    );

    const implPhase = phases[0]!;
    // Quality requirements still included
    expect(implPhase.task).toContain('IMPORTANT QUALITY REQUIREMENTS');
    
    // Normal git instructions
    expect(implPhase.task).not.toContain('⚠️ THROWAWAY MODE');
    expect(implPhase.task).toContain('commit your changes to git if appropriate');
  });

  it('should include quality requirements by default when flag is undefined', () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix auth bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        // isThrowawayWork not provided - defaults to normal mode
      },
    );

    const implPhase = phases[0]!;
    expect(implPhase.task).toContain('IMPORTANT QUALITY REQUIREMENTS');
    expect(implPhase.task).not.toContain('⚠️ THROWAWAY MODE');
  });

  it('should include quality requirements in multi-subtask phases with throwaway flag', () => {
    const phases = generateImplPhases(
      {
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Fix auth' },
          { agent: 'mcmanus', task: 'Update docs' },
        ],
        reviewer: null,
      },
      {
        message: 'Build feature',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        isThrowawayWork: true,
      },
    );

    // Check both subtask phases
    for (const phase of phases) {
      if (phase.id.startsWith('implement-')) {
        expect(phase.task).toContain('IMPORTANT QUALITY REQUIREMENTS (always mandatory)');
        expect(phase.task).toContain('⚠️ THROWAWAY MODE');
        expect(phase.task).toContain('Do NOT commit to git');
      }
    }
  });
});

describe('Bug 5: Verify Agent Claims Match File Content', () => {
  it('should call verifyFileChanges when agent claims file modifications', async () => {
    let verificationCalled = false;
    let verifiedAgent = '';
    let verifiedOutput = '';

    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix auth bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        verifyFileChanges: async (agent: string, output: string) => {
          verificationCalled = true;
          verifiedAgent = agent;
          verifiedOutput = output;
          return true; // Claim verified
        },
      },
    );

    const implPhase = phases[0]!;
    const agentOutput = 'I fixed the URI builder in packages/auth/login.ts by updating the token handling.';
    
    // Gate validation should be async now
    const gateResult = await implPhase.gate.validate(agentOutput);
    
    expect(verificationCalled).toBe(true);
    expect(verifiedAgent).toBe('fenster');
    expect(verifiedOutput).toBe(agentOutput);
    expect(gateResult).toBe(true);
  });

  it('should reject when agent claims changes but verification fails', async () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'mcmanus',
        reviewer: null,
      },
      {
        message: 'Update docs',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        verifyFileChanges: async () => false, // Verification failed
      },
    );

    const implPhase = phases[0]!;
    const agentOutput = 'I updated the documentation in docs/api.md with new examples.';
    
    const gateResult = await implPhase.gate.validate(agentOutput);
    
    // Gate should fail because verification returned false
    expect(gateResult).toBe(false);
  });

  it('should pass when no file changes are claimed (no verification needed)', async () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'keaton',
        reviewer: null,
      },
      {
        message: 'Plan refactoring',
        contextAddendum: '',
        hasDonePulse: () => false,
        isPlannerRole: (agent: string) => agent === 'keaton',
        toolCallPlaceholder: '[tool_call_placeholder]',
        verifyFileChanges: async () => {
          throw new Error('Should not be called for planning output');
        },
      },
    );

    const implPhase = phases[0]!;
    const planningOutput = 'Here is my plan: We should refactor the auth module into separate concerns...';
    
    // Should pass without calling verification (planner role)
    const gateResult = await implPhase.gate.validate(planningOutput);
    expect(gateResult).toBe(true);
  });

  it('should verify file changes in multi-subtask phases', async () => {
    const verifications: { agent: string; output: string }[] = [];

    const phases = generateImplPhases(
      {
        kind: 'multi',
        subtasks: [
          { agent: 'fenster', task: 'Fix auth' },
          { agent: 'mcmanus', task: 'Update docs' },
        ],
        reviewer: null,
      },
      {
        message: 'Build feature',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        verifyFileChanges: async (agent: string, output: string) => {
          verifications.push({ agent, output });
          return true;
        },
      },
    );

    const fensterPhase = phases.find(p => p.agent === 'fenster')!;
    const mcmanusPhase = phases.find(p => p.agent === 'mcmanus')!;

    // Simulate both agents claiming changes
    await fensterPhase.gate.validate('Fixed auth in src/auth.ts');
    await mcmanusPhase.gate.validate('Updated API docs in docs/api.md');

    expect(verifications).toHaveLength(2);
    expect(verifications[0]!.agent).toBe('fenster');
    expect(verifications[1]!.agent).toBe('mcmanus');
  });

  it('should detect various file change claim patterns', async () => {
    const testCases = [
      'I fixed the bug in server.ts',
      'Changed auth logic in packages/sdk/auth.js',
      'Updated the configuration in config.json',
      'Modified types in types/index.d.ts',
      'Created new helper in utils.py',
      'Added tests to test.go',
      'Wrote documentation to README.md',
    ];

    for (const claim of testCases) {
      let called = false;
      const phases = generateImplPhases(
        { kind: 'single', implementer: 'fenster', reviewer: null },
        {
          message: 'Fix bug',
          contextAddendum: '',
          hasDonePulse: () => false,
          toolCallPlaceholder: '[tool_call_placeholder]',
          verifyFileChanges: async () => { called = true; return true; },
        },
      );

      await phases[0]!.gate.validate(claim);
      expect(called).toBe(true);
    }
  });

  it('should skip verification when verifyFileChanges is not provided', async () => {
    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        // No verifyFileChanges callback
      },
    );

    const implPhase = phases[0]!;
    const agentOutput = 'I fixed the bug in server.ts and added tests.';
    
    // Should pass even though claim was made (no verification configured)
    const gateResult = await implPhase.gate.validate(agentOutput);
    expect(gateResult).toBe(true);
  });

  it('should not call verification for tool call placeholder responses', async () => {
    let verificationCalled = false;

    const phases = generateImplPhases(
      {
        kind: 'single',
        implementer: 'fenster',
        reviewer: null,
      },
      {
        message: 'Fix bug',
        contextAddendum: '',
        hasDonePulse: () => false,
        toolCallPlaceholder: '[tool_call_placeholder]',
        verifyFileChanges: async () => {
          verificationCalled = true;
          return true;
        },
      },
    );

    const implPhase = phases[0]!;
    const gateResult = await implPhase.gate.validate('[tool_call_placeholder]');
    
    expect(verificationCalled).toBe(false);
    expect(gateResult).toBe(false); // Placeholder should fail validation
  });
});
