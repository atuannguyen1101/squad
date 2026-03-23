/**
 * Tests for Agent-to-Agent Handoff Protocol (Sprint 3, Item #7)
 *
 * Covers:
 * - HandoffManager validation (circular delegation, depth limits)
 * - Chain tracking and recording
 * - squad_handoff tool integration
 * - Error cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  HandoffManager,
  type HandoffRequest as HandoffRequestType,
  type HandoffChainNode,
} from '@bradygaster/squad-sdk/coordinator';

// Use a local type alias to avoid confusion with the imported type
type HandoffRequest = HandoffRequestType;

// =============================================================================
// HandoffManager Tests
// =============================================================================

describe('HandoffManager', () => {
  let manager: HandoffManager;

  beforeEach(() => {
    manager = new HandoffManager({ maxDepth: 5 });
  });

  describe('constructor', () => {
    it('creates manager with default config', () => {
      const m = new HandoffManager();
      expect(m).toBeDefined();
    });

    it('accepts custom max depth', () => {
      const m = new HandoffManager({ maxDepth: 3 });
      expect(m).toBeDefined();
    });

    it('accepts telemetry flag', () => {
      const m = new HandoffManager({ enableTelemetry: false });
      expect(m).toBeDefined();
    });
  });

  describe('validateHandoff()', () => {
    it('validates simple handoff with no chain', () => {
      const request: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Write unit tests',
      };

      const result = manager.validateHandoff(request);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(0);
      expect(result.reason).toBeUndefined();
    });

    it('rejects self-delegation', () => {
      const request: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'fenster',
        task: 'Do my own work',
      };

      const result = manager.validateHandoff(request);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('cannot delegate to itself');
    });

    it('rejects circular delegation in chain', () => {
      const request1: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(request1, 'session-1');

      const request2: HandoffRequest = {
        fromAgent: 'mcmanus',
        toAgent: 'keaton',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(request2, 'session-2', chainId1);

      // Try to delegate back to mcmanus (already in chain)
      const request3: HandoffRequest = {
        fromAgent: 'keaton',
        toAgent: 'mcmanus',
        task: 'Task 3',
      };

      const result = manager.validateHandoff(request3, chainId2);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Circular delegation detected');
      expect(result.reason).toContain('mcmanus');
    });

    it('rejects handoff exceeding max depth', () => {
      const smallManager = new HandoffManager({ maxDepth: 2 });

      // Build a chain of depth 2
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = smallManager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'b',
        toAgent: 'c',
        task: 'Task 2',
      };
      const chainId2 = smallManager.recordHandoff(req2, 's2', chainId1);

      // Try to add a 3rd level (exceeds maxDepth=2)
      const req3: HandoffRequest = {
        fromAgent: 'c',
        toAgent: 'd',
        task: 'Task 3',
      };

      const result = smallManager.validateHandoff(req3, chainId2);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Maximum delegation depth');
      expect(result.reason).toContain('2');
    });

    it('allows handoff at exactly max depth', () => {
      const smallManager = new HandoffManager({ maxDepth: 2 });

      // Build a chain of depth 1
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = smallManager.recordHandoff(req1, 's1');

      // Validate 2nd level (within limit)
      const req2: HandoffRequest = {
        fromAgent: 'b',
        toAgent: 'c',
        task: 'Task 2',
      };

      const result = smallManager.validateHandoff(req2, chainId1);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(1);
    });

    it('returns correct depth for nested chains', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'b',
        toAgent: 'c',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(req2, 's2', chainId1);

      const req3: HandoffRequest = {
        fromAgent: 'c',
        toAgent: 'd',
        task: 'Task 3',
      };

      const result = manager.validateHandoff(req3, chainId2);

      expect(result.valid).toBe(true);
      expect(result.depth).toBe(2);
    });
  });

  describe('recordHandoff()', () => {
    it('creates new chain for first handoff', () => {
      const request: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Write tests',
      };

      const chainId = manager.recordHandoff(request, 'session-1');

      expect(chainId).toBeTruthy();
      expect(typeof chainId).toBe('string');

      const chain = manager.getChain(chainId);
      expect(chain).toBeDefined();
      expect(chain!.length).toBe(1);
      expect(chain![0].agent).toBe('mcmanus');
      expect(chain![0].task).toBe('Write tests');
      expect(chain![0].sessionId).toBe('session-1');
    });

    it('extends existing chain for nested handoff', () => {
      const req1: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'mcmanus',
        toAgent: 'keaton',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(req2, 's2', chainId1);

      const chain1 = manager.getChain(chainId1);
      const chain2 = manager.getChain(chainId2);

      expect(chain1!.length).toBe(1);
      expect(chain2!.length).toBe(2);
      expect(chain2![0].agent).toBe('mcmanus');
      expect(chain2![1].agent).toBe('keaton');
    });

    it('preserves original chain when creating nested chain', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const chain1Before = manager.getChain(chainId1);
      expect(chain1Before!.length).toBe(1);

      const req2: HandoffRequest = {
        fromAgent: 'b',
        toAgent: 'c',
        task: 'Task 2',
      };
      manager.recordHandoff(req2, 's2', chainId1);

      // Original chain unchanged
      const chain1After = manager.getChain(chainId1);
      expect(chain1After!.length).toBe(1);
      expect(chain1After![0].agent).toBe('b');
    });

    it('creates independent chains for separate handoffs', () => {
      const req1: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'verbal',
        toAgent: 'hockney',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(req2, 's2');

      expect(chainId1).not.toBe(chainId2);

      const chain1 = manager.getChain(chainId1);
      const chain2 = manager.getChain(chainId2);

      expect(chain1!.length).toBe(1);
      expect(chain2!.length).toBe(1);
      expect(chain1![0].agent).toBe('mcmanus');
      expect(chain2![0].agent).toBe('hockney');
    });
  });

  describe('getChain()', () => {
    it('returns undefined for unknown chain ID', () => {
      const chain = manager.getChain('unknown-id');
      expect(chain).toBeUndefined();
    });

    it('returns chain for valid chain ID', () => {
      const request: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Write tests',
      };
      const chainId = manager.recordHandoff(request, 'session-1');

      const chain = manager.getChain(chainId);
      expect(chain).toBeDefined();
      expect(chain!.length).toBe(1);
    });
  });

  describe('clearChain()', () => {
    it('removes chain by ID', () => {
      const request: HandoffRequest = {
        fromAgent: 'fenster',
        toAgent: 'mcmanus',
        task: 'Write tests',
      };
      const chainId = manager.recordHandoff(request, 'session-1');

      expect(manager.getChain(chainId)).toBeDefined();

      manager.clearChain(chainId);

      expect(manager.getChain(chainId)).toBeUndefined();
    });

    it('does not affect other chains', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'c',
        toAgent: 'd',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(req2, 's2');

      manager.clearChain(chainId1);

      expect(manager.getChain(chainId1)).toBeUndefined();
      expect(manager.getChain(chainId2)).toBeDefined();
    });
  });

  describe('getAllChains()', () => {
    it('returns empty array when no chains exist', () => {
      const chains = manager.getAllChains();
      expect(chains).toEqual([]);
    });

    it('returns all active chains', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'c',
        toAgent: 'd',
        task: 'Task 2',
      };
      const chainId2 = manager.recordHandoff(req2, 's2');

      const chains = manager.getAllChains();
      expect(chains.length).toBe(2);
      expect(chains.map((c) => c.chainId)).toContain(chainId1);
      expect(chains.map((c) => c.chainId)).toContain(chainId2);
    });
  });

  describe('clearAll()', () => {
    it('removes all chains', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'c',
        toAgent: 'd',
        task: 'Task 2',
      };
      manager.recordHandoff(req2, 's2');

      expect(manager.getAllChains().length).toBe(2);

      manager.clearAll();

      expect(manager.getAllChains().length).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles long valid chains', () => {
      let chainId: string | undefined;

      for (let i = 0; i < 4; i++) {
        const request: HandoffRequest = {
          fromAgent: `agent${i}`,
          toAgent: `agent${i + 1}`,
          task: `Task ${i + 1}`,
        };
        chainId = manager.recordHandoff(request, `session-${i}`, chainId);
      }

      const chain = manager.getChain(chainId!);
      expect(chain!.length).toBe(4);
      expect(chain![0].agent).toBe('agent1');
      expect(chain![3].agent).toBe('agent4');
    });

    it('validates after recording previous handoffs', () => {
      const req1: HandoffRequest = {
        fromAgent: 'a',
        toAgent: 'b',
        task: 'Task 1',
      };
      const chainId1 = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'b',
        toAgent: 'c',
        task: 'Task 2',
      };

      const validation = manager.validateHandoff(req2, chainId1);
      expect(validation.valid).toBe(true);
      expect(validation.depth).toBe(1);
    });

    it('handles multiple branches from same root', () => {
      const req1: HandoffRequest = {
        fromAgent: 'root',
        toAgent: 'branch-a',
        task: 'Branch A',
      };
      const chainIdA = manager.recordHandoff(req1, 's1');

      const req2: HandoffRequest = {
        fromAgent: 'root',
        toAgent: 'branch-b',
        task: 'Branch B',
      };
      const chainIdB = manager.recordHandoff(req2, 's2');

      const chainA = manager.getChain(chainIdA);
      const chainB = manager.getChain(chainIdB);

      expect(chainA!.length).toBe(1);
      expect(chainB!.length).toBe(1);
      expect(chainA![0].agent).toBe('branch-a');
      expect(chainB![0].agent).toBe('branch-b');
    });
  });
});
