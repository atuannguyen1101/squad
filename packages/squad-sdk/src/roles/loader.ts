/**
 * Role Directory Loader
 *
 * Loads custom role definitions from `.squad/roles/` directory.
 * Each role is a `{role-id}.role.json` file matching the BaseRole schema.
 *
 * Follows the same directory-loading pattern as `.squad/skills/`.
 *
 * @module roles/loader
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaseRole, RoleCategory } from './types.js';

/**
 * Valid role categories for validation.
 */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<RoleCategory>([
  'engineering',
  'quality',
  'operations',
  'product',
  'design',
  'marketing',
  'sales',
  'support',
  'game-dev',
  'media',
  'compliance',
]);

/**
 * Validation error details for a role file.
 */
export interface RoleLoadError {
  file: string;
  errors: string[];
}

/**
 * Result of loading roles from a directory.
 */
export interface RoleLoadResult {
  /** Successfully loaded roles */
  roles: BaseRole[];
  /** Files that failed validation */
  errors: RoleLoadError[];
}

/**
 * Validate a parsed JSON object as a BaseRole.
 *
 * @param data - Parsed JSON data
 * @param filename - Source filename (for error messages)
 * @returns Array of validation error strings (empty if valid)
 */
export function validateRoleJson(data: unknown, filename: string): string[] {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return [`${filename}: Expected a JSON object, got ${typeof data}`];
  }

  const obj = data as Record<string, unknown>;

  // Required string fields
  for (const field of ['id', 'title', 'emoji', 'vibe', 'style', 'voice', 'attribution'] as const) {
    if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
      errors.push(`Missing or empty required field: "${field}"`);
    }
  }

  // Category validation
  if (typeof obj['category'] !== 'string') {
    errors.push('Missing required field: "category"');
  } else if (!VALID_CATEGORIES.has(obj['category'])) {
    errors.push(
      `Invalid category "${obj['category']}". Valid categories: ${[...VALID_CATEGORIES].join(', ')}`,
    );
  }

  // Required string arrays
  for (const field of ['expertise', 'ownership', 'approach', 'routingPatterns'] as const) {
    const val = obj[field];
    if (!Array.isArray(val)) {
      errors.push(`Missing required array field: "${field}"`);
    } else if (field === 'expertise' && val.length === 0) {
      errors.push('"expertise" must have at least one entry');
    } else if (!val.every((item: unknown) => typeof item === 'string')) {
      errors.push(`"${field}" must be an array of strings`);
    }
  }

  // Boundaries object
  const boundaries = obj['boundaries'];
  if (typeof boundaries !== 'object' || boundaries === null || Array.isArray(boundaries)) {
    errors.push('Missing required field: "boundaries" (object with "handles" and "doesNotHandle")');
  } else {
    const b = boundaries as Record<string, unknown>;
    if (typeof b['handles'] !== 'string') {
      errors.push('"boundaries.handles" must be a string');
    }
    if (typeof b['doesNotHandle'] !== 'string') {
      errors.push('"boundaries.doesNotHandle" must be a string');
    }
  }

  return errors;
}

/**
 * Load and validate role definitions from a directory.
 *
 * Reads all `*.role.json` files, validates each against the BaseRole
 * schema, and returns successfully parsed roles plus any errors.
 *
 * @param dir - Directory path to scan for `.role.json` files
 * @returns Load result with roles and errors
 */
export function loadRolesFromDirectorySync(dir: string): RoleLoadResult {
  const result: RoleLoadResult = { roles: [], errors: [] };

  if (!fs.existsSync(dir)) {
    return result;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.role.json')) continue;

    const filePath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      result.errors.push({
        file: entry,
        errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.errors.push({
        file: entry,
        errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
      });
      continue;
    }

    const validationErrors = validateRoleJson(parsed, entry);
    if (validationErrors.length > 0) {
      result.errors.push({ file: entry, errors: validationErrors });
      continue;
    }

    // Cast is safe after validation
    const role = Object.freeze(parsed as BaseRole);
    result.roles.push(role);
  }

  return result;
}

/**
 * Load custom roles from a directory (async wrapper).
 *
 * Reads `.role.json` files, validates them, and returns valid roles.
 * Invalid files are logged to stderr with clear error messages.
 *
 * @param dir - Directory path to scan
 * @returns Array of successfully loaded roles
 */
export async function loadRolesFromDirectory(dir: string): Promise<BaseRole[]> {
  const result = loadRolesFromDirectorySync(dir);

  // Log errors to stderr so users know about malformed files
  for (const err of result.errors) {
    console.error(`[squad] Skipping invalid role file "${err.file}":`);
    for (const msg of err.errors) {
      console.error(`  - ${msg}`);
    }
  }

  return result.roles;
}
