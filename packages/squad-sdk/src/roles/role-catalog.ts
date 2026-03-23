/**
 * RoleCatalog — Runtime registry for base roles
 *
 * Provides a centralized catalog that combines built-in roles with
 * custom roles loaded from `.squad/roles/` or registered at runtime.
 *
 * Custom roles override built-in roles by ID, allowing users to
 * customize any built-in role without forking the SDK.
 *
 * @module roles/role-catalog
 */

import type { BaseRole, RoleCategory } from './types.js';
import { BASE_ROLES } from './catalog.js';

/**
 * Runtime role registry.
 *
 * The default instance (`RoleCatalog.default`) is pre-loaded with
 * the 20 built-in roles. Custom roles can be added via `register()`
 * or loaded from a directory via `loadFromDirectory()`.
 */
export class RoleCatalog {
  private roles: Map<string, BaseRole> = new Map();

  /**
   * The default catalog, pre-loaded with all built-in roles.
   * Lazily initialized on first access.
   */
  private static _default: RoleCatalog | undefined;

  static get default(): RoleCatalog {
    if (!RoleCatalog._default) {
      RoleCatalog._default = new RoleCatalog();
      for (const role of BASE_ROLES) {
        RoleCatalog._default.roles.set(role.id, role);
      }
    }
    return RoleCatalog._default;
  }

  /**
   * Reset the default catalog to a fresh instance with only built-in roles.
   * Primarily for testing.
   */
  static resetDefault(): void {
    RoleCatalog._default = undefined;
  }

  /**
   * Register a role in the catalog.
   * If a role with the same ID already exists, it is replaced.
   *
   * @param role - The BaseRole to register
   */
  register(role: BaseRole): void {
    this.roles.set(role.id, role);
  }

  /**
   * Get a role by ID.
   *
   * @param id - Role ID (e.g., 'backend', 'api-gateway')
   * @returns The role definition, or undefined if not found
   */
  get(id: string): BaseRole | undefined {
    return this.roles.get(id);
  }

  /**
   * Check if a role exists in the catalog.
   *
   * @param id - Role ID to check
   */
  has(id: string): boolean {
    return this.roles.has(id);
  }

  /**
   * List all roles in the catalog.
   *
   * @returns Frozen array of all registered roles
   */
  list(): readonly BaseRole[] {
    return Object.freeze([...this.roles.values()]);
  }

  /**
   * List roles filtered by category.
   *
   * @param cat - Category to filter by
   * @returns Frozen array of matching roles
   */
  listByCategory(cat: RoleCategory): readonly BaseRole[] {
    const filtered: BaseRole[] = [];
    for (const role of this.roles.values()) {
      if (role.category === cat) {
        filtered.push(role);
      }
    }
    return Object.freeze(filtered);
  }

  /**
   * Get the total number of roles in the catalog.
   */
  get size(): number {
    return this.roles.size;
  }

  /**
   * Load custom roles from a directory.
   *
   * Reads `.role.json` files from the specified directory and
   * registers them in this catalog. Invalid files are skipped
   * with a warning logged to stderr.
   *
   * @param dir - Path to the roles directory (e.g., `.squad/roles/`)
   * @returns Array of successfully loaded roles
   */
  static async loadFromDirectory(dir: string): Promise<BaseRole[]> {
    const { loadRolesFromDirectory } = await import('./loader.js');
    return loadRolesFromDirectory(dir);
  }
}
