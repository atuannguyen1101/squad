/**
 * Tests for defineRole() builder and RoleCatalog registry
 * (Sprint 2, Issue #3: Runtime Role Registration API)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  defineRole,
  RoleBuilder,
  RoleValidationError,
} from '../packages/squad-sdk/src/roles/define-role.js';
import { RoleCatalog } from '../packages/squad-sdk/src/roles/role-catalog.js';
import {
  loadRolesFromDirectorySync,
  validateRoleJson,
} from '../packages/squad-sdk/src/roles/loader.js';
import { BASE_ROLES } from '../packages/squad-sdk/src/roles/catalog.js';
import type { BaseRole } from '../packages/squad-sdk/src/roles/types.js';

// --- defineRole() builder ---

describe('defineRole() builder', () => {
  it('creates a valid BaseRole with all fields', () => {
    const role = defineRole('api-gateway')
      .title('API Gateway Engineer')
      .category('engineering')
      .emoji('🌐')
      .vibe('Guards the edge.')
      .expertise('API design', 'Rate limiting', 'OAuth 2.0')
      .style('Methodical and security-conscious.')
      .ownership('API gateway configuration', 'Rate limiting policies')
      .approach('Design APIs contract-first', 'Version everything')
      .boundaries('API design and gateway config', 'Database schema')
      .voice('Thinks in request/response cycles.')
      .routingPatterns('api', 'gateway', 'rate limit')
      .attribution('Custom role by test')
      .build();

    expect(role.id).toBe('api-gateway');
    expect(role.title).toBe('API Gateway Engineer');
    expect(role.category).toBe('engineering');
    expect(role.emoji).toBe('🌐');
    expect(role.vibe).toBe('Guards the edge.');
    expect(role.expertise).toEqual(['API design', 'Rate limiting', 'OAuth 2.0']);
    expect(role.style).toBe('Methodical and security-conscious.');
    expect(role.ownership).toEqual(['API gateway configuration', 'Rate limiting policies']);
    expect(role.approach).toEqual(['Design APIs contract-first', 'Version everything']);
    expect(role.boundaries).toEqual({ handles: 'API design and gateway config', doesNotHandle: 'Database schema' });
    expect(role.voice).toBe('Thinks in request/response cycles.');
    expect(role.routingPatterns).toEqual(['api', 'gateway', 'rate limit']);
    expect(role.attribution).toBe('Custom role by test');
  });

  it('returns a frozen object', () => {
    const role = defineRole('frozen-test')
      .title('Test')
      .category('engineering')
      .expertise('Testing')
      .build();

    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(role.expertise)).toBe(true);
    expect(Object.isFrozen(role.boundaries)).toBe(true);
  });

  it('returns a RoleBuilder instance', () => {
    const builder = defineRole('test');
    expect(builder).toBeInstanceOf(RoleBuilder);
  });

  it('supports fluent chaining', () => {
    const builder = defineRole('chain-test');
    const result = builder.title('Test').category('engineering').expertise('A');
    expect(result).toBe(builder);
  });

  it('uses default emoji when not set', () => {
    const role = defineRole('default-emoji')
      .title('Test')
      .category('engineering')
      .expertise('Testing')
      .build();

    expect(role.emoji).toBe('🔧');
  });

  it('uses default attribution when not set', () => {
    const role = defineRole('default-attr')
      .title('Test')
      .category('engineering')
      .expertise('Testing')
      .build();

    expect(role.attribution).toBe('Custom role');
  });

  describe('validation', () => {
    it('throws RoleValidationError if title is missing', () => {
      expect(() =>
        defineRole('no-title')
          .category('engineering')
          .expertise('Testing')
          .build()
      ).toThrow(RoleValidationError);
    });

    it('throws RoleValidationError if category is missing', () => {
      expect(() =>
        defineRole('no-category')
          .title('Test')
          .expertise('Testing')
          .build()
      ).toThrow(RoleValidationError);
    });

    it('throws RoleValidationError if expertise is empty', () => {
      expect(() =>
        defineRole('no-expertise')
          .title('Test')
          .category('engineering')
          .build()
      ).toThrow(RoleValidationError);
    });

    it('throws with empty id', () => {
      expect(() => defineRole('')).toThrow(RoleValidationError);
    });

    it('throws with whitespace-only id', () => {
      expect(() => defineRole('   ')).toThrow(RoleValidationError);
    });

    it('error message lists missing fields', () => {
      try {
        defineRole('incomplete').build();
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RoleValidationError);
        const rve = err as RoleValidationError;
        expect(rve.roleId).toBe('incomplete');
        expect(rve.missingFields).toContain('title');
        expect(rve.missingFields).toContain('category');
        expect(rve.message).toContain('title');
        expect(rve.message).toContain('category');
      }
    });
  });
});

// --- RoleCatalog ---

describe('RoleCatalog', () => {
  afterEach(() => {
    RoleCatalog.resetDefault();
  });

  describe('default catalog', () => {
    it('contains all 20 built-in roles', () => {
      const catalog = RoleCatalog.default;
      expect(catalog.size).toBe(20);
    });

    it('returns the same instance on repeated access', () => {
      const a = RoleCatalog.default;
      const b = RoleCatalog.default;
      expect(a).toBe(b);
    });

    it('can look up built-in roles by id', () => {
      const backend = RoleCatalog.default.get('backend');
      expect(backend).toBeDefined();
      expect(backend?.title).toBe('Backend Developer');
    });

    it('has() returns true for built-in roles', () => {
      expect(RoleCatalog.default.has('lead')).toBe(true);
      expect(RoleCatalog.default.has('nonexistent')).toBe(false);
    });

    it('list() returns all roles', () => {
      const roles = RoleCatalog.default.list();
      expect(roles).toHaveLength(20);
      expect(Object.isFrozen(roles)).toBe(true);
    });

    it('listByCategory() filters correctly', () => {
      const engineering = RoleCatalog.default.listByCategory('engineering');
      expect(engineering.length).toBeGreaterThan(0);
      for (const role of engineering) {
        expect(role.category).toBe('engineering');
      }
    });
  });

  describe('register()', () => {
    it('adds a new role', () => {
      const catalog = new RoleCatalog();
      const role = defineRole('custom-test')
        .title('Custom Test Role')
        .category('engineering')
        .expertise('Testing')
        .build();

      catalog.register(role);
      expect(catalog.has('custom-test')).toBe(true);
      expect(catalog.get('custom-test')).toBe(role);
    });

    it('overrides existing role by id', () => {
      const catalog = RoleCatalog.default;
      const originalBackend = catalog.get('backend');
      expect(originalBackend).toBeDefined();

      const customBackend = defineRole('backend')
        .title('Custom Backend')
        .category('engineering')
        .expertise('Custom expertise')
        .build();

      catalog.register(customBackend);
      expect(catalog.get('backend')?.title).toBe('Custom Backend');
    });

    it('increments size for new roles', () => {
      const catalog = new RoleCatalog();
      expect(catalog.size).toBe(0);

      const role = defineRole('new-role')
        .title('New')
        .category('engineering')
        .expertise('X')
        .build();

      catalog.register(role);
      expect(catalog.size).toBe(1);
    });
  });

  describe('resetDefault()', () => {
    it('creates a fresh default instance', () => {
      const first = RoleCatalog.default;
      const customRole = defineRole('temp')
        .title('Temp')
        .category('engineering')
        .expertise('X')
        .build();
      first.register(customRole);
      expect(first.has('temp')).toBe(true);

      RoleCatalog.resetDefault();
      const second = RoleCatalog.default;
      expect(second).not.toBe(first);
      expect(second.has('temp')).toBe(false);
      expect(second.size).toBe(20);
    });
  });
});

// --- Role JSON validation ---

describe('validateRoleJson', () => {
  const validRole: Record<string, unknown> = {
    id: 'test-role',
    title: 'Test Role',
    category: 'engineering',
    emoji: '🔧',
    vibe: 'Testing is life.',
    expertise: ['Testing'],
    style: 'Precise.',
    ownership: ['Test suites'],
    approach: ['Test first'],
    boundaries: { handles: 'Tests', doesNotHandle: 'Deployments' },
    voice: 'Speaks in assertions.',
    routingPatterns: ['test', 'spec'],
    attribution: 'Custom',
  };

  it('returns empty array for valid role', () => {
    expect(validateRoleJson(validRole, 'test.role.json')).toEqual([]);
  });

  it('rejects non-object input', () => {
    const errors = validateRoleJson('not-an-object', 'bad.role.json');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Expected a JSON object');
  });

  it('rejects null', () => {
    const errors = validateRoleJson(null, 'null.role.json');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports missing required string fields', () => {
    const errors = validateRoleJson({}, 'empty.role.json');
    expect(errors.some(e => e.includes('"id"'))).toBe(true);
    expect(errors.some(e => e.includes('"title"'))).toBe(true);
    expect(errors.some(e => e.includes('"category"'))).toBe(true);
  });

  it('rejects invalid category', () => {
    const errors = validateRoleJson(
      { ...validRole, category: 'invalid-cat' },
      'bad-cat.role.json',
    );
    expect(errors.some(e => e.includes('Invalid category'))).toBe(true);
  });

  it('rejects empty expertise array', () => {
    const errors = validateRoleJson(
      { ...validRole, expertise: [] },
      'no-expertise.role.json',
    );
    expect(errors.some(e => e.includes('at least one entry'))).toBe(true);
  });

  it('rejects non-string items in arrays', () => {
    const errors = validateRoleJson(
      { ...validRole, expertise: [42] },
      'bad-expertise.role.json',
    );
    expect(errors.some(e => e.includes('array of strings'))).toBe(true);
  });

  it('rejects missing boundaries object', () => {
    const errors = validateRoleJson(
      { ...validRole, boundaries: 'not-an-object' },
      'bad-bounds.role.json',
    );
    expect(errors.some(e => e.includes('"boundaries"'))).toBe(true);
  });

  it('rejects boundaries without handles', () => {
    const errors = validateRoleJson(
      { ...validRole, boundaries: { doesNotHandle: 'X' } },
      'no-handles.role.json',
    );
    expect(errors.some(e => e.includes('boundaries.handles'))).toBe(true);
  });
});

// --- Directory loading ---

describe('loadRolesFromDirectorySync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-roles-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result for nonexistent directory', () => {
    const result = loadRolesFromDirectorySync('/nonexistent/path');
    expect(result.roles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty result for empty directory', () => {
    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('ignores non-.role.json files', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Roles');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('loads valid .role.json files', () => {
    const roleData: BaseRole = {
      id: 'test-loader',
      title: 'Test Loader Role',
      category: 'engineering',
      emoji: '🧪',
      vibe: 'Loads things.',
      expertise: ['Loading'],
      style: 'Systematic.',
      ownership: ['Load operations'],
      approach: ['Load first'],
      boundaries: { handles: 'Loading', doesNotHandle: 'Unloading' },
      voice: 'Speaks in loads.',
      routingPatterns: ['load', 'import'],
      attribution: 'Test',
    };

    fs.writeFileSync(
      path.join(tmpDir, 'test-loader.role.json'),
      JSON.stringify(roleData, null, 2),
    );

    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]!.id).toBe('test-loader');
    expect(result.roles[0]!.title).toBe('Test Loader Role');
    expect(result.errors).toEqual([]);
  });

  it('reports errors for invalid JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'bad.role.json'),
      'not valid json {{{',
    );

    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe('bad.role.json');
    expect(result.errors[0]!.errors[0]).toContain('Invalid JSON');
  });

  it('reports validation errors for malformed roles', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'malformed.role.json'),
      JSON.stringify({ id: 'malformed', title: 'Missing fields' }),
    );

    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.errors.length).toBeGreaterThan(0);
  });

  it('loads valid files and reports errors for invalid ones', () => {
    const validRole: BaseRole = {
      id: 'valid',
      title: 'Valid Role',
      category: 'quality',
      emoji: '✅',
      vibe: 'Valid.',
      expertise: ['Validation'],
      style: 'Correct.',
      ownership: ['Correctness'],
      approach: ['Validate everything'],
      boundaries: { handles: 'Validation', doesNotHandle: 'Chaos' },
      voice: 'Speaks truth.',
      routingPatterns: ['valid', 'check'],
      attribution: 'Test',
    };

    fs.writeFileSync(
      path.join(tmpDir, 'valid.role.json'),
      JSON.stringify(validRole),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'invalid.role.json'),
      '{ "not": "a role" }',
    );

    const result = loadRolesFromDirectorySync(tmpDir);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]!.id).toBe('valid');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe('invalid.role.json');
  });

  it('freezes loaded role objects', () => {
    const roleData: BaseRole = {
      id: 'freeze-test',
      title: 'Freeze Test',
      category: 'engineering',
      emoji: '🧊',
      vibe: 'Cold.',
      expertise: ['Freezing'],
      style: 'Icy.',
      ownership: ['Cold storage'],
      approach: ['Freeze first'],
      boundaries: { handles: 'Freezing', doesNotHandle: 'Melting' },
      voice: 'Speaks frost.',
      routingPatterns: ['freeze'],
      attribution: 'Test',
    };

    fs.writeFileSync(
      path.join(tmpDir, 'freeze-test.role.json'),
      JSON.stringify(roleData),
    );

    const result = loadRolesFromDirectorySync(tmpDir);
    expect(Object.isFrozen(result.roles[0])).toBe(true);
  });
});
