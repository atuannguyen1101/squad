/**
 * Tests for Shared Scratchpad — cross-agent artifact sharing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Scratchpad,
  DEFAULT_SCRATCHPAD_CONFIG,
} from '../packages/squad-sdk/src/scratchpad/scratchpad.js';
import type {
  ScratchpadEntry,
  ScratchpadStats,
} from '../packages/squad-sdk/src/scratchpad/scratchpad.js';

// ============================================================================
// Tests
// ============================================================================

describe('Shared Scratchpad', () => {
  let pad: Scratchpad;

  beforeEach(() => {
    pad = new Scratchpad();
  });

  describe('DEFAULT_SCRATCHPAD_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_SCRATCHPAD_CONFIG.maxEntries).toBe(200);
      expect(DEFAULT_SCRATCHPAD_CONFIG.maxValueSize).toBe(50_000);
    });
  });

  describe('write', () => {
    it('should write a new entry and return created=true', () => {
      const result = pad.write('EECOM:api-schema', '{ "type": "object" }', 'EECOM');

      expect(result.success).toBe(true);
      expect(result.key).toBe('EECOM:api-schema');
      expect(result.created).toBe(true);
    });

    it('should overwrite an existing entry and return created=false', () => {
      pad.write('key1', 'value1', 'agent1');
      const result = pad.write('key1', 'value2', 'agent1');

      expect(result.success).toBe(true);
      expect(result.created).toBe(false);

      const entry = pad.read('key1');
      expect(entry?.value).toBe('value2');
    });

    it('should preserve createdAt when overwriting', () => {
      pad.write('key1', 'v1', 'agent1');
      const first = pad.read('key1')!;
      const createdAt = first.createdAt;

      // Small delay to ensure timestamps differ
      pad.write('key1', 'v2', 'agent1');
      const second = pad.read('key1')!;

      expect(second.createdAt).toBe(createdAt);
      // updatedAt should be >= createdAt
      expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(createdAt).getTime());
    });

    it('should reject empty keys', () => {
      const result = pad.write('', 'value', 'agent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject whitespace-only keys', () => {
      const result = pad.write('   ', 'value', 'agent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject values exceeding maxValueSize', () => {
      const smallPad = new Scratchpad({ maxValueSize: 100 });
      const result = smallPad.write('key', 'x'.repeat(101), 'agent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum size');
    });

    it('should reject when at capacity for new entries', () => {
      const tinyPad = new Scratchpad({ maxEntries: 2 });
      tinyPad.write('k1', 'v1', 'a');
      tinyPad.write('k2', 'v2', 'a');
      const result = tinyPad.write('k3', 'v3', 'a');

      expect(result.success).toBe(false);
      expect(result.error).toContain('full');
    });

    it('should allow overwrites even when at capacity', () => {
      const tinyPad = new Scratchpad({ maxEntries: 2 });
      tinyPad.write('k1', 'v1', 'a');
      tinyPad.write('k2', 'v2', 'a');

      // Overwrite existing key should work
      const result = tinyPad.write('k1', 'updated', 'a');
      expect(result.success).toBe(true);
      expect(result.created).toBe(false);
    });

    it('should store tags', () => {
      pad.write('key1', 'value', 'agent', ['code', 'schema']);
      const entry = pad.read('key1')!;

      expect(entry.tags).toEqual(['code', 'schema']);
    });
  });

  describe('read', () => {
    it('should return null for non-existent key', () => {
      expect(pad.read('nonexistent')).toBeNull();
    });

    it('should return the full entry', () => {
      pad.write('FIDO:test-results', 'All 42 tests passing', 'FIDO', ['tests']);
      const entry = pad.read('FIDO:test-results')!;

      expect(entry.key).toBe('FIDO:test-results');
      expect(entry.value).toBe('All 42 tests passing');
      expect(entry.producer).toBe('FIDO');
      expect(entry.tags).toEqual(['tests']);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
    });

    it('should allow cross-agent reads', () => {
      pad.write('EECOM:schema', '{ "tables": [] }', 'EECOM');

      // FIDO reading EECOM's data
      const entry = pad.read('EECOM:schema');
      expect(entry?.value).toBe('{ "tables": [] }');
      expect(entry?.producer).toBe('EECOM');
    });
  });

  describe('delete', () => {
    it('should delete an existing entry', () => {
      pad.write('k1', 'v1', 'a');
      expect(pad.delete('k1')).toBe(true);
      expect(pad.read('k1')).toBeNull();
    });

    it('should return false for non-existent key', () => {
      expect(pad.delete('nonexistent')).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for existing keys', () => {
      pad.write('k1', 'v1', 'a');
      expect(pad.has('k1')).toBe(true);
    });

    it('should return false for non-existent keys', () => {
      expect(pad.has('nope')).toBe(false);
    });
  });

  describe('list', () => {
    it('should return all entries when no filter', () => {
      pad.write('k1', 'v1', 'a1');
      pad.write('k2', 'v2', 'a2');
      pad.write('k3', 'v3', 'a1');

      expect(pad.list()).toHaveLength(3);
    });

    it('should filter by producer', () => {
      pad.write('k1', 'v1', 'EECOM');
      pad.write('k2', 'v2', 'FIDO');
      pad.write('k3', 'v3', 'EECOM');

      const entries = pad.list({ producer: 'EECOM' });
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.producer === 'EECOM')).toBe(true);
    });

    it('should filter by tag', () => {
      pad.write('k1', 'v1', 'a', ['code']);
      pad.write('k2', 'v2', 'a', ['test']);
      pad.write('k3', 'v3', 'a', ['code', 'test']);

      const codeEntries = pad.list({ tag: 'code' });
      expect(codeEntries).toHaveLength(2);
    });

    it('should combine producer and tag filters', () => {
      pad.write('k1', 'v1', 'EECOM', ['code']);
      pad.write('k2', 'v2', 'FIDO', ['code']);
      pad.write('k3', 'v3', 'EECOM', ['test']);

      const entries = pad.list({ producer: 'EECOM', tag: 'code' });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.key).toBe('k1');
    });

    it('should return empty array when no matches', () => {
      pad.write('k1', 'v1', 'a');
      expect(pad.list({ producer: 'nonexistent' })).toHaveLength(0);
    });
  });

  describe('stats', () => {
    it('should return zeros for empty scratchpad', () => {
      const stats = pad.stats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.producerCount).toBe(0);
      expect(stats.producers).toEqual({});
    });

    it('should count entries and sizes correctly', () => {
      pad.write('k1', 'hello', 'EECOM');
      pad.write('k2', 'world!', 'FIDO');
      pad.write('k3', 'test', 'EECOM');

      const stats = pad.stats();
      expect(stats.entryCount).toBe(3);
      expect(stats.totalSize).toBe(15); // 5 + 6 + 4
      expect(stats.producerCount).toBe(2);
      expect(stats.producers).toEqual({ EECOM: 2, FIDO: 1 });
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      pad.write('k1', 'v1', 'a');
      pad.write('k2', 'v2', 'a');

      pad.clear();

      expect(pad.size).toBe(0);
      expect(pad.list()).toHaveLength(0);
      expect(pad.read('k1')).toBeNull();
    });
  });

  describe('size', () => {
    it('should return current entry count', () => {
      expect(pad.size).toBe(0);
      pad.write('k1', 'v1', 'a');
      expect(pad.size).toBe(1);
      pad.write('k2', 'v2', 'a');
      expect(pad.size).toBe(2);
      pad.delete('k1');
      expect(pad.size).toBe(1);
    });
  });

  describe('onWrite', () => {
    it('should notify listeners on write', () => {
      const listener = vi.fn();
      pad.onWrite(listener);

      pad.write('k1', 'v1', 'agent1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        key: 'k1',
        value: 'v1',
        producer: 'agent1',
      }));
    });

    it('should notify listeners on overwrite', () => {
      const listener = vi.fn();
      pad.onWrite(listener);

      pad.write('k1', 'v1', 'a');
      pad.write('k1', 'v2', 'a');

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[1]![0].value).toBe('v2');
    });

    it('should support multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      pad.onWrite(listener1);
      pad.onWrite(listener2);

      pad.write('k1', 'v1', 'a');

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should support unsubscribe', () => {
      const listener = vi.fn();
      const unsub = pad.onWrite(listener);

      pad.write('k1', 'v1', 'a');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      pad.write('k2', 'v2', 'a');
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should not break on listener errors', () => {
      const throwingListener = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const normalListener = vi.fn();

      pad.onWrite(throwingListener);
      pad.onWrite(normalListener);

      pad.write('k1', 'v1', 'a');

      expect(throwingListener).toHaveBeenCalledTimes(1);
      expect(normalListener).toHaveBeenCalledTimes(1);
    });

    it('should not notify on failed writes', () => {
      const listener = vi.fn();
      pad.onWrite(listener);

      pad.write('', 'v1', 'a'); // Empty key → failure

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('cross-agent workflow', () => {
    it('should support a producer-consumer pattern', () => {
      // EECOM produces a schema
      pad.write('EECOM:db-schema', 'CREATE TABLE users (id INT, name TEXT)', 'EECOM', ['schema']);

      // FIDO reads it to generate tests
      const schema = pad.read('EECOM:db-schema');
      expect(schema?.value).toContain('CREATE TABLE');

      // FIDO writes test results
      pad.write('FIDO:schema-tests', 'Tests: 3 pass, 0 fail', 'FIDO', ['tests']);

      // PAO reads both to write docs
      const allEntries = pad.list();
      expect(allEntries).toHaveLength(2);

      const stats = pad.stats();
      expect(stats.producerCount).toBe(2);
    });

    it('should support reactive consumers via listeners', () => {
      const consumed: ScratchpadEntry[] = [];
      pad.onWrite((entry) => {
        if (entry.tags.includes('ready-for-review')) {
          consumed.push(entry);
        }
      });

      pad.write('EECOM:impl', 'implementation code', 'EECOM', ['code']);
      pad.write('EECOM:impl', 'updated code', 'EECOM', ['code', 'ready-for-review']);

      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.value).toBe('updated code');
    });
  });
});
