/**
 * Universe Schema — Type definitions and validation for custom universes
 *
 * Defines the JSON schema format for custom universe files loaded
 * from `.squad-templates/universes/`. Provides validation with
 * clear error messages.
 *
 * @module casting/universe-schema
 */

import type { AgentRole } from './casting-engine.js';

/**
 * A character within a universe template.
 */
export interface UniverseCharacter {
  /** Character name (unique within universe) */
  name: string;
  /** One-line personality trait */
  personality: string;
  /** Short backstory for system-prompt injection */
  backstory: string;
  /** Preferred agent roles, ordered by best fit */
  preferredRoles: AgentRole[];
}

/**
 * A universe template definition.
 *
 * Universe files are JSON with this shape, loaded from
 * `.squad-templates/universes/{id}.universe.json`.
 */
export interface UniverseTemplate {
  /** Unique kebab-case identifier (e.g., 'star-trek') */
  id: string;
  /** Display name (e.g., 'Star Trek') */
  name: string;
  /** One-line description of the universe */
  description: string;
  /** Array of characters available for casting */
  characters: UniverseCharacter[];
}

/**
 * Valid agent roles for validation.
 */
const VALID_AGENT_ROLES: ReadonlySet<string> = new Set<AgentRole>([
  'lead',
  'developer',
  'tester',
  'prompt-engineer',
  'security',
  'devops',
  'designer',
  'scribe',
  'reviewer',
]);

/**
 * Validation error details for a universe file.
 */
export interface UniverseLoadError {
  file: string;
  errors: string[];
}

/**
 * Validate a parsed JSON object as a UniverseTemplate.
 *
 * @param data - Parsed JSON data
 * @param filename - Source filename (for error context)
 * @returns Array of validation error strings (empty if valid)
 */
export function validateUniverseJson(data: unknown, filename: string): string[] {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [`${filename}: Expected a JSON object, got ${typeof data}`];
  }

  const obj = data as Record<string, unknown>;

  // Required string fields
  for (const field of ['id', 'name', 'description'] as const) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
      errors.push(`Missing or empty required field: "${field}"`);
    }
  }

  // Characters array
  const chars = obj['characters'];
  if (!Array.isArray(chars)) {
    errors.push('Missing required array field: "characters"');
    return errors; // Can't validate further without characters
  }

  // Minimum 3 characters
  if (chars.length < 3) {
    errors.push(`Universe must have at least 3 characters, found ${chars.length}`);
  }

  // Validate each character
  const names = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as Record<string, unknown>;
    const prefix = `characters[${i}]`;

    if (typeof char !== 'object' || char === null || Array.isArray(char)) {
      errors.push(`${prefix}: Expected an object`);
      continue;
    }

    // Required string fields
    for (const field of ['name', 'personality', 'backstory'] as const) {
      if (typeof char[field] !== 'string' || !(char[field] as string).trim()) {
        errors.push(`${prefix}: Missing or empty required field "${field}"`);
      }
    }

    // Unique name check
    if (typeof char['name'] === 'string') {
      if (names.has(char['name'])) {
        errors.push(`${prefix}: Duplicate character name "${char['name']}"`);
      }
      names.add(char['name']);
    }

    // Preferred roles
    const roles = char['preferredRoles'];
    if (!Array.isArray(roles)) {
      errors.push(`${prefix}: Missing required array field "preferredRoles"`);
    } else {
      for (const role of roles) {
        if (typeof role !== 'string') {
          errors.push(`${prefix}: preferredRoles items must be strings`);
        } else if (!VALID_AGENT_ROLES.has(role)) {
          errors.push(
            `${prefix}: Invalid role "${role}" in preferredRoles. Valid roles: ${[...VALID_AGENT_ROLES].join(', ')}`,
          );
        }
      }
    }
  }

  // At least one character must prefer 'lead' role
  if (Array.isArray(chars) && chars.length >= 3) {
    const hasLead = chars.some((char: Record<string, unknown>) => {
      const roles = char['preferredRoles'];
      return Array.isArray(roles) && roles.includes('lead');
    });
    if (!hasLead) {
      errors.push('At least one character must have "lead" in preferredRoles');
    }
  }

  return errors;
}
