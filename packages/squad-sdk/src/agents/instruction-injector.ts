/**
 * Instruction Injection - Auto-inject .github/instructions/ and .squad/skills/
 * content into agent system prompts based on applyTo patterns.
 * 
 * This module reads instruction and skill files, parses their frontmatter for
 * applyTo patterns (glob patterns for file paths), and injects the relevant
 * content into agent system prompts when the agent is working on files that
 * match those patterns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimatch } from 'minimatch';

/**
 * Parsed instruction or skill file with frontmatter metadata.
 */
export interface InstructionFile {
  /** File path */
  filePath: string;
  /** Type: instruction or skill */
  type: 'instruction' | 'skill';
  /** Title from frontmatter or filename */
  title: string;
  /** Glob patterns for files this instruction applies to */
  applyTo: string[];
  /** Full content including frontmatter */
  content: string;
  /** Content without frontmatter (the actual instruction) */
  body: string;
}

/**
 * Parse frontmatter from an instruction/skill file.
 * Looks for YAML frontmatter between --- delimiters at the start of the file.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const lines = content.split('\n');
  
  // Check if file starts with ---
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content };
  }
  
  // Find the closing ---
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }
  
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }
  
  // Parse YAML frontmatter (simple key: value parsing)
  const frontmatter: Record<string, any> = {};
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();
    
    // Handle array values (e.g., "- pattern1\n  - pattern2")
    if (value === '' && i + 1 < endIndex && lines[i + 1]?.trim().startsWith('-')) {
      const arrayValues: string[] = [];
      for (let j = i + 1; j < endIndex && lines[j]?.trim().startsWith('-'); j++) {
        const lineContent = lines[j];
        if (!lineContent) continue;
        let item = lineContent.trim().substring(1).trim();
        // Strip surrounding quotes from YAML values
        if ((item.startsWith('"') && item.endsWith('"')) || 
            (item.startsWith("'") && item.endsWith("'"))) {
          item = item.substring(1, item.length - 1);
        }
        if (item) arrayValues.push(item);
        i = j;
      }
      frontmatter[key] = arrayValues;
    } else {
      // Strip surrounding quotes from scalar values
      let cleanValue = value;
      if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) || 
          (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
        cleanValue = cleanValue.substring(1, cleanValue.length - 1);
      }
      frontmatter[key] = cleanValue;
    }
  }
  
  // Body is everything after the closing ---
  const body = lines.slice(endIndex + 1).join('\n').trim();
  
  return { frontmatter, body };
}

/**
 * Read and parse an instruction or skill file.
 */
function parseInstructionFile(filePath: string, type: 'instruction' | 'skill'): InstructionFile | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    
    // Extract title from frontmatter or filename
    const title = frontmatter.title || path.basename(filePath, path.extname(filePath));
    
    // Extract applyTo patterns (may be a single string or array)
    let applyTo: string[] = [];
    if (frontmatter.applyTo) {
      if (Array.isArray(frontmatter.applyTo)) {
        applyTo = frontmatter.applyTo;
      } else if (typeof frontmatter.applyTo === 'string') {
        applyTo = [frontmatter.applyTo];
      }
    }
    
    return {
      filePath,
      type,
      title,
      applyTo,
      content,
      body: body || content, // If no frontmatter, use full content
    };
  } catch (error) {
    // File read error - skip this file
    return null;
  }
}

/**
 * Discover all instruction files in .github/instructions/ directory.
 */
export function discoverInstructions(squadRoot: string): InstructionFile[] {
  const instructionsDir = path.join(squadRoot, '.github', 'instructions');
  
  if (!fs.existsSync(instructionsDir)) {
    return [];
  }
  
  try {
    const files = fs.readdirSync(instructionsDir);
    const instructions: InstructionFile[] = [];
    
    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.instructions.md')) continue;
      
      const filePath = path.join(instructionsDir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isFile()) {
        const parsed = parseInstructionFile(filePath, 'instruction');
        if (parsed) {
          instructions.push(parsed);
        }
      }
    }
    
    return instructions;
  } catch (error) {
    return [];
  }
}

/**
 * Discover all skill files in .squad/skills/ directory.
 */
export function discoverSkills(squadRoot: string): InstructionFile[] {
  const skillsDir = path.join(squadRoot, '.squad', 'skills');
  
  if (!fs.existsSync(skillsDir)) {
    return [];
  }
  
  try {
    const subdirs = fs.readdirSync(skillsDir);
    const skills: InstructionFile[] = [];
    
    for (const subdir of subdirs) {
      const subdirPath = path.join(skillsDir, subdir);
      const stat = fs.statSync(subdirPath);
      
      if (stat.isDirectory()) {
        // Look for SKILL.md in this directory
        const skillFile = path.join(subdirPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const parsed = parseInstructionFile(skillFile, 'skill');
          if (parsed) {
            skills.push(parsed);
          }
        }
      }
    }
    
    return skills;
  } catch (error) {
    return [];
  }
}

/**
 * Match file paths against instruction/skill applyTo patterns.
 * Returns all instructions/skills that apply to at least one of the given file paths.
 */
export function matchInstructions(
  instructions: InstructionFile[],
  filePaths: string[],
): InstructionFile[] {
  const matched: InstructionFile[] = [];
  
  for (const instruction of instructions) {
    // If no applyTo patterns, skip (doesn't auto-inject)
    if (instruction.applyTo.length === 0) continue;
    
    // Check if any file path matches any applyTo pattern
    const matches = filePaths.some(filePath => 
      instruction.applyTo.some(pattern => 
        minimatch(filePath, pattern, { dot: true })
      )
    );
    
    if (matches) {
      matched.push(instruction);
    }
  }
  
  return matched;
}

/**
 * Build the injected instructions section for system prompt.
 * Formats matched instructions as a markdown section.
 */
export function buildInstructionsSection(matched: InstructionFile[]): string {
  if (matched.length === 0) {
    return '';
  }
  
  const sections: string[] = [];
  sections.push('## Project Instructions\n');
  sections.push('The following instructions apply to files you are working on:\n');
  
  for (const item of matched) {
    sections.push(`### ${item.title} (${item.type})\n`);
    sections.push(item.body);
    sections.push('');
  }
  
  return sections.join('\n');
}

/**
 * Full pipeline: discover, match, and build instructions section.
 * This is the main entry point for the instruction injection system.
 */
export function injectInstructions(
  squadRoot: string,
  filePaths: string[],
): string {
  // Discover all available instructions and skills
  const instructions = discoverInstructions(squadRoot);
  const skills = discoverSkills(squadRoot);
  const all = [...instructions, ...skills];
  
  // Match against file paths
  const matched = matchInstructions(all, filePaths);
  
  // Build section
  return buildInstructionsSection(matched);
}
