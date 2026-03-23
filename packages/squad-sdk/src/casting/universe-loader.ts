/**
 * Universe Directory Loader
 *
 * Loads custom universe definitions from `.squad-templates/universes/`.
 * Each universe is a `{universe-id}.universe.json` file.
 *
 * Follows the same directory-loading pattern as role loading.
 *
 * @module casting/universe-loader
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UniverseTemplate, UniverseLoadError } from './universe-schema.js';
import { validateUniverseJson } from './universe-schema.js';

/**
 * Result of loading universes from a directory.
 */
export interface UniverseLoadResult {
  /** Successfully loaded universe templates */
  universes: UniverseTemplate[];
  /** Files that failed validation */
  errors: UniverseLoadError[];
}

/**
 * Load and validate universe definitions from a directory (sync).
 *
 * Reads all `*.universe.json` files, validates each against the
 * UniverseTemplate schema, and returns valid universes plus errors.
 *
 * @param dir - Directory path to scan for `.universe.json` files
 * @returns Load result with universes and errors
 */
export function loadUniversesFromDirectorySync(dir: string): UniverseLoadResult {
  const result: UniverseLoadResult = { universes: [], errors: [] };

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
    if (!entry.endsWith('.universe.json')) continue;

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

    const validationErrors = validateUniverseJson(parsed, entry);
    if (validationErrors.length > 0) {
      result.errors.push({ file: entry, errors: validationErrors });
      continue;
    }

    result.universes.push(parsed as UniverseTemplate);
  }

  return result;
}

/**
 * Load custom universes from a directory (async wrapper).
 *
 * Reads `.universe.json` files, validates them, and returns valid universes.
 * Invalid files are logged to stderr with clear error messages.
 *
 * @param dir - Directory path to scan
 * @returns Array of successfully loaded universe templates
 */
export async function loadUniversesFromDirectory(dir: string): Promise<UniverseTemplate[]> {
  const result = loadUniversesFromDirectorySync(dir);

  for (const err of result.errors) {
    console.error(`[squad] Skipping invalid universe file "${err.file}":`);
    for (const msg of err.errors) {
      console.error(`  - ${msg}`);
    }
  }

  return result.universes;
}
