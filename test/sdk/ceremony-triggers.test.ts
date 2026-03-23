import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CeremonyTriggerEngine } from '../../packages/squad-sdk/src/server/ceremony-triggers.js';
import type { CeremonyConfig } from '../../packages/squad-sdk/src/config/schema.js';

describe('CeremonyTriggerEngine', () => {
  let dispatchFn: ReturnType<typeof vi.fn>;
  let activeAgentsFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchFn = vi.fn().mockResolvedValue(undefined);
    activeAgentsFn = vi.fn().mockReturnValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine(ceremonies: CeremonyConfig[], activeAgents: string[] = []) {
    activeAgentsFn.mockReturnValue(activeAgents);
    return new CeremonyTriggerEngine(ceremonies, dispatchFn, activeAgentsFn);
  }

  describe('all-sessions-closed trigger', () => {
    it('fires when last non-ceremony agent closes', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
        agenda: 'Run retrospective',
      }]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).toHaveBeenCalledWith('soze', 'Run retrospective');
    });

    it('does not fire when non-ceremony agents are still active', () => {
      const engine = createEngine(
        [{
          name: 'retrospective',
          trigger: 'all-sessions-closed',
          participants: ['@soze'],
        }],
        ['keaton'],
      );

      engine.onSessionClosed('fenster');
      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('does not fire when the closing agent is a ceremony participant', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
      }]);

      engine.onSessionClosed('soze');
      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('does not double-fire', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
        agenda: 'Run retro',
      }]);

      engine.onSessionClosed('fenster');
      engine.onSessionClosed('mcmanus');

      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('pipeline-idle trigger', () => {
    it('fires after idle timeout', async () => {
      const engine = createEngine([{
        name: 'idle-retro',
        trigger: 'pipeline-idle',
        participants: ['@soze'],
        agenda: 'Idle check',
        idleTimeoutMs: 5000,
      }]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(dispatchFn).toHaveBeenCalledWith('soze', 'Idle check');
    });

    it('resets timer on activity', async () => {
      const engine = createEngine([{
        name: 'idle-retro',
        trigger: 'pipeline-idle',
        participants: ['@soze'],
        idleTimeoutMs: 5000,
      }]);

      engine.onSessionClosed('fenster');
      await vi.advanceTimersByTimeAsync(3000);
      engine.onActivity();
      await vi.advanceTimersByTimeAsync(3000);
      expect(dispatchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000);
      expect(dispatchFn).toHaveBeenCalledTimes(1);
    });

    it('handles multiple idle ceremonies independently', async () => {
      const dispatch2 = vi.fn().mockResolvedValue(undefined);
      const engine = new CeremonyTriggerEngine(
        [
          { name: 'fast-check', trigger: 'pipeline-idle', participants: ['@hockney'], idleTimeoutMs: 2000 },
          { name: 'slow-check', trigger: 'pipeline-idle', participants: ['@soze'], idleTimeoutMs: 5000 },
        ],
        dispatch2,
        () => [],
      );

      engine.onSessionClosed('fenster');
      await vi.advanceTimersByTimeAsync(2000);
      expect(dispatch2).toHaveBeenCalledWith('hockney', 'Run fast-check ceremony');
      expect(dispatch2).not.toHaveBeenCalledWith('soze', expect.anything());

      await vi.advanceTimersByTimeAsync(3000);
      expect(dispatch2).toHaveBeenCalledWith('soze', 'Run slow-check ceremony');
    });
  });

  describe('disable and reset', () => {
    it('disable prevents firing', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
      }]);

      engine.disable();
      engine.onSessionClosed('fenster');
      expect(dispatchFn).not.toHaveBeenCalled();
    });

    it('reset re-enables after disable', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
      }]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).toHaveBeenCalledTimes(1);

      engine.reset();
      engine.onSessionClosed('mcmanus');
      expect(dispatchFn).toHaveBeenCalledTimes(2);
    });

    it('disabled ceremonies skip but do not error', async () => {
      const engine = createEngine([
        { name: 'retro', trigger: 'all-sessions-closed', participants: ['@soze'], enabled: false },
      ]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).not.toHaveBeenCalled();
    });
  });

  describe('@ prefix handling', () => {
    it('strips @ from participant names', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['@soze'],
      }]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).toHaveBeenCalledWith('soze', expect.any(String));
    });

    it('works without @ prefix', () => {
      const engine = createEngine([{
        name: 'retrospective',
        trigger: 'all-sessions-closed',
        participants: ['soze'],
      }]);

      engine.onSessionClosed('fenster');
      expect(dispatchFn).toHaveBeenCalledWith('soze', expect.any(String));
    });
  });
});
