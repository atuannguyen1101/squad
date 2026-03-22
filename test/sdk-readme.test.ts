/**
 * Tests for SDK module README files.
 *
 * Validates that scratchpad and context README files exist, stay within
 * the 50-line budget, and document the expected API surface.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SDK_SRC = resolve(import.meta.dirname, '..', 'packages', 'squad-sdk', 'src');

function readReadme(moduleDir: string): string {
  return readFileSync(resolve(SDK_SRC, moduleDir, 'README.md'), 'utf-8');
}

// ============================================================================
// Scratchpad README
// ============================================================================

describe('scratchpad README', () => {
  const content = readReadme('scratchpad');
  const lines = content.split('\n');

  it('should exist and be non-empty', () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it('should stay under 50 lines', () => {
    expect(lines.length).toBeLessThanOrEqual(50);
  });

  it('should have a heading that names the module', () => {
    expect(content).toMatch(/^# .*scratchpad/im);
  });

  it('should document all six API methods', () => {
    for (const method of ['write', 'read', 'list', 'delete', 'clear', 'stats']) {
      expect(content).toContain(`\`${method}\``);
    }
  });

  it('should mention ephemeral/cleared-between-runs semantics', () => {
    expect(content).toMatch(/ephemeral|cleared between runs/i);
  });

  it('should include a code example', () => {
    expect(content).toContain('```ts');
  });
});

// ============================================================================
// Context README
// ============================================================================

describe('context README', () => {
  const content = readReadme('context');
  const lines = content.split('\n');

  it('should exist and be non-empty', () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it('should stay under 50 lines', () => {
    expect(lines.length).toBeLessThanOrEqual(50);
  });

  it('should have a heading that names the module', () => {
    expect(content).toMatch(/^# .*context/im);
  });

  it('should document applyContextWindow', () => {
    expect(content).toContain('applyContextWindow');
  });

  it('should document extractiveSummarize', () => {
    expect(content).toContain('extractiveSummarize');
  });

  it('should document createContextWindowState', () => {
    expect(content).toContain('createContextWindowState');
  });

  it('should mention both summarization strategies', () => {
    expect(content).toMatch(/extractive/i);
    expect(content).toMatch(/LLM/i);
  });

  it('should document configuration options', () => {
    for (const opt of ['maxMessages', 'keepRecent', 'maxSummaryLength']) {
      expect(content).toContain(`\`${opt}\``);
    }
  });

  it('should include a code example', () => {
    expect(content).toContain('```ts');
  });
});
