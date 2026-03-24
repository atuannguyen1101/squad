/**
 * Tests for instruction-injector.ts
 * 
 * Tests the auto-injection of .github/instructions/ and .squad/skills/ content
 * into agent system prompts based on applyTo patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  discoverInstructions,
  discoverSkills,
  matchInstructions,
  buildInstructionsSection,
  injectInstructions,
  type InstructionFile,
} from './instruction-injector.js';

describe('instruction-injector', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(process.cwd(), 'test-instructions-'));
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('discoverInstructions', () => {
    it('should return empty array when .github/instructions does not exist', () => {
      const result = discoverInstructions(tempDir);
      expect(result).toEqual([]);
    });

    it('should discover instruction files with .md extension', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      const content = `---
title: TypeScript Style Guide
applyTo:
  - "**/*.ts"
  - "**/*.tsx"
---

All TypeScript files must use strict mode.`;

      fs.writeFileSync(path.join(instructionsDir, 'typescript.md'), content);

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('TypeScript Style Guide');
      expect(result[0]?.type).toBe('instruction');
      expect(result[0]?.applyTo).toEqual(['**/*.ts', '**/*.tsx']);
      expect(result[0]?.body).toContain('All TypeScript files must use strict mode');
    });

    it('should handle files with .instructions.md extension', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      const content = `---
title: Testing Guidelines
applyTo: "**/*.test.ts"
---

Always write unit tests.`;

      fs.writeFileSync(path.join(instructionsDir, 'testing.instructions.md'), content);

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('Testing Guidelines');
    });

    it('should skip non-markdown files', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      fs.writeFileSync(path.join(instructionsDir, 'typescript.md'), '---\ntitle: TS\napplyTo: "*.ts"\n---\nContent');
      fs.writeFileSync(path.join(instructionsDir, 'readme.txt'), 'Not markdown');
      fs.writeFileSync(path.join(instructionsDir, 'config.json'), '{}');

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('TS');
    });

    it('should handle files without frontmatter', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      fs.writeFileSync(path.join(instructionsDir, 'plain.md'), 'Just plain content');

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('plain');
      expect(result[0]?.applyTo).toEqual([]);
      expect(result[0]?.body).toBe('Just plain content');
    });

    it('should use filename as title when frontmatter title is missing', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      fs.writeFileSync(path.join(instructionsDir, 'my-guide.md'), '---\napplyTo: "*.js"\n---\nGuide content');

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('my-guide');
    });

    it('should handle single string applyTo pattern', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      const content = `---
title: Single Pattern
applyTo: "src/**/*.ts"
---

Content`;

      fs.writeFileSync(path.join(instructionsDir, 'single.md'), content);

      const result = discoverInstructions(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.applyTo).toEqual(['src/**/*.ts']);
    });
  });

  describe('discoverSkills', () => {
    it('should return empty array when .squad/skills does not exist', () => {
      const result = discoverSkills(tempDir);
      expect(result).toEqual([]);
    });

    it('should discover SKILL.md files in skill subdirectories', () => {
      const skillsDir = path.join(tempDir, '.squad', 'skills', 'testing');
      fs.mkdirSync(skillsDir, { recursive: true });

      const content = `---
title: Testing Skill
applyTo: "**/*.test.ts"
---

