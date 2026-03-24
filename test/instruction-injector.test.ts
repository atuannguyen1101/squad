/**
 * Tests for instruction-injector.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverInstructions,
  discoverSkills,
  matchInstructions,
  buildInstructionsSection,
  injectInstructions,
  type InstructionFile,
} from '@bradygaster/squad-sdk/agents';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRoot = path.join(__dirname, '..');

describe('instruction-injector', () => {
  describe('discoverInstructions', () => {
    it('should discover instruction files in .github/instructions/', () => {
      const instructions = discoverInstructions(testRoot);
      
      // Should find at least our test instructions
      expect(instructions.length).toBeGreaterThan(0);
      
      // Check that typescript-standards.md was found
      const tsStandards = instructions.find(i => i.title === 'TypeScript Code Standards');
      expect(tsStandards).toBeDefined();
      expect(tsStandards?.type).toBe('instruction');
      // The applyTo array should have been parsed correctly
      expect(tsStandards?.applyTo.length).toBeGreaterThan(0);
      expect(tsStandards?.applyTo.some(p => p.includes('*.ts'))).toBe(true);
    });

    it('should return empty array if directory does not exist', () => {
      const instructions = discoverInstructions('/nonexistent/path');
      expect(instructions).toEqual([]);
    });
  });

  describe('discoverSkills', () => {
    it('should discover skill files in .squad/skills/', () => {
      const skills = discoverSkills(testRoot);
      
      // Should find existing skills
      expect(skills.length).toBeGreaterThan(0);
      
      // Check that at least one skill was found
      const firstSkill = skills[0];
      expect(firstSkill).toBeDefined();
      expect(firstSkill?.type).toBe('skill');
    });

    it('should return empty array if directory does not exist', () => {
      const skills = discoverSkills('/nonexistent/path');
      expect(skills).toEqual([]);
    });
  });

  describe('matchInstructions', () => {
    it('should match instructions with applyTo patterns', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/test/typescript-standards.md',
          type: 'instruction',
          title: 'TypeScript Standards',
          applyTo: ['**/*.ts', '**/*.tsx'],
          content: 'Full content',
          body: 'Body content',
        },
        {
          filePath: '/test/python-standards.md',
          type: 'instruction',
          title: 'Python Standards',
          applyTo: ['**/*.py'],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = [
        'src/index.ts',
        'components/Button.tsx',
      ];

      const matched = matchInstructions(instructions, filePaths);
      
      expect(matched).toHaveLength(1);
      expect(matched[0]?.title).toBe('TypeScript Standards');
    });

    it('should not match instructions without applyTo patterns', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/test/general.md',
          type: 'instruction',
          title: 'General Guidelines',
          applyTo: [],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['src/index.ts'];
      const matched = matchInstructions(instructions, filePaths);
      
      expect(matched).toHaveLength(0);
    });

    it('should match multiple instructions for a single file', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/test/typescript.md',
          type: 'instruction',
          title: 'TypeScript',
          applyTo: ['**/*.ts'],
          content: 'TS content',
          body: 'TS body',
        },
        {
          filePath: '/test/testing.md',
          type: 'instruction',
          title: 'Testing',
          applyTo: ['**/*.test.ts', '**/*.ts'],
          content: 'Test content',
          body: 'Test body',
        },
      ];

      const filePaths = ['src/index.ts'];
      const matched = matchInstructions(instructions, filePaths);
      
      expect(matched).toHaveLength(2);
    });
  });

  describe('buildInstructionsSection', () => {
    it('should build a markdown section from matched instructions', () => {
      const matched: InstructionFile[] = [
        {
          filePath: '/test/typescript.md',
          type: 'instruction',
          title: 'TypeScript Standards',
          applyTo: ['**/*.ts'],
          content: 'Full content',
          body: '# TypeScript Standards\n\nUse strict mode.',
        },
      ];

      const section = buildInstructionsSection(matched);
      
      expect(section).toContain('## Project Instructions');
      expect(section).toContain('### TypeScript Standards (instruction)');
      expect(section).toContain('Use strict mode.');
    });

    it('should return empty string if no instructions matched', () => {
      const section = buildInstructionsSection([]);
      expect(section).toBe('');
    });
  });

  describe('injectInstructions', () => {
    it('should discover, match, and build section in one call', () => {
      const filePaths = ['src/agents/test.ts'];
      const section = injectInstructions(testRoot, filePaths);
      
      // Should include instructions that match TypeScript files
      if (section) {
        expect(section).toContain('## Project Instructions');
      }
    });

    it('should return empty string if no files provided', () => {
      const section = injectInstructions(testRoot, []);
      expect(section).toBe('');
    });
  });
});
