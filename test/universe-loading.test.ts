/**
 * Tests for custom universe loading and CastingEngine extensions
 * (Sprint 2, Issue #8: Custom Universe Loading)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CastingEngine } from '../packages/squad-sdk/src/casting/casting-engine.js';
import { validateUniverseJson } from '../packages/squad-sdk/src/casting/universe-schema.js';
import { loadUniversesFromDirectorySync } from '../packages/squad-sdk/src/casting/universe-loader.js';
import type { UniverseTemplate } from '../packages/squad-sdk/src/casting/universe-schema.js';

// --- Universe JSON validation ---

describe('validateUniverseJson', () => {
  const validUniverse: UniverseTemplate = {
    id: 'test-universe',
    name: 'Test Universe',
    description: 'A test universe for testing.',
    characters: [
      {
        name: 'Alpha',
        personality: 'Bold leader.',
        backstory: 'The first to arrive.',
        preferredRoles: ['lead'],
      },
      {
        name: 'Beta',
        personality: 'Reliable developer.',
        backstory: 'Always delivers on time.',
        preferredRoles: ['developer'],
      },
      {
        name: 'Gamma',
        personality: 'Sharp tester.',
        backstory: 'Finds bugs others miss.',
        preferredRoles: ['tester'],
      },
    ],
  };

  it('returns empty array for valid universe', () => {
    expect(validateUniverseJson(validUniverse, 'test.universe.json')).toEqual([]);
  });

  it('rejects non-object input', () => {
    const errors = validateUniverseJson('not-an-object', 'bad.json');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Expected a JSON object');
  });

  it('rejects null', () => {
    const errors = validateUniverseJson(null, 'null.json');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports missing required string fields', () => {
    const errors = validateUniverseJson({}, 'empty.json');
    expect(errors.some(e => e.includes('"id"'))).toBe(true);
    expect(errors.some(e => e.includes('"name"'))).toBe(true);
    expect(errors.some(e => e.includes('"description"'))).toBe(true);
  });

  it('requires at least 3 characters', () => {
    const tooFew = {
      ...validUniverse,
      characters: [validUniverse.characters[0], validUniverse.characters[1]],
    };
    const errors = validateUniverseJson(tooFew, 'few.json');
    expect(errors.some(e => e.includes('at least 3 characters'))).toBe(true);
  });

  it('requires at least one character with lead role', () => {
    const noLead = {
      ...validUniverse,
      characters: [
        { name: 'A', personality: 'X', backstory: 'X', preferredRoles: ['developer'] },
        { name: 'B', personality: 'X', backstory: 'X', preferredRoles: ['tester'] },
        { name: 'C', personality: 'X', backstory: 'X', preferredRoles: ['devops'] },
      ],
    };
    const errors = validateUniverseJson(noLead, 'no-lead.json');
    expect(errors.some(e => e.includes('lead'))).toBe(true);
  });

  it('requires unique character names', () => {
    const dupeNames = {
      ...validUniverse,
      characters: [
        { name: 'Same', personality: 'X', backstory: 'X', preferredRoles: ['lead'] },
        { name: 'Same', personality: 'Y', backstory: 'Y', preferredRoles: ['developer'] },
        { name: 'Different', personality: 'Z', backstory: 'Z', preferredRoles: ['tester'] },
      ],
    };
    const errors = validateUniverseJson(dupeNames, 'dupe.json');
    expect(errors.some(e => e.includes('Duplicate character name'))).toBe(true);
  });

  it('rejects invalid roles in preferredRoles', () => {
    const badRoles = {
      ...validUniverse,
      characters: [
        { name: 'A', personality: 'X', backstory: 'X', preferredRoles: ['lead'] },
        { name: 'B', personality: 'X', backstory: 'X', preferredRoles: ['invalid-role'] },
        { name: 'C', personality: 'X', backstory: 'X', preferredRoles: ['tester'] },
      ],
    };
    const errors = validateUniverseJson(badRoles, 'bad-roles.json');
    expect(errors.some(e => e.includes('Invalid role "invalid-role"'))).toBe(true);
  });

  it('validates character object shape', () => {
    const badChars = {
      ...validUniverse,
      characters: [
        'not-an-object',
        { name: 'B', personality: 'X', backstory: 'X', preferredRoles: ['lead'] },
        { name: 'C', personality: 'X', backstory: 'X', preferredRoles: ['tester'] },
      ],
    };
    const errors = validateUniverseJson(badChars, 'bad-chars.json');
    expect(errors.some(e => e.includes('Expected an object'))).toBe(true);
  });

  it('reports missing character fields', () => {
    const missingFields = {
      ...validUniverse,
      characters: [
        { preferredRoles: ['lead'] },
        { name: 'B', personality: 'X', backstory: 'X', preferredRoles: ['developer'] },
        { name: 'C', personality: 'X', backstory: 'X', preferredRoles: ['tester'] },
      ],
    };
    const errors = validateUniverseJson(missingFields, 'missing.json');
    expect(errors.some(e => e.includes('"name"'))).toBe(true);
    expect(errors.some(e => e.includes('"personality"'))).toBe(true);
    expect(errors.some(e => e.includes('"backstory"'))).toBe(true);
  });
});

// --- Universe directory loading ---

describe('loadUniversesFromDirectorySync', () => {
  let tmpDir: string;

  const validUniverse: UniverseTemplate = {
    id: 'test-load',
    name: 'Test Load Universe',
    description: 'For loading tests.',
    characters: [
      { name: 'Alpha', personality: 'Bold.', backstory: 'First.', preferredRoles: ['lead'] },
      { name: 'Beta', personality: 'Smart.', backstory: 'Second.', preferredRoles: ['developer'] },
      { name: 'Gamma', personality: 'Sharp.', backstory: 'Third.', preferredRoles: ['tester'] },
    ],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-universe-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result for nonexistent directory', () => {
    const result = loadUniversesFromDirectorySync('/nonexistent/path');
    expect(result.universes).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty result for empty directory', () => {
    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('ignores non-.universe.json files', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Universes');
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}');
    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('loads valid .universe.json files', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test-load.universe.json'),
      JSON.stringify(validUniverse, null, 2),
    );

    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toHaveLength(1);
    expect(result.universes[0]!.id).toBe('test-load');
    expect(result.universes[0]!.name).toBe('Test Load Universe');
    expect(result.universes[0]!.characters).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it('reports errors for invalid JSON', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'bad.universe.json'),
      'not valid json {{{',
    );

    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe('bad.universe.json');
    expect(result.errors[0]!.errors[0]).toContain('Invalid JSON');
  });

  it('reports validation errors for malformed universes', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'malformed.universe.json'),
      JSON.stringify({ id: 'malformed', name: 'Bad', description: 'Missing chars' }),
    );

    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('loads valid files and reports errors for invalid ones', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'good.universe.json'),
      JSON.stringify(validUniverse),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'bad.universe.json'),
      JSON.stringify({ not: 'a universe' }),
    );

    const result = loadUniversesFromDirectorySync(tmpDir);
    expect(result.universes).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });
});

// --- CastingEngine extensions ---

describe('CastingEngine — custom universe registration', () => {
  const starTrek: UniverseTemplate = {
    id: 'star-trek',
    name: 'Star Trek: TNG',
    description: 'The crew of the Enterprise.',
    characters: [
      { name: 'Picard', personality: 'Diplomatic.', backstory: 'Captain.', preferredRoles: ['lead'] },
      { name: 'Riker', personality: 'Confident.', backstory: 'First officer.', preferredRoles: ['developer', 'lead'] },
      { name: 'Data', personality: 'Precise.', backstory: 'Android officer.', preferredRoles: ['developer', 'tester'] },
      { name: 'LaForge', personality: 'Resourceful.', backstory: 'Chief Engineer.', preferredRoles: ['devops', 'developer'] },
      { name: 'Worf', personality: 'Vigilant.', backstory: 'Security chief.', preferredRoles: ['security', 'reviewer'] },
    ],
  };

  it('getUniverses() returns built-in universes by default', () => {
    const engine = new CastingEngine();
    const ids = engine.getUniverses();
    expect(ids).toContain('usual-suspects');
    expect(ids).toContain('oceans-eleven');
    expect(ids).not.toContain('star-trek');
  });

  it('registerUniverse() adds a new universe', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const ids = engine.getUniverses();
    expect(ids).toContain('star-trek');
    expect(ids).toContain('usual-suspects');
  });

  it('getUniverse() returns registered universe', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const u = engine.getUniverse('star-trek');
    expect(u).toBeDefined();
    expect(u!.label).toBe('Star Trek: TNG');
    expect(u!.characters).toHaveLength(5);
  });

  it('castTeam() works with registered custom universe', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const team = engine.castTeam({ universe: 'star-trek' });
    expect(team.length).toBeGreaterThanOrEqual(3);

    const roles = team.map(m => m.role);
    expect(roles).toContain('lead');
    expect(roles).toContain('developer');
    expect(roles).toContain('tester');

    // Picard should be assigned lead
    const lead = team.find(m => m.role === 'lead');
    expect(lead?.name).toBe('Picard');
  });

  it('castTeam() respects teamSize for custom universes', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const team = engine.castTeam({ universe: 'star-trek', teamSize: 4 });
    expect(team).toHaveLength(4);
  });

  it('castTeam() with requiredRoles for custom universe', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const team = engine.castTeam({
      universe: 'star-trek',
      requiredRoles: ['lead', 'security'],
    });

    const roles = team.map(m => m.role);
    expect(roles).toContain('lead');
    expect(roles).toContain('security');
  });

  it('registerUniverse() overrides existing universe by id', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    const modified: UniverseTemplate = {
      ...starTrek,
      name: 'Star Trek: Modified',
    };
    engine.registerUniverse(modified);

    const u = engine.getUniverse('star-trek');
    expect(u?.label).toBe('Star Trek: Modified');
  });

  it('built-in universes still work after registering custom ones', () => {
    const engine = new CastingEngine();
    engine.registerUniverse(starTrek);

    // Built-in should still work
    const team = engine.castTeam({ universe: 'usual-suspects' });
    expect(team.length).toBeGreaterThanOrEqual(3);
  });

  it('throws for unknown universe (not registered)', () => {
    const engine = new CastingEngine();
    expect(() => engine.castTeam({ universe: 'narnia' })).toThrow('Unknown universe');
  });

  it('each engine instance has independent universe registry', () => {
    const engine1 = new CastingEngine();
    const engine2 = new CastingEngine();

    engine1.registerUniverse(starTrek);
    expect(engine1.getUniverses()).toContain('star-trek');
    expect(engine2.getUniverses()).not.toContain('star-trek');
  });
});

// --- Example universe file validation ---

describe('Example universe file', () => {
  it('example-star-trek.universe.json is valid', () => {
    const filePath = path.join(
      import.meta.dirname ?? __dirname,
      '..',
      '.squad-templates',
      'universes',
      'example-star-trek.universe.json',
    );

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as UniverseTemplate;

    const errors = validateUniverseJson(parsed, 'example-star-trek.universe.json');
    expect(errors).toEqual([]);

    expect(parsed.id).toBe('star-trek');
    expect(parsed.name).toBe('Star Trek: The Next Generation');
    expect(parsed.characters.length).toBeGreaterThanOrEqual(3);

    // At least one character has 'lead' preferred
    const hasLead = parsed.characters.some(c => c.preferredRoles.includes('lead'));
    expect(hasLead).toBe(true);

    // All character names are unique
    const names = parsed.characters.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('example universe can be loaded and used for casting', () => {
    const filePath = path.join(
      import.meta.dirname ?? __dirname,
      '..',
      '.squad-templates',
      'universes',
      'example-star-trek.universe.json',
    );

    const raw = fs.readFileSync(filePath, 'utf-8');
    const template = JSON.parse(raw) as UniverseTemplate;

    const engine = new CastingEngine();
    engine.registerUniverse(template);

    const team = engine.castTeam({
      universe: 'star-trek',
      teamSize: 5,
      requiredRoles: ['lead', 'developer', 'security'],
    });

    expect(team).toHaveLength(5);
    expect(team.map(m => m.role)).toContain('lead');
    expect(team.map(m => m.role)).toContain('developer');
    expect(team.map(m => m.role)).toContain('security');

    // Picard should be the lead
    const lead = team.find(m => m.role === 'lead');
    expect(lead?.name).toBe('Picard');
  });
});

// --- Directory loading integration ---

describe('CastingEngine.loadUniversesFromDirectory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cast-load-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads universes from directory and makes them available for casting', async () => {
    const universe: UniverseTemplate = {
      id: 'test-dir-load',
      name: 'Dir Load Test',
      description: 'Testing directory loading.',
      characters: [
        { name: 'One', personality: 'Bold.', backstory: 'First.', preferredRoles: ['lead'] },
        { name: 'Two', personality: 'Smart.', backstory: 'Second.', preferredRoles: ['developer'] },
        { name: 'Three', personality: 'Sharp.', backstory: 'Third.', preferredRoles: ['tester'] },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, 'test-dir-load.universe.json'),
      JSON.stringify(universe, null, 2),
    );

    const engine = new CastingEngine();
    await engine.loadUniversesFromDirectory(tmpDir);

    expect(engine.getUniverses()).toContain('test-dir-load');
    const team = engine.castTeam({ universe: 'test-dir-load' });
    expect(team.length).toBeGreaterThanOrEqual(3);
  });

  it('handles empty directory gracefully', async () => {
    const engine = new CastingEngine();
    await engine.loadUniversesFromDirectory(tmpDir);

    // Should still have built-in universes
    expect(engine.getUniverses()).toContain('usual-suspects');
    expect(engine.getUniverses()).toContain('oceans-eleven');
  });
});
