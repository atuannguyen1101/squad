/**
 * defineRole() — Fluent builder for custom role definitions
 *
 * Provides a type-safe builder API for creating BaseRole objects
 * without needing to construct the full interface manually.
 *
 * ```typescript
 * const myRole = defineRole('api-gateway')
 *   .title('API Gateway Engineer')
 *   .category('engineering')
 *   .emoji('🌐')
 *   .vibe('Guards the edge — every request passes through my hands.')
 *   .expertise('API design', 'Rate limiting', 'OAuth 2.0')
 *   .style('Methodical and security-conscious.')
 *   .ownership('API gateway configuration', 'Rate limiting policies')
 *   .approach('Design APIs contract-first', 'Version everything')
 *   .boundaries('API design and gateway config', 'Database schema')
 *   .voice('Thinks in request/response cycles.')
 *   .routingPatterns('api', 'gateway', 'rate limit', 'oauth')
 *   .build();
 * ```
 *
 * @module roles/define-role
 */

import type { BaseRole, RoleCategory } from './types.js';

/**
 * Validation error thrown when a role definition is incomplete.
 */
export class RoleValidationError extends Error {
  constructor(
    public readonly roleId: string,
    public readonly missingFields: readonly string[],
  ) {
    super(
      `Role '${roleId}' is missing required fields: ${missingFields.join(', ')}`,
    );
    this.name = 'RoleValidationError';
  }
}

/**
 * Fluent builder for constructing BaseRole objects.
 *
 * Required fields (enforced on build): id, title, category, expertise.
 * All other fields have sensible defaults or are optional.
 */
export class RoleBuilder {
  private _id: string;
  private _title: string | undefined;
  private _category: RoleCategory | undefined;
  private _emoji: string = '🔧';
  private _vibe: string = '';
  private _expertise: string[] = [];
  private _style: string = '';
  private _ownership: string[] = [];
  private _approach: string[] = [];
  private _boundaries: { handles: string; doesNotHandle: string } = {
    handles: '',
    doesNotHandle: '',
  };
  private _voice: string = '';
  private _routingPatterns: string[] = [];
  private _attribution: string = 'Custom role';

  constructor(id: string) {
    if (!id || !id.trim()) {
      throw new RoleValidationError('', ['id (must be non-empty)']);
    }
    this._id = id;
  }

  /** Set the human-readable title. */
  title(t: string): this {
    this._title = t;
    return this;
  }

  /** Set the role category. */
  category(c: RoleCategory): this {
    this._category = c;
    return this;
  }

  /** Set the display emoji. */
  emoji(e: string): this {
    this._emoji = e;
    return this;
  }

  /** Set the one-line personality/vibe. */
  vibe(v: string): this {
    this._vibe = v;
    return this;
  }

  /** Set expertise areas. Replaces any previously set expertise. */
  expertise(...areas: string[]): this {
    this._expertise = areas;
    return this;
  }

  /** Set the communication style descriptor. */
  style(s: string): this {
    this._style = s;
    return this;
  }

  /** Set ownership items. Replaces any previously set ownership. */
  ownership(...items: string[]): this {
    this._ownership = items;
    return this;
  }

  /** Set approach/principles. Replaces any previously set approach. */
  approach(...items: string[]): this {
    this._approach = items;
    return this;
  }

  /** Set boundary definitions. */
  boundaries(handles: string, doesNotHandle: string): this {
    this._boundaries = { handles, doesNotHandle };
    return this;
  }

  /** Set the voice/personality description. */
  voice(v: string): this {
    this._voice = v;
    return this;
  }

  /** Set routing patterns for keyword matching. Replaces any previously set patterns. */
  routingPatterns(...patterns: string[]): this {
    this._routingPatterns = patterns;
    return this;
  }

  /** Set the attribution string. */
  attribution(a: string): this {
    this._attribution = a;
    return this;
  }

  /**
   * Build and return the frozen BaseRole object.
   *
   * @throws {RoleValidationError} if required fields are missing
   */
  build(): BaseRole {
    const missing: string[] = [];
    if (!this._title) missing.push('title');
    if (!this._category) missing.push('category');
    if (this._expertise.length === 0) missing.push('expertise (at least one area)');

    if (missing.length > 0) {
      throw new RoleValidationError(this._id, missing);
    }

    const role: BaseRole = {
      id: this._id,
      title: this._title!,
      category: this._category!,
      emoji: this._emoji,
      vibe: this._vibe,
      expertise: Object.freeze([...this._expertise]),
      style: this._style,
      ownership: Object.freeze([...this._ownership]),
      approach: Object.freeze([...this._approach]),
      boundaries: Object.freeze({ ...this._boundaries }),
      voice: this._voice,
      routingPatterns: Object.freeze([...this._routingPatterns]),
      attribution: this._attribution,
    };

    return Object.freeze(role);
  }
}

/**
 * Create a new role definition using the fluent builder API.
 *
 * @param id - Unique role identifier (kebab-case, e.g., 'api-gateway')
 * @returns A RoleBuilder instance for fluent configuration
 */
export function defineRole(id: string): RoleBuilder {
  return new RoleBuilder(id);
}