Testing best practices.`;

      fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), content);

      const result = discoverSkills(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('Testing Skill');
      expect(result[0]?.type).toBe('skill');
      expect(result[0]?.applyTo).toEqual(['**/*.test.ts']);
    });

    it('should discover multiple skills from different subdirectories', () => {
      const skillsDir1 = path.join(tempDir, '.squad', 'skills', 'testing');
      const skillsDir2 = path.join(tempDir, '.squad', 'skills', 'security');
      fs.mkdirSync(skillsDir1, { recursive: true });
      fs.mkdirSync(skillsDir2, { recursive: true });

      fs.writeFileSync(
        path.join(skillsDir1, 'SKILL.md'),
        '---\ntitle: Testing\napplyTo: "*.test.ts"\n---\nTest content'
      );
      fs.writeFileSync(
        path.join(skillsDir2, 'SKILL.md'),
        '---\ntitle: Security\napplyTo: "*.ts"\n---\nSecurity content'
      );

      const result = discoverSkills(tempDir);
      
      expect(result).toHaveLength(2);
      expect(result.map(s => s.title).sort()).toEqual(['Security', 'Testing']);
    });

    it('should skip directories without SKILL.md', () => {
      const skillsDir1 = path.join(tempDir, '.squad', 'skills', 'testing');
      const skillsDir2 = path.join(tempDir, '.squad', 'skills', 'empty');
      fs.mkdirSync(skillsDir1, { recursive: true });
      fs.mkdirSync(skillsDir2, { recursive: true });

      fs.writeFileSync(
        path.join(skillsDir1, 'SKILL.md'),
        '---\ntitle: Testing\napplyTo: "*.test.ts"\n---\nContent'
      );
      // skillsDir2 has no SKILL.md

      const result = discoverSkills(tempDir);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('Testing');
    });
  });

  describe('matchInstructions', () => {
    it('should match instructions based on glob patterns', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/path/to/ts.md',
          type: 'instruction',
          title: 'TypeScript',
          applyTo: ['**/*.ts', '**/*.tsx'],
          content: 'Full content',
          body: 'Body content',
        },
        {
          filePath: '/path/to/test.md',
          type: 'instruction',
          title: 'Testing',
          applyTo: ['**/*.test.ts'],
          content: 'Full content',
          body: 'Body content',
        },
        {
          filePath: '/path/to/docs.md',
          type: 'instruction',
          title: 'Documentation',
          applyTo: ['docs/**/*.md'],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['src/utils.ts', 'src/utils.test.ts'];

      const result = matchInstructions(instructions, filePaths);
      
      expect(result).toHaveLength(2);
      expect(result.map(r => r.title).sort()).toEqual(['Testing', 'TypeScript']);
    });

    it('should not match instructions without applyTo patterns', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/path/to/general.md',
          type: 'instruction',
          title: 'General',
          applyTo: [],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['src/utils.ts'];

      const result = matchInstructions(instructions, filePaths);
      
      expect(result).toHaveLength(0);
    });

    it('should handle dotfiles with dot: true option', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/path/to/config.md',
          type: 'instruction',
          title: 'Config Files',
          applyTo: ['**/.*.json'],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['.eslintrc.json', 'src/config.json'];

      const result = matchInstructions(instructions, filePaths);
      
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('Config Files');
    });

    it('should match at least one file path against patterns', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/path/to/ts.md',
          type: 'instruction',
          title: 'TypeScript',
          applyTo: ['**/*.ts'],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['src/utils.js', 'src/config.json', 'src/types.ts'];

      const result = matchInstructions(instructions, filePaths);
      
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no patterns match', () => {
      const instructions: InstructionFile[] = [
        {
          filePath: '/path/to/ts.md',
          type: 'instruction',
          title: 'TypeScript',
          applyTo: ['**/*.ts'],
          content: 'Full content',
          body: 'Body content',
        },
      ];

      const filePaths = ['src/utils.js', 'src/config.json'];

      const result = matchInstructions(instructions, filePaths);
      
      expect(result).toHaveLength(0);
    });
  });

  describe('buildInstructionsSection', () => {
    it('should return empty string when no instructions matched', () => {
      const result = buildInstructionsSection([]);
      expect(result).toBe('');
    });

    it('should format single instruction as markdown section', () => {
      const matched: InstructionFile[] = [
        {
          filePath: '/path/to/ts.md',
          type: 'instruction',
          title: 'TypeScript Style',
          applyTo: ['**/*.ts'],
          content: 'Full content',
          body: 'Use strict mode and explicit types.',
        },
      ];

      const result = buildInstructionsSection(matched);
      
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('### TypeScript Style (instruction)');
      expect(result).toContain('Use strict mode and explicit types.');
    });

    it('should format multiple instructions', () => {
      const matched: InstructionFile[] = [
        {
          filePath: '/path/to/ts.md',
          type: 'instruction',
          title: 'TypeScript',
          applyTo: ['**/*.ts'],
          content: 'Full content',
          body: 'TypeScript rules.',
        },
        {
          filePath: '/path/to/testing.md',
          type: 'skill',
          title: 'Testing',
          applyTo: ['**/*.test.ts'],
          content: 'Full content',
          body: 'Testing guidelines.',
        },
      ];

      const result = buildInstructionsSection(matched);
      
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('### TypeScript (instruction)');
      expect(result).toContain('TypeScript rules.');
      expect(result).toContain('### Testing (skill)');
      expect(result).toContain('Testing guidelines.');
    });

    it('should include type label (instruction vs skill)', () => {
      const matched: InstructionFile[] = [
        {
          filePath: '/path/to/test.md',
          type: 'instruction',
          title: 'Instruction Title',
          applyTo: ['*.ts'],
          content: 'Full content',
          body: 'Body',
        },
        {
          filePath: '/path/to/skill.md',
          type: 'skill',
          title: 'Skill Title',
          applyTo: ['*.ts'],
          content: 'Full content',
          body: 'Body',
        },
      ];

      const result = buildInstructionsSection(matched);
      
      expect(result).toContain('(instruction)');
      expect(result).toContain('(skill)');
    });
  });

  describe('injectInstructions - full pipeline', () => {
    it('should return empty string when no relevant files exist', () => {
      const result = injectInstructions(tempDir, ['src/utils.ts']);
      expect(result).toBe('');
    });

    it('should discover, match, and format instructions from .github/instructions', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      const tsContent = `---
