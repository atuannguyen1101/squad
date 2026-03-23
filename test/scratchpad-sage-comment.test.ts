/**
 * Verify the auto-Sage comment is present in scratchpad.ts.
 *
 * Reads the source file and asserts that the marker comment appears
 * immediately after the JSDoc block, before any code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCRATCHPAD_PATH = resolve(
  __dirname,
  '../packages/squad-sdk/src/scratchpad/scratchpad.ts',
);

describe('scratchpad.ts auto-Sage comment', () => {
  const source = readFileSync(SCRATCHPAD_PATH, 'utf-8');
  const lines = source.split(/\r?\n/);

  it('should contain the auto-Sage marker comment', () => {
    expect(source).toContain('// Verified by auto-Sage test run');
  });

  it('should place the comment right after the JSDoc block', () => {
    // Find the end of the first JSDoc block ( */ )
    const jsdocEndIndex = lines.findIndex((l) => l.trimEnd() === ' */');
    expect(jsdocEndIndex).toBeGreaterThan(0);

    // The very next line should be the marker comment
    const nextLine = lines[jsdocEndIndex + 1];
    expect(nextLine).toBe('// Verified by auto-Sage test run');
  });
});
