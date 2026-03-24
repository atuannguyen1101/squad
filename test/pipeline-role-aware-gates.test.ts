/**
 * Tests for role-aware gate validators.
 * 
 * Gates should distinguish between:
 * 1. Doc writers (DevRel, technical writers) — produce documentation, not code
 * 2. Planners/leads — produce planning output, not code
 * 3. Code implementers — produce code with file verification
 */

import { describe, it, expect } from 'vitest';
import { generateImplPhases, type PhaseGeneratorOptions } from '../packages/squad-sdk/src/pipeline/routing-parser.js';
import { TOOL_CALL_PLACEHOLDER } from '../packages/squad-sdk/src/server/agent-lifecycle.js';

describe('Role-aware gate validators', () => {
  const baseOpts: PhaseGeneratorOptions = {
    message: 'Implement feature X',
    contextAddendum: '',
    toolCallPlaceholder: TOOL_CALL_PLACEHOLDER,
    hasDonePulse: () => false,
    timeout: 300_000,
  };

  describe('Doc writer role detection', () => {
    it('should accept documentation output from doc writers without file verification', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isDocWriterRole: (agentName: string) => agentName === 'pao',
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'pao', reviewer: null },
        opts
      );

      expect(phases).toHaveLength(1);
      const implPhase = phases[0];
      expect(implPhase?.id).toBe('implement');
      expect(implPhase?.agent).toBe('pao');

      // Verify gate accepts substantial documentation output
      const docOutput = 'Updated README.md with installation instructions and API examples. Added getting-started guide with code samples.';
      const gatePass = await implPhase!.gate.validate(docOutput);
      expect(gatePass).toBe(true);
    });

    it('should reject empty output from doc writers', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isDocWriterRole: (agentName: string) => agentName === 'pao',
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'pao', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const gatePass = await implPhase!.gate.validate(''); // Empty output
      expect(gatePass).toBe(false);
    });

    it('should reject placeholder output from doc writers', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isDocWriterRole: (agentName: string) => agentName === 'pao',
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'pao', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const gatePass = await implPhase!.gate.validate(TOOL_CALL_PLACEHOLDER);
      expect(gatePass).toBe(false);
    });
  });

  describe('Planner role detection', () => {
    it('should accept planning output from planners without file verification', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: (agentName: string) => agentName === 'flight',
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'flight', reviewer: null },
        opts
      );

      expect(phases).toHaveLength(1);
      const implPhase = phases[0];
      expect(implPhase?.agent).toBe('flight');

      // Verify gate accepts substantial planning output
      const planOutput = 'Breaking this into 3 parallel tasks: (1) API implementation (2) UI components (3) Test coverage. Routing to EECOM for API, DSKY for UI, SIMS for tests.';
      const gatePass = await implPhase!.gate.validate(planOutput);
      expect(gatePass).toBe(true);
    });

    it('should reject short output from planners', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: (agentName: string) => agentName === 'flight',
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'flight', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const gatePass = await implPhase!.gate.validate('Done'); // Too short
      expect(gatePass).toBe(false);
    });
  });

  describe('Code implementer role detection', () => {
    it('should require file verification for code implementers claiming changes', async () => {
      let verifyCallCount = 0;
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: () => false,
        isDocWriterRole: () => false,
        verifyFileChanges: async (agentName: string, output: string) => {
          verifyCallCount++;
          return true; // Simulate successful verification
        },
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'eecom', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const codeOutput = 'Fixed the authentication bug by updating src/auth.ts. Added test coverage in test/auth.test.ts.';
      const gatePass = await implPhase!.gate.validate(codeOutput);
      
      expect(gatePass).toBe(true);
      expect(verifyCallCount).toBe(1); // Verify was called
    });

    it('should fail gate when code implementer claims changes but verification fails', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: () => false,
        isDocWriterRole: () => false,
        verifyFileChanges: async () => false, // Simulate verification failure
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'eecom', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const codeOutput = 'Fixed the authentication bug by updating src/auth.ts. Added test coverage in test/auth.test.ts.';
      const gatePass = await implPhase!.gate.validate(codeOutput);
      
      expect(gatePass).toBe(false); // Gate should fail when verification fails
    });

    it('should accept substantial output from code implementers without file claims', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: () => false,
        isDocWriterRole: () => false,
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'eecom', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      const output = 'Analyzed the authentication flow and identified the root cause: token expiration not handled correctly in middleware.';
      const gatePass = await implPhase!.gate.validate(output);
      
      expect(gatePass).toBe(true); // Should pass without verification when no file claims
    });
  });

  describe('Multi-subtask with mixed roles', () => {
    it('should apply appropriate gates for each subtask agent role', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        isPlannerRole: (agentName: string) => agentName === 'flight',
        isDocWriterRole: (agentName: string) => agentName === 'pao',
        verifyFileChanges: async (agentName: string) => agentName === 'eecom', // Only EECOM's changes verify
      };

      const phases = generateImplPhases(
        {
          kind: 'multi',
          subtasks: [
            { agent: 'eecom', task: 'Implement API' },
            { agent: 'pao', task: 'Write docs' },
          ],
          reviewer: null,
        },
        opts
      );

      expect(phases).toHaveLength(2); // Two parallel implementation phases
      
      // Test EECOM (code implementer) gate
      const eecomPhase = phases.find(p => p.agent === 'eecom');
      const eecomOutput = 'Implemented API endpoints in src/api.ts with full test coverage.';
      const eecomGatePass = await eecomPhase!.gate.validate(eecomOutput);
      expect(eecomGatePass).toBe(true);
      
      // Test PAO (doc writer) gate
      const paoPhase = phases.find(p => p.agent === 'pao');
      const paoOutput = 'Updated API documentation in docs/api.md with examples and error codes.';
      const paoGatePass = await paoPhase!.gate.validate(paoOutput);
      expect(paoGatePass).toBe(true);
    });
  });

  describe('Done pulse override', () => {
    it('should pass gate when done pulse emitted regardless of role', async () => {
      const opts: PhaseGeneratorOptions = {
        ...baseOpts,
        hasDonePulse: () => true, // Done pulse emitted
        isPlannerRole: () => false,
        isDocWriterRole: () => false,
      };

      const phases = generateImplPhases(
        { kind: 'single', implementer: 'eecom', reviewer: null },
        opts
      );

      const implPhase = phases[0];
      
      // Should pass even with placeholder output when done pulse is present
      const gatePass = await implPhase!.gate.validate(TOOL_CALL_PLACEHOLDER);
      expect(gatePass).toBe(true);
    });
  });
});
