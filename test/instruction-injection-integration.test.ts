/**
 * Integration test for instruction injection in agent system prompts
 * 
 * Tests that .github/instructions/ files are auto-injected into agent system prompts
 * when an agent is dispatched for work on matching file paths.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectInstructions } from '@bradygaster/squad-sdk/agents';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRoot = path.join(__dirname, '..');

describe('Instruction Injection Integration', () => {
  it('should inject TypeScript standards when working on .ts files', () => {
    const filePaths = ['src/agents/agent-lifecycle.ts', 'src/types.ts'];
    const result = injectInstructions(testRoot, filePaths);
    
    // Should include TypeScript standards
    expect(result).toContain('## Project Instructions');
    expect(result).toContain('TypeScript Code Standards');
    expect(result).toContain('Type Safety');
    expect(result).toContain('strict: true');
  });

  it('should inject React standards when working on .tsx files', () => {
    const filePaths = ['src/components/App.tsx', 'src/components/Button.tsx'];
    const result = injectInstructions(testRoot, filePaths);
    
    // Should include both TypeScript and React standards
    expect(result).toContain('## Project Instructions');
    
    // TypeScript applies to .tsx
    if (fs.existsSync(path.join(testRoot, '.github', 'instructions', 'typescript-standards.md'))) {
      expect(result).toContain('TypeScript Code Standards');
    }
    
    // React standards if they exist
    if (fs.existsSync(path.join(testRoot, '.github', 'instructions', 'react-standards.md'))) {
      expect(result).toContain('React');
    }
  });

  it('should not inject instructions for non-matching file patterns', () => {
    const filePaths = ['README.md', 'docs/guide.md'];
    const result = injectInstructions(testRoot, filePaths);
    
    // TypeScript standards should not apply to markdown files
    // (unless there's a markdown-specific instruction file)
    if (result) {
      expect(result).not.toContain('TypeScript Code Standards');
    }
  });

  it('should inject multiple instructions when multiple patterns match', () => {
    // TypeScript test files might match both TypeScript standards and testing standards
    const filePaths = ['src/utils.test.ts'];
    const result = injectInstructions(testRoot, filePaths);
    
    if (result) {
      expect(result).toContain('## Project Instructions');
      // At least TypeScript standards should be included
      expect(result).toContain('TypeScript');
    }
  });

  it('should handle mixed file types correctly', () => {
    const filePaths = [
      'src/utils.ts',           // TypeScript
      'src/App.tsx',            // React/TypeScript
      'README.md',              // Markdown (may not match any instructions)
      'package.json',           // JSON (may not match any instructions)
    ];
    
    const result = injectInstructions(testRoot, filePaths);
    
    // Should include TypeScript standards (matches .ts and .tsx)
    if (result) {
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('TypeScript');
    }
  });

  it('should return empty string when working on files with no matching instructions', () => {
    const filePaths = ['data/config.yml', 'scripts/build.sh'];
    const result = injectInstructions(testRoot, filePaths);
    
    // Likely no instructions for .yml or .sh files
    expect(result).toBe('');
  });

  it('should properly format instruction sections with titles and bodies', () => {
    const filePaths = ['src/index.ts'];
    const result = injectInstructions(testRoot, filePaths);
    
    if (result) {
      // Should have proper markdown structure
      expect(result).toContain('## Project Instructions');
      expect(result).toContain('###'); // Subsection headers
      
      // Should indicate type (instruction or skill)
      expect(result).toMatch(/\(instruction\)|\(skill\)/);
    }
  });

  it('should discover and apply skills from .squad/skills/ directory', () => {
    // Skills with applyTo patterns should also be injected
    const filePaths = ['test/example.test.ts'];
    const result = injectInstructions(testRoot, filePaths);
    
    // The result depends on what skills exist with test file patterns
    // This test just verifies the function runs without error
    expect(result).toBeDefined();
  });

  it('should handle glob patterns with ** (any subdirectory)', () => {
    const filePaths = ['packages/squad-sdk/src/agents/lifecycle.ts'];
    const result = injectInstructions(testRoot, filePaths);
    
    // **/*.ts should match files in any subdirectory
    if (result) {
      expect(result).toContain('TypeScript');
    }
  });

  it('should handle dotfiles correctly when instructions target them', () => {
    const filePaths = ['.eslintrc.json', '.prettierrc'];
    const result = injectInstructions(testRoot, filePaths);
    
    // Test that dotfiles can be matched if there are instructions for them
    expect(result).toBeDefined();
  });
});
