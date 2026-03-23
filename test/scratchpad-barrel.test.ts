/**
 * Tests for scratchpad barrel exports (index.ts).
 *
 * Verifies that all required symbols are re-exported through the barrel:
 *   - Scratchpad (class)
 *   - DEFAULT_SCRATCHPAD_CONFIG (const)
 *   - ScratchpadEntry (type)
 *   - ScratchpadConfig (type)
 *   - ScratchpadWriteResult (type)
 *   - ScratchpadStats (type)
 */
import { describe, it, expect } from 'vitest';
import {
  Scratchpad,
  DEFAULT_SCRATCHPAD_CONFIG,
} from '../packages/squad-sdk/src/scratchpad/index.js';
import type {
  ScratchpadEntry,
  ScratchpadConfig,
  ScratchpadWriteResult,
  ScratchpadStats,
} from '../packages/squad-sdk/src/scratchpad/index.js';

describe('Scratchpad barrel exports', () => {
  it('exports Scratchpad class', () => {
    expect(Scratchpad).toBeDefined();
    expect(typeof Scratchpad).toBe('function');
    // Verify it's constructable
    const pad = new Scratchpad();
    expect(pad).toBeInstanceOf(Scratchpad);
  });

  it('exports DEFAULT_SCRATCHPAD_CONFIG with expected shape', () => {
    expect(DEFAULT_SCRATCHPAD_CONFIG).toBeDefined();
    expect(typeof DEFAULT_SCRATCHPAD_CONFIG.maxEntries).toBe('number');
    expect(typeof DEFAULT_SCRATCHPAD_CONFIG.maxValueSize).toBe('number');
  });

  it('type ScratchpadEntry is usable from barrel', () => {
    const pad = new Scratchpad();
    pad.write('test:key', 'value', 'test-agent', ['tag1']);
    const entry: ScratchpadEntry | null = pad.read('test:key');
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe('test:key');
    expect(entry!.value).toBe('value');
    expect(entry!.producer).toBe('test-agent');
    expect(entry!.tags).toEqual(['tag1']);
    expect(entry!.createdAt).toBeTruthy();
    expect(entry!.updatedAt).toBeTruthy();
  });

  it('type ScratchpadConfig is usable from barrel', () => {
    const config: ScratchpadConfig = { maxEntries: 10, maxValueSize: 500 };
    const pad = new Scratchpad(config);
    expect(pad.size).toBe(0);

    // Verify config is respected
    for (let i = 0; i < 10; i++) {
      pad.write(`k${i}`, `v${i}`, 'agent');
    }
    const result = pad.write('overflow', 'v', 'agent');
    expect(result.success).toBe(false);
  });

  it('type ScratchpadWriteResult is usable from barrel', () => {
    const pad = new Scratchpad();
    const result: ScratchpadWriteResult = pad.write('key', 'val', 'agent');
    expect(result.success).toBe(true);
    expect(result.key).toBe('key');
    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('type ScratchpadStats is usable from barrel', () => {
    const pad = new Scratchpad();
    pad.write('a:k1', 'hello', 'agentA');
    pad.write('b:k2', 'world', 'agentB');

    const stats: ScratchpadStats = pad.stats();
    expect(stats.entryCount).toBe(2);
    expect(stats.totalSize).toBe(10); // 5 + 5
    expect(stats.producerCount).toBe(2);
    expect(stats.producers).toEqual({ agentA: 1, agentB: 1 });
  });

  it('all runtime exports match the direct module exports', async () => {
    const barrel = await import('../packages/squad-sdk/src/scratchpad/index.js');
    const direct = await import('../packages/squad-sdk/src/scratchpad/scratchpad.js');

    // Runtime exports (class + const)
    expect(barrel.Scratchpad).toBe(direct.Scratchpad);
    expect(barrel.DEFAULT_SCRATCHPAD_CONFIG).toBe(direct.DEFAULT_SCRATCHPAD_CONFIG);
  });
});
