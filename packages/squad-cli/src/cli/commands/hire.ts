/**
 * `squad hire` — add a new agent to the team.
 *
 * Non-interactive:
 *   squad hire --name alice --role backend [--scope "API, database"] [--yes]
 *
 * Interactive (no args):
 *   squad hire   → prompts for role, name, scope, confirmation
 *
 * @module cli/commands/hire
 */

import fs from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import {
  listRoles,
  getRoleById,
  searchRoles,
  generateCharterFromRole,
  onboardAgent,
} from '@bradygaster/squad-sdk';

import { detectSquadDir } from '../core/detect-squad-dir.js';
import { readTeamMd, writeTeamMd } from '../core/team-md.js';
import { roleToEmoji } from '../core/cast.js';
import { fatal } from '../core/errors.js';
import { BOLD, RESET, GREEN, DIM, YELLOW } from '../core/output.js';

// ── Helpers ────────────────────────────────────────────────────────

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

/** Normalise an agent name to kebab-case. */
function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Title-case a kebab/snake string. */
function titleCase(str: string): string {
  return str
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Prompt the user and return their answer (empty string if they just hit enter). */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Print a compact role catalog (reuses roles.ts display logic). */
function printRoleCatalog(): void {
  const roles = listRoles();
  const SOFTWARE_CATS = new Set(['engineering', 'quality']);

  const softwareRoles = roles.filter(r => SOFTWARE_CATS.has(r.category));
  const businessRoles = roles.filter(r => !SOFTWARE_CATS.has(r.category));

  const idWidth = Math.max(...roles.map(r => r.id.length), 2);
  const titleWidth = Math.max(...roles.map(r => r.title.length), 5);

  const printRow = (r: (typeof roles)[number]) =>
    console.log(
      `    ${r.emoji.padEnd(3)} ${r.id.padEnd(idWidth)}  ${r.title.padEnd(titleWidth)}  ${DIM}"${r.vibe}"${RESET}`,
    );

  console.log(`\n📦 Available Roles (${roles.length} built-in)\n`);

  if (softwareRoles.length > 0) {
    console.log('  Software Development:');
    for (const r of softwareRoles) printRow(r);
    console.log();
  }
  if (businessRoles.length > 0) {
    console.log('  Business & Operations:');
    for (const r of businessRoles) printRow(r);
    console.log();
  }
}

// ── Main ───────────────────────────────────────────────────────────

export async function runHire(args: string[]): Promise<void> {
  const dest = process.cwd();

  // ── Detect .squad/ ────────────────────────────────────────────
  const squadInfo = detectSquadDir(dest);
  if (!fs.existsSync(squadInfo.path)) {
    fatal('No .squad/ directory found. Run `squad init` first.');
  }
  const squadDir = squadInfo.path;
  const teamRoot = dest;

  // ── Parse flags ───────────────────────────────────────────────
  let nameArg = getFlagValue(args, '--name');
  let roleArg = getFlagValue(args, '--role');
  let scopeArg = getFlagValue(args, '--scope');
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  // ── Interactive mode when name/role are missing ───────────────
  if (!nameArg || !roleArg) {
    printRoleCatalog();

    if (!roleArg) {
      roleArg = await prompt('What role do you need? (role ID or description): ');
      if (!roleArg) fatal('Role is required.');
    }

    if (!nameArg) {
      nameArg = await prompt('What should we call this agent? ');
      if (!nameArg) fatal('Name is required.');
    }

    if (!scopeArg) {
      scopeArg = await prompt('Any specific scope? (optional, press Enter to skip): ');
    }
  }

  // ── Normalise & validate ──────────────────────────────────────
  const agentName = toKebab(nameArg);
  if (!agentName) fatal('Invalid agent name.');

  const agentDir = path.join(squadDir, 'agents', agentName);
  if (fs.existsSync(agentDir)) {
    fatal(`Agent "${agentName}" already exists at ${agentDir}`);
  }

  // Resolve role: catalog ID or free-text
  const catalogRole = getRoleById(roleArg) ?? searchRoles(roleArg)[0];
  const roleTitle = catalogRole ? catalogRole.title : titleCase(roleArg);
  const roleEmoji = catalogRole ? catalogRole.emoji : roleToEmoji(roleArg);
  const displayName = titleCase(agentName);
  const scope = scopeArg || (catalogRole ? catalogRole.expertise.slice(0, 3).join(', ') : roleTitle);

  // ── Confirmation ──────────────────────────────────────────────
  if (!skipConfirm) {
    console.log();
    console.log(`${BOLD}Hiring preview:${RESET}`);
    console.log(`  ${roleEmoji}  ${displayName} — ${roleTitle}`);
    console.log(`     Scope: ${scope}`);
    console.log();
    console.log(`  Will create:`);
    console.log(`    📄 .squad/agents/${agentName}/charter.md`);
    console.log(`    📄 .squad/agents/${agentName}/history.md`);
    console.log(`  Will update:`);
    console.log(`    📋 .squad/team.md`);
    console.log(`    🔀 .squad/routing.md`);
    console.log();

    const answer = await prompt('Create this agent? (y/n): ');
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('Cancelled.');
      return;
    }
  }

  // ── Create agent files ────────────────────────────────────────
  let charterContent: string | null = null;
  if (catalogRole) {
    charterContent = generateCharterFromRole(catalogRole.id, displayName);
  }

  const result = await onboardAgent({
    teamRoot,
    agentName,
    role: catalogRole ? catalogRole.id : roleArg,
    displayName,
    charterTemplate: charterContent ?? undefined,
  });

  // ── Update team.md ────────────────────────────────────────────
  const updatedFiles: string[] = [];
  try {
    const content = readTeamMd(squadDir);
    const newRow = `| ${displayName} | ${roleTitle} | \`.squad/agents/${agentName}/charter.md\` | ✅ Active |`;

    // Find the Members table and append the new row after the last table row
    const membersIdx = content.indexOf('## Members');
    if (membersIdx !== -1) {
      // Find the end of the markdown table (last line starting with |)
      const afterMembers = content.slice(membersIdx);
      const lines = afterMembers.split('\n');
      let lastTableLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.startsWith('|')) {
          lastTableLine = i;
        } else if (lastTableLine > 0 && lines[i]!.trim() !== '') {
          // Non-table, non-empty line after table rows — stop
          break;
        }
      }

      if (lastTableLine > 0) {
        lines.splice(lastTableLine + 1, 0, newRow);
        const before = content.slice(0, membersIdx);
        const updated = before + lines.join('\n');
        writeTeamMd(squadDir, updated);
        updatedFiles.push('.squad/team.md');
      }
    }
  } catch {
    // team.md may not exist yet — that's okay
  }

  // ── Update routing.md ─────────────────────────────────────────
  const routingPath = path.join(squadDir, 'routing.md');
  try {
    if (fs.existsSync(routingPath)) {
      let routingContent = await readFile(routingPath, 'utf8');

      // Build routing entries
      const routingEntries: string[] = [];
      if (catalogRole) {
        // Use first few routing patterns as work types
        const patterns = catalogRole.routingPatterns.slice(0, 3);
        for (const pattern of patterns) {
          routingEntries.push(`| ${pattern} | ${displayName} | — |`);
        }
      } else {
        // Free-text: use scope keywords
        routingEntries.push(`| ${scope} | ${displayName} | — |`);
      }

      // Find the routing table and append entries
      const workTypeIdx = routingContent.indexOf('## Work Type');
      if (workTypeIdx !== -1) {
        const afterSection = routingContent.slice(workTypeIdx);
        const sectionLines = afterSection.split('\n');
        let lastTableLine = -1;
        for (let i = 0; i < sectionLines.length; i++) {
          if (sectionLines[i]!.startsWith('|')) {
            lastTableLine = i;
          } else if (lastTableLine > 0 && sectionLines[i]!.trim() !== '') {
            break;
          }
        }

        if (lastTableLine > 0) {
          sectionLines.splice(lastTableLine + 1, 0, ...routingEntries);
          routingContent = routingContent.slice(0, workTypeIdx) + sectionLines.join('\n');
          await writeFile(routingPath, routingContent, 'utf8');
          updatedFiles.push('.squad/routing.md');
        }
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
      const registry = JSON.parse(raw) as { agents: Record<string, unknown> };
      registry.agents[agentName] = {
        created_at: new Date().toISOString(),
        persistent_name: displayName,
        universe: 'hired',
        status: 'active',
      };
      await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
      updatedFiles.push('.squad/casting/registry.json');
    }
  } catch {
    // registry update is best-effort
  }

  // ── Success output ────────────────────────────────────────────
  console.log();
  console.log(`${GREEN}✅ Hired ${displayName} as ${roleTitle}${RESET}`);
  console.log();
  console.log('Created:');
  for (const f of result.createdFiles) {
    const rel = path.relative(teamRoot, f).replace(/\\/g, '/');
    console.log(`  📄 ${rel}`);
  }
  if (updatedFiles.length > 0) {
    console.log();
    console.log('Updated:');
    for (const f of updatedFiles) {
      const icon = f.includes('team.md') ? '📋' : f.includes('routing') ? '🔀' : '📦';
      console.log(`  ${icon} ${f}`);
    }
  }
  console.log();
  console.log(`Run ${BOLD}squad${RESET} to start working with your updated team.`);
}
