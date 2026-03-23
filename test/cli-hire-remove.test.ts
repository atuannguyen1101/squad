/**
 * Tests for `squad hire` and `squad remove` CLI commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ── Test helpers ────────────────────────────────────────────────────

/** Create a minimal .squad/ directory structure in a temp dir. */
async function createTestSquadDir(): Promise<string> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squad-hire-test-'));
  const squadDir = path.join(tmpDir, '.squad');
  const agentsDir = path.join(squadDir, 'agents');
  const castingDir = path.join(squadDir, 'casting');

  await fsp.mkdir(agentsDir, { recursive: true });
  await fsp.mkdir(castingDir, { recursive: true });

  // Create team.md
  const teamMd = [
    '# Squad Team',
    '',
    '> Test Project',
    '',
    '## Members',
    '',
    '| Name | Role | Charter | Status |',
    '|------|------|---------|--------|',
    '| Scribe | Session Logger | `.squad/agents/scribe/charter.md` | 📋 Silent |',
    '| Ralph | Work Monitor | `.squad/agents/ralph/charter.md` | 🔄 Monitor |',
    '',
    '## Project Context',
    '',
    '- **Project:** Test Project',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(squadDir, 'team.md'), teamMd);

  // Create routing.md
  const routingMd = [
    '# Squad Routing',
    '',
    '## Work Type Rules',
    '',
    '| Work Type | Primary Agent | Fallback |',
    '|-----------|---------------|----------|',
    '',
    '## Governance',
    '',
    '- Route based on work type and agent expertise',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(squadDir, 'routing.md'), routingMd);

  // Create registry.json
  const registry = {
    agents: {
      scribe: { created_at: '2025-01-01T00:00:00Z', persistent_name: 'Scribe', universe: 'test', status: 'active' },
      ralph: { created_at: '2025-01-01T00:00:00Z', persistent_name: 'Ralph', universe: 'test', status: 'active' },
    },
  };
  await fsp.writeFile(path.join(castingDir, 'registry.json'), JSON.stringify(registry, null, 2));

  // Create built-in agent directories
  const scribeDir = path.join(agentsDir, 'scribe');
  const ralphDir = path.join(agentsDir, 'ralph');
  await fsp.mkdir(scribeDir, { recursive: true });
  await fsp.mkdir(ralphDir, { recursive: true });
  await fsp.writeFile(path.join(scribeDir, 'charter.md'), '# Scribe — Session Logger\n');
  await fsp.writeFile(path.join(ralphDir, 'charter.md'), '# Ralph — Work Monitor\n');

  return tmpDir;
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ── Hire tests ──────────────────────────────────────────────────────

describe('squad hire', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await createTestSquadDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup(tmpDir);
  });

  it('creates agent directory, charter, and history with catalog role', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'alice', '--role', 'backend', '--yes']);

    const agentDir = path.join(tmpDir, '.squad', 'agents', 'alice');
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'charter.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'history.md'))).toBe(true);

    // Charter should contain role-specific content from catalog
    const charter = fs.readFileSync(path.join(agentDir, 'charter.md'), 'utf8');
    expect(charter).toContain('Alice');
    expect(charter).toContain('Backend');
  });

  it('creates agent with free-text role', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'bob', '--role', 'chaos engineer', '--yes']);

    const agentDir = path.join(tmpDir, '.squad', 'agents', 'bob');
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'charter.md'))).toBe(true);

    const charter = fs.readFileSync(path.join(agentDir, 'charter.md'), 'utf8');
    expect(charter).toContain('Bob');
    // onboardAgent's titleCase produces "Chaos Engineer" in the heading
    // but the generic template body uses the raw role string
    expect(charter.toLowerCase()).toContain('chaos engineer');
  });

  it('errors if .squad/ directory does not exist', async () => {
    const emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squad-empty-'));
    process.chdir(emptyDir);

    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await expect(runHire(['--name', 'x', '--role', 'y', '--yes'])).rejects.toThrow(/squad init/i);

    await cleanup(emptyDir);
  });

  it('errors if agent name already exists', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    // First hire succeeds
    await runHire(['--name', 'dupe', '--role', 'backend', '--yes']);
    // Second hire should fail
    await expect(runHire(['--name', 'dupe', '--role', 'frontend', '--yes'])).rejects.toThrow(/already exists/i);
  });

  it('normalizes agent name to kebab-case', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'My Cool Agent', '--role', 'backend', '--yes']);

    const agentDir = path.join(tmpDir, '.squad', 'agents', 'my-cool-agent');
    expect(fs.existsSync(agentDir)).toBe(true);
  });

  it('updates team.md with new member row', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'carol', '--role', 'frontend', '--yes']);

    const teamMd = fs.readFileSync(path.join(tmpDir, '.squad', 'team.md'), 'utf8');
    expect(teamMd).toContain('Carol');
    expect(teamMd).toContain('Frontend');
    expect(teamMd).toContain('✅ Active');
    expect(teamMd).toContain('.squad/agents/carol/charter.md');
  });

  it('updates routing.md with routing entries from catalog role', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'dave', '--role', 'backend', '--yes']);

    const routingMd = fs.readFileSync(path.join(tmpDir, '.squad', 'routing.md'), 'utf8');
    expect(routingMd).toContain('Dave');
  });

  it('updates registry.json with new agent', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'eve', '--role', 'tester', '--yes']);

    const registry = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.squad', 'casting', 'registry.json'), 'utf8'),
    ) as { agents: Record<string, { status?: string }> };
    expect(registry.agents['eve']).toBeDefined();
    expect(registry.agents['eve']!.status).toBe('active');
  });

  it('accepts --scope flag', async () => {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', 'frank', '--role', 'backend', '--scope', 'API, database, auth', '--yes']);

    const agentDir = path.join(tmpDir, '.squad', 'agents', 'frank');
    expect(fs.existsSync(agentDir)).toBe(true);
  });
});

