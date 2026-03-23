/**
 * `squad remove` — remove an agent from the team (archive, don't delete).
 *
 *   squad remove --agent alice [--yes]
 *   squad fire --agent alice [--yes]     (alias wired in cli-entry)
 *
 * @module cli/commands/remove
 */

import fs from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { detectSquadDir } from '../core/detect-squad-dir.js';
import { readTeamMd, writeTeamMd } from '../core/team-md.js';
import { fatal } from '../core/errors.js';
import { BOLD, RESET, GREEN, YELLOW } from '../core/output.js';

// ── Helpers ────────────────────────────────────────────────────────

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Built-in agents that cannot be removed. */
const BUILTIN_AGENTS = new Set(['scribe', 'ralph']);

// ── Main ───────────────────────────────────────────────────────────

export async function runRemove(args: string[]): Promise<void> {
  const dest = process.cwd();

  // ── Detect .squad/ ────────────────────────────────────────────
  const squadInfo = detectSquadDir(dest);
  if (!fs.existsSync(squadInfo.path)) {
    fatal('No .squad/ directory found. Run `squad init` first.');
  }
  const squadDir = squadInfo.path;

  // ── Parse flags ───────────────────────────────────────────────
  const agentArg = getFlagValue(args, '--agent');
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  if (!agentArg) {
    fatal('Usage: squad remove --agent <name> [--yes]');
  }

  const agentName = agentArg.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!agentName) fatal('Invalid agent name.');

  // ── Validate ──────────────────────────────────────────────────
  if (BUILTIN_AGENTS.has(agentName)) {
    fatal(`Cannot remove built-in agent "${agentName}". Built-in agents (Scribe, Ralph) are required for Squad operation.`);
  }

  const agentDir = path.join(squadDir, 'agents', agentName);
  if (!fs.existsSync(agentDir)) {
    fatal(`Agent "${agentName}" not found at ${agentDir}`);
  }

  // Try to detect the agent's role from their charter
  let agentRole = 'Agent';
  const charterPath = path.join(agentDir, 'charter.md');
  try {
    if (fs.existsSync(charterPath)) {
      const charter = fs.readFileSync(charterPath, 'utf8');
      // Parse "# Name — Role" from first line
      const match = charter.match(/^#\s+.+?\s+—\s+(.+)/m);
      if (match?.[1]) {
        agentRole = match[1].trim();
      }
    }
  } catch {
    // best-effort
  }

  const displayName = agentName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  // ── Confirmation ──────────────────────────────────────────────
  if (!skipConfirm) {
    console.log();
    console.log(`${YELLOW}⚠️  Remove ${displayName} (${agentRole})?${RESET}`);
    console.log();
    console.log('  This will:');
    console.log(`    🗑️  Archive .squad/agents/${agentName}/ → .squad/agents/.archive/${agentName}/`);
    console.log(`    📋  Remove from .squad/team.md roster`);
    console.log(`    🔀  Remove routing rules for ${displayName}`);
    console.log();
    console.log('  Agent history will be preserved in the archive.');
    console.log();

    const answer = await prompt('Continue? (y/n): ');
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Cancelled.');
      return;
    }
  }

  // ── Archive agent directory ───────────────────────────────────
  const archiveDir = path.join(squadDir, 'agents', '.archive');
  const archiveDest = path.join(archiveDir, agentName);

  await mkdir(archiveDir, { recursive: true });

  // If archive target exists, remove it first
  if (fs.existsSync(archiveDest)) {
    fs.rmSync(archiveDest, { recursive: true, force: true });
  }

  await rename(agentDir, archiveDest);

  // Write an archive manifest
  const manifestPath = path.join(archiveDest, '.archive-manifest.json');
  const manifest = {
    archived_at: new Date().toISOString(),
    agent_name: agentName,
    role: agentRole,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const updatedFiles: string[] = [];

  // ── Update team.md ────────────────────────────────────────────
  try {
    const content = readTeamMd(squadDir);
    const lines = content.split('\n');
    const filtered = lines.filter(line => {
      // Remove lines that reference this agent in a table row
      if (!line.startsWith('|')) return true;
      const lower = line.toLowerCase();
      // Match on agent name in the row (e.g. "| Alice |" or "| alice |")
      return !lower.includes(`| ${agentName} |`) && !lower.includes(`/${agentName}/`);
    });

    if (filtered.length !== lines.length) {
      writeTeamMd(squadDir, filtered.join('\n'));
      updatedFiles.push('.squad/team.md');
    }
  } catch {
    // team.md may not exist
  }

  // ── Update routing.md ─────────────────────────────────────────
  const routingPath = path.join(squadDir, 'routing.md');
  try {
    if (fs.existsSync(routingPath)) {
      const content = await readFile(routingPath, 'utf8');
      const lines = content.split('\n');
      const updated: string[] = [];
      let changed = false;

      for (const line of lines) {
        if (!line.startsWith('|')) {
          updated.push(line);
          continue;
        }

        const lower = line.toLowerCase();
        const cells = line.split('|').map(c => c.trim());

        // Check if this agent is the Primary (second cell in routing table)
        if (cells.some(c => c.toLowerCase() === displayName.toLowerCase() || c.toLowerCase() === agentName)) {
          // Check if agent is in the "Primary" column — remove the whole row
          // Or if agent is in the "Secondary" column — just clear that cell
          const isPrimary = cells[2]?.toLowerCase() === displayName.toLowerCase() ||
                           cells[2]?.toLowerCase() === agentName;
          const isSecondary = cells[3]?.toLowerCase() === displayName.toLowerCase() ||
                             cells[3]?.toLowerCase() === agentName;

          if (isPrimary) {
            changed = true;
            continue; // skip this row entirely
          } else if (isSecondary) {
            // Clear the secondary cell
            cells[3] = '—';
            updated.push(cells.join(' | '));
            changed = true;
            continue;
          }
        }

        updated.push(line);
      }

      if (changed) {
        await writeFile(routingPath, updated.join('\n'), 'utf8');
        updatedFiles.push('.squad/routing.md');
      }
    }
  } catch {
    // routing.md update is best-effort
  }

  // ── Update casting registry ───────────────────────────────────
  const registryPath = path.join(squadDir, 'casting', 'registry.json');
  try {
    if (fs.existsSync(registryPath)) {
      const raw = await readFile(registryPath, 'utf8');
      const registry = JSON.parse(raw) as { agents: Record<string, { status?: string } & Record<string, unknown>> };
      if (registry.agents[agentName]) {
        registry.agents[agentName]!.status = 'archived';
        registry.agents[agentName]!.archived_at = new Date().toISOString();
        await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
        updatedFiles.push('.squad/casting/registry.json');
      }
    }
  } catch {
    // registry update is best-effort
  }

  // ── Success output ────────────────────────────────────────────
  console.log();
  console.log(`${GREEN}✅ Removed ${displayName} from the team${RESET}`);
  console.log();
  console.log(`Archived to: .squad/agents/.archive/${agentName}/`);
  if (updatedFiles.length > 0) {
    console.log(`Updated: ${updatedFiles.join(', ')}`);
  }
  console.log();
  console.log(`To restore: ${BOLD}squad hire --name ${agentName} --role "${agentRole}"${RESET}`);
}
