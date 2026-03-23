/**
 * Tests for escalation chain protocol
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EscalationManager } from '@bradygaster/squad-sdk/coordinator/escalation';
import type { EscalationEvent } from '@bradygaster/squad-sdk/coordinator/escalation';
import type { SquadEvent } from '@bradygaster/squad-sdk/runtime/event-bus';

describe('EscalationManager', () => {
  let manager: EscalationManager;
  let events: EscalationEvent[];

  beforeEach(() => {
    events = [];
    
    // Use very short timeouts for testing (in seconds)
    manager = new EscalationManager({
      timeouts: {
        agent: 1,    // 1 second
        peer: 1,
        lead: 1,
        human: 1
      },
      chain: ['agent', 'peer', 'lead', 'human'],
      peerMap: {
        'DevA': 'DevB',
        'DevB': 'DevA'
      },
      leadAgent: 'Lead'
    });

    // Subscribe to events
    manager.subscribe((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe('session tracking', () => {
    it('tracks new sessions', () => {
      manager.trackSession('session-1', 'TestAgent');
      
      const state = manager.getState('session-1');
      expect(state).toBeDefined();
      expect(state?.agentName).toBe('TestAgent');
      expect(state?.level).toBe('agent');
    });

    it('untracks destroyed sessions', () => {
      manager.trackSession('session-1', 'TestAgent');
      manager.untrackSession('session-1');
      
      const state = manager.getState('session-1');
      expect(state).toBeUndefined();
    });

    it('updates activity and resets timer', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Update activity (should reset timer)
      manager.updateActivity('session-1');
      
      // Wait less than timeout
      await new Promise(resolve => setTimeout(resolve, 700));
      
      // Should not have escalated yet
      expect(events.length).toBe(0);
      
      const state = manager.getState('session-1');
      expect(state?.level).toBe('agent');
    });
  });

  describe('event bus integration', () => {
    it('tracks sessions on creation event', () => {
      const event: SquadEvent = {
        type: 'session:created',
        sessionId: 'session-1',
        agentName: 'TestAgent',
        payload: { agentName: 'TestAgent', priority: 'normal' },
        timestamp: new Date()
      };

      manager.handleEvent(event);
      
      const state = manager.getState('session-1');
      expect(state).toBeDefined();
    });

    it('updates activity on message event', () => {
      manager.trackSession('session-1', 'TestAgent');
      
      const event: SquadEvent = {
        type: 'session:message',
        sessionId: 'session-1',
        payload: { message: 'Hello' },
        timestamp: new Date()
      };

      manager.handleEvent(event);
      
      // Activity updated - timer should be reset
      const state = manager.getState('session-1');
      expect(state?.lastActivity).toBeGreaterThan(Date.now() - 1000);
    });

    it('updates activity on tool call event', () => {
      manager.trackSession('session-1', 'TestAgent');
      
      const event: SquadEvent = {
        type: 'session:tool_call',
        sessionId: 'session-1',
        payload: { toolName: 'squad_route', toolArgs: {} },
        timestamp: new Date()
      };

      manager.handleEvent(event);
      
      const state = manager.getState('session-1');
      expect(state?.lastActivity).toBeGreaterThan(Date.now() - 1000);
    });

    it('untracks on destroyed event', () => {
      manager.trackSession('session-1', 'TestAgent');
      
      const event: SquadEvent = {
        type: 'session:destroyed',
        sessionId: 'session-1',
        payload: { agentName: 'TestAgent', reason: 'complete' },
        timestamp: new Date()
      };

      manager.handleEvent(event);
      
      const state = manager.getState('session-1');
      expect(state).toBeUndefined();
    });
  });

  describe('escalation chain', () => {
    it('escalates from agent to peer after timeout', async () => {
      manager.trackSession('session-1', 'DevA');
      
      // Wait for agent timeout (1 second)
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('escalated');
      expect(events[0]?.context.level).toBe('peer');
      expect(events[0]?.context.agentName).toBe('DevA');
      
      const state = manager.getState('session-1');
      expect(state?.level).toBe('peer');
    });

    it('escalates through full chain', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      // Wait for all escalations (agent -> peer -> lead -> human)
      // Each level has 1s timeout, so ~4s total
      await new Promise(resolve => setTimeout(resolve, 4500));
      
      // Should have 3 escalation events (agent->peer, peer->lead, lead->human)
      // Plus 1 timeout event at human level
      expect(events.length).toBeGreaterThanOrEqual(3);
      
      const escalationEvents = events.filter(e => e.type === 'escalated');
      expect(escalationEvents.length).toBe(3);
      
      expect(escalationEvents[0]?.context.level).toBe('peer');
      expect(escalationEvents[1]?.context.level).toBe('lead');
      expect(escalationEvents[2]?.context.level).toBe('human');
      
      const state = manager.getState('session-1');
      expect(state?.level).toBe('human');
    });

    it('stops escalating at human level', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      // Wait for all escalations + extra time (4.5s)
      await new Promise(resolve => setTimeout(resolve, 4500));
      
      const state = manager.getState('session-1');
      expect(state?.level).toBe('human'); // Should not escalate beyond human
      
      // Should have timeout event at human level
      const timeoutEvents = events.filter(e => e.type === 'timeout');
      expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
    }, 6000); // Increase timeout to 6 seconds

    it('resolves escalation on activity', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      // Wait for escalation to peer
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('escalated');
      
      // Update activity (agent resumed work)
      manager.updateActivity('session-1');
      
      // Should emit resolved event
      expect(events.length).toBe(2);
      expect(events[1]?.type).toBe('resolved');
      
      const state = manager.getState('session-1');
      expect(state?.level).toBe('agent'); // Reset to agent level
    });
  });

  describe('escalation targets', () => {
    it('returns peer for peer level', async () => {
      manager.trackSession('session-1', 'DevA');
      
      // Wait for peer escalation
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const target = manager.getEscalationTarget('session-1', 'DevA');
      expect(target).toBe('DevB'); // Peer of DevA
    });

    it('returns lead for lead level', async () => {
      manager.trackSession('session-1', 'DevA');
      
      // Wait for lead escalation (agent -> peer -> lead)
      await new Promise(resolve => setTimeout(resolve, 2200));
      
      const target = manager.getEscalationTarget('session-1', 'DevA');
      expect(target).toBe('Lead');
    });

    it('returns undefined for human level', async () => {
      manager.trackSession('session-1', 'DevA');
      
      // Wait for human escalation
      await new Promise(resolve => setTimeout(resolve, 3300));
      
      const target = manager.getEscalationTarget('session-1', 'DevA');
      expect(target).toBeUndefined(); // Human intervention needed
    });

    it('returns undefined when not escalated', () => {
      manager.trackSession('session-1', 'DevA');
      
      const target = manager.getEscalationTarget('session-1', 'DevA');
      expect(target).toBeUndefined(); // Still at agent level
    });
  });

  describe('human escalation callback', () => {
    it('calls onHumanEscalation when reaching human level', async () => {
      const humanCallback = vi.fn();
      
      const customManager = new EscalationManager({
        timeouts: { agent: 1, peer: 1, lead: 1, human: 1 },
        chain: ['agent', 'peer', 'lead', 'human'],
        onHumanEscalation: humanCallback
      });

      customManager.trackSession('session-1', 'TestAgent');
      
      // Wait for human escalation
      await new Promise(resolve => setTimeout(resolve, 3300));
      
      expect(humanCallback).toHaveBeenCalledTimes(1);
      expect(humanCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          agentName: 'TestAgent',
          level: 'human'
        })
      );
      
      customManager.shutdown();
    });
  });

  describe('configuration', () => {
    it('uses default timeouts', () => {
      const defaultManager = new EscalationManager();
      
      defaultManager.trackSession('session-1', 'TestAgent');
      
      const state = defaultManager.getState('session-1');
      expect(state).toBeDefined();
      
      defaultManager.shutdown();
    });

    it('allows custom escalation chain', () => {
      const customManager = new EscalationManager({
        chain: ['agent', 'lead'] // Skip peer level
      });

      customManager.trackSession('session-1', 'TestAgent');
      
      const state = customManager.getState('session-1');
      expect(state?.level).toBe('agent');
      
      customManager.shutdown();
    });

    it('updates config at runtime', () => {
      manager.updateConfig({
        leadAgent: 'NewLead',
        timeouts: { agent: 10 }
      });

      // Config updated - no error
      expect(manager).toBeDefined();
    });
  });

  describe('escalation context', () => {
    it('includes stuck duration in context', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const event = events[0];
      expect(event?.context.stuckDuration).toBeGreaterThan(1000);
      expect(event?.context.reason).toContain('No progress');
    });

    it('includes escalation reason', async () => {
      manager.trackSession('session-1', 'TestAgent');
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const event = events[0];
      expect(event?.context.reason).toBeDefined();
      expect(event?.context.reason).toContain('agent level');
    });
  });

  describe('edge cases', () => {
    it('handles missing peer mapping', async () => {
      manager.trackSession('session-1', 'UnmappedAgent');
      
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      // Should still escalate to peer level
      const state = manager.getState('session-1');
      expect(state?.level).toBe('peer');
      
      // But getEscalationTarget returns undefined (no peer defined)
      const target = manager.getEscalationTarget('session-1', 'UnmappedAgent');
      expect(target).toBeUndefined();
    });

    it('handles double tracking same session', () => {
      manager.trackSession('session-1', 'TestAgent');
      manager.trackSession('session-1', 'TestAgent'); // Second call should be no-op
      
      const state = manager.getState('session-1');
      expect(state).toBeDefined();
      expect(state?.agentName).toBe('TestAgent');
    });

    it('handles activity update for non-existent session', () => {
      // Should not throw
      manager.updateActivity('non-existent');
      
      expect(true).toBe(true);
    });

    it('handles untrack for non-existent session', () => {
      // Should not throw
      manager.untrackSession('non-existent');
      
      expect(true).toBe(true);
    });
  });
});