// ── Remove tests ────────────────────────────────────────────────────

describe('squad remove', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmpDir = await createTestSquadDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup(tmpDir);
  });

  /** Helper: hire an agent first so we can remove it. */
  async function hireTestAgent(name: string, role: string): Promise<void> {
    const { runHire } = await import('../packages/squad-cli/src/cli/commands/hire.js');
    await runHire(['--name', name, '--role', role, '--yes']);
  }

  it('archives agent directory (does not delete)', async () => {
    await hireTestAgent('zara', 'backend');
    expect(fs.existsSync(path.join(tmpDir, '.squad', 'agents', 'zara'))).toBe(true);

    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await runRemove(['--agent', 'zara', '--yes']);

    // Original dir gone, archive exists
    expect(fs.existsSync(path.join(tmpDir, '.squad', 'agents', 'zara'))).toBe(false);
    const archiveDir = path.join(tmpDir, '.squad', 'agents', '.archive', 'zara');
    expect(fs.existsSync(archiveDir)).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'charter.md'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, '.archive-manifest.json'))).toBe(true);
  });

  it('updates team.md (row removed)', async () => {
    await hireTestAgent('grace', 'frontend');
    let teamMd = fs.readFileSync(path.join(tmpDir, '.squad', 'team.md'), 'utf8');
    expect(teamMd).toContain('Grace');

    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await runRemove(['--agent', 'grace', '--yes']);

    teamMd = fs.readFileSync(path.join(tmpDir, '.squad', 'team.md'), 'utf8');
    expect(teamMd).not.toContain('Grace');
  });

  it('updates routing.md (entries removed)', async () => {
    await hireTestAgent('hank', 'backend');
    let routingMd = fs.readFileSync(path.join(tmpDir, '.squad', 'routing.md'), 'utf8');
    expect(routingMd).toContain('Hank');

    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await runRemove(['--agent', 'hank', '--yes']);

    routingMd = fs.readFileSync(path.join(tmpDir, '.squad', 'routing.md'), 'utf8');
    expect(routingMd).not.toContain('Hank');
  });

  it('blocks removal of built-in agents (Scribe)', async () => {
    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await expect(runRemove(['--agent', 'scribe', '--yes'])).rejects.toThrow(/cannot remove built-in/i);
  });

  it('blocks removal of built-in agents (Ralph)', async () => {
    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await expect(runRemove(['--agent', 'ralph', '--yes'])).rejects.toThrow(/cannot remove built-in/i);
  });

  it('errors if agent does not exist', async () => {
    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await expect(runRemove(['--agent', 'nonexistent', '--yes'])).rejects.toThrow(/not found/i);
  });

  it('marks agent as archived in registry.json', async () => {
    await hireTestAgent('iris', 'tester');
    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await runRemove(['--agent', 'iris', '--yes']);

    const registry = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.squad', 'casting', 'registry.json'), 'utf8'),
    ) as { agents: Record<string, { status?: string }> };
    expect(registry.agents['iris']!.status).toBe('archived');
  });

  it('creates archive directory with manifest', async () => {
    await hireTestAgent('jack', 'lead');
    const { runRemove } = await import('../packages/squad-cli/src/cli/commands/remove.js');
    await runRemove(['--agent', 'jack', '--yes']);

    const manifestPath = path.join(tmpDir, '.squad', 'agents', '.archive', 'jack', '.archive-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { archived_at: string; agent_name: string };
    expect(manifest.agent_name).toBe('jack');
    expect(manifest.archived_at).toBeTruthy();
  });
});