title: TypeScript Guidelines
applyTo: "**/*.ts"
---

All TypeScript files must use strict mode.`;

      fs.writeFileSync(path.join(instructionsDir, 'typescript.md'), tsContent);

      const result = injectInstructions(tempDir, ['src/utils.ts', 'src/config.json']);
      
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('### TypeScript Guidelines (instruction)');
      expect(result).toContain('All TypeScript files must use strict mode');
    });

    it('should discover, match, and format skills from .squad/skills', () => {
      const skillDir = path.join(tempDir, '.squad', 'skills', 'testing');
      fs.mkdirSync(skillDir, { recursive: true });

      const content = `---
title: Testing Best Practices
applyTo: "**/*.test.ts"
---

Always write comprehensive unit tests.`;

      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

      const result = injectInstructions(tempDir, ['src/utils.test.ts']);
      
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('### Testing Best Practices (skill)');
      expect(result).toContain('Always write comprehensive unit tests');
    });

    it('should combine instructions and skills in output', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      const skillDir = path.join(tempDir, '.squad', 'skills', 'security');
      fs.mkdirSync(instructionsDir, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });

      fs.writeFileSync(
        path.join(instructionsDir, 'typescript.md'),
        '---\ntitle: TypeScript\napplyTo: "**/*.ts"\n---\nTS content'
      );
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\ntitle: Security\napplyTo: "**/*.ts"\n---\nSecurity content'
      );

      const result = injectInstructions(tempDir, ['src/auth.ts']);
      
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('### TypeScript (instruction)');
      expect(result).toContain('### Security (skill)');
    });

    it('should only match relevant patterns', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(instructionsDir, 'typescript.md'),
        '---\ntitle: TypeScript\napplyTo: "**/*.ts"\n---\nTS content'
      );
      fs.writeFileSync(
        path.join(instructionsDir, 'python.md'),
        '---\ntitle: Python\napplyTo: "**/*.py"\n---\nPython content'
      );

      const result = injectInstructions(tempDir, ['src/utils.ts']);
      
      expect(result).toContain('### TypeScript (instruction)');
      expect(result).not.toContain('### Python (instruction)');
    });

    it('should handle complex glob patterns', () => {
      const instructionsDir = path.join(tempDir, '.github', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });

      const content = `---
title: API Routes
applyTo:
  - "src/api/**/*.ts"
  - "src/routes/**/*.ts"
---

API route guidelines.`;

      fs.writeFileSync(path.join(instructionsDir, 'api.md'), content);

      const resultMatch1 = injectInstructions(tempDir, ['src/api/users.ts']);
      const resultMatch2 = injectInstructions(tempDir, ['src/routes/auth.ts']);
      const resultNoMatch = injectInstructions(tempDir, ['src/utils/helper.ts']);
      
      expect(resultMatch1).toContain('### API Routes (instruction)');
      expect(resultMatch2).toContain('### API Routes (instruction)');
      expect(resultNoMatch).toBe('');
    });
  });
});
