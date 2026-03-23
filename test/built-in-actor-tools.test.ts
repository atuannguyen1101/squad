/**
 * Tests for built-in actor tool restrictions — SDK-enforced role boundaries.
 *
 * "The tool list IS the enforcement mechanism. Instructions are a fallback,
 * not a guarantee." These tests verify that built-in actors (Ben, Coordinator,
 * Sage) receive ONLY the tools required for their role, and are denied access
 * to file, git, and code analysis tools that would let them violate boundaries.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ACTORS,
  getBuiltInActor,
  getBuiltInActorNames,
} from '../packages/squad-sdk/src/agents/built-in-actors.js';
import type { BuiltInActor } from '../packages/squad-sdk/src/agents/built-in-actors.js';

// Tools that enable substantive code/file work — no built-in actor should have these.
const FORBIDDEN_TOOLS = [
  // File system analysis
  'view', 'grep', 'glob', 'cat', 'head', 'tail', 'find', 'ls',
  // Git operations
  'git_log', 'git_diff', 'git_blame', 'git_status', 'git_show',
  // Code modification
  'edit', 'create', 'write', 'insert', 'replace',
  // Shell execution
  'bash', 'powershell', 'shell', 'exec', 'run',
  // Package management
  'npm', 'pip', 'cargo',
];

// ---------------------------------------------------------------------------
// Every built-in actor must declare allowedTools
// ---------------------------------------------------------------------------
describe('Built-in actor tool restrictions', () => {
  it('every built-in actor should have allowedTools defined', () => {
    for (const name of getBuiltInActorNames()) {
      const actor = getBuiltInActor(name);
      expect(actor).toBeDefined();
      expect(actor!.allowedTools, `${name} must have allowedTools`).toBeDefined();
      expect(Array.isArray(actor!.allowedTools), `${name}.allowedTools must be an array`).toBe(true);
      expect(actor!.allowedTools!.length, `${name}.allowedTools must not be empty`).toBeGreaterThan(0);
    }
  });

  it('no built-in actor should have file, git, or shell tools', () => {
    for (const name of getBuiltInActorNames()) {
      const actor = getBuiltInActor(name)!;
      for (const forbidden of FORBIDDEN_TOOLS) {
        expect(
          actor.allowedTools!.includes(forbidden),
          `${name} must NOT have '${forbidden}' in allowedTools`,
        ).toBe(false);
      }
    }
  });

  it('every allowed tool should be a squad_* prefixed tool', () => {
    for (const name of getBuiltInActorNames()) {
      const actor = getBuiltInActor(name)!;
      for (const tool of actor.allowedTools!) {
        expect(tool.startsWith('squad_'), `${name} tool '${tool}' must be squad_* prefixed`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ben — User Liaison: communication and delegation only
// ---------------------------------------------------------------------------
describe('Ben tool restrictions', () => {
  const ben = getBuiltInActor('ben')!;

  it('should have exactly 5 tools', () => {
    expect(ben.allowedTools).toHaveLength(5);
  });

  it('should have squad_route for dispatching work', () => {
    expect(ben.allowedTools).toContain('squad_route');
  });

  it('should have squad_send for messaging agents', () => {
    expect(ben.allowedTools).toContain('squad_send');
  });

  it('should have squad_pulse for status updates', () => {
    expect(ben.allowedTools).toContain('squad_pulse');
  });

  it('should have squad_read_session for reading agent output', () => {
    expect(ben.allowedTools).toContain('squad_read_session');
  });

  it('should have squad_status for checking pool state', () => {
    expect(ben.allowedTools).toContain('squad_status');
  });

  it('should NOT have squad_decide (decisions are for agents, not liaison)', () => {
    expect(ben.allowedTools).not.toContain('squad_decide');
  });

  it('should NOT have squad_memory (history is for agents, not liaison)', () => {
    expect(ben.allowedTools).not.toContain('squad_memory');
  });

  it('should NOT have squad_skill (skills are for agents, not liaison)', () => {
    expect(ben.allowedTools).not.toContain('squad_skill');
  });
});

// ---------------------------------------------------------------------------
// Coordinator — Work Router: routing decisions only
// ---------------------------------------------------------------------------
describe('Coordinator tool restrictions', () => {
  const coordinator = getBuiltInActor('coordinator')!;

  it('should have exactly 3 tools', () => {
    expect(coordinator.allowedTools).toHaveLength(3);
  });

  it('should have squad_pulse for emitting routing decisions', () => {
    expect(coordinator.allowedTools).toContain('squad_pulse');
  });

  it('should have squad_read_session for reading routing context', () => {
    expect(coordinator.allowedTools).toContain('squad_read_session');
  });

  it('should have squad_status for checking agent availability', () => {
    expect(coordinator.allowedTools).toContain('squad_status');
  });

  it('should NOT have squad_route (coordinator decides, does not dispatch)', () => {
    expect(coordinator.allowedTools).not.toContain('squad_route');
  });

  it('should NOT have squad_send (coordinator decides, does not message)', () => {
    expect(coordinator.allowedTools).not.toContain('squad_send');
  });
});

// ---------------------------------------------------------------------------
// Sage — Self-Improvement Analyst: analysis and proposals
// ---------------------------------------------------------------------------
describe('Sage tool restrictions', () => {
  const sage = getBuiltInActor('sage')!;

  it('should have exactly 7 tools', () => {
    expect(sage.allowedTools).toHaveLength(7);
  });

  it('should have squad_decide for proposing decisions', () => {
    expect(sage.allowedTools).toContain('squad_decide');
  });

  it('should have squad_memory for recording learnings', () => {
    expect(sage.allowedTools).toContain('squad_memory');
  });

  it('should have squad_skill for reading and writing skills', () => {
    expect(sage.allowedTools).toContain('squad_skill');
  });

  it('should have squad_proposals for writing improvement proposals', () => {
    expect(sage.allowedTools).toContain('squad_proposals');
  });

  it('should NOT have squad_route (sage analyzes, does not dispatch)', () => {
    expect(sage.allowedTools).not.toContain('squad_route');
  });

  it('should NOT have squad_send (sage analyzes, does not message)', () => {
    expect(sage.allowedTools).not.toContain('squad_send');
  });
});

// ---------------------------------------------------------------------------
// Tool filtering simulation (mirrors getOrCreateSession logic)
// ---------------------------------------------------------------------------
describe('Tool filtering enforcement', () => {
  // Simulate the full tool set an agent session would normally receive
  const allTools = [
    // squad_* tools from ToolRegistry
    { name: 'squad_route' },
    { name: 'squad_send' },
    { name: 'squad_pulse' },
    { name: 'squad_read_session' },
    { name: 'squad_status' },
    { name: 'squad_decide' },
    { name: 'squad_memory' },
    { name: 'squad_skill' },
    // MCP bridge tools (file system, git, etc.)
    { name: 'view' },
    { name: 'edit' },
    { name: 'create' },
    { name: 'grep' },
    { name: 'glob' },
    { name: 'bash' },
    { name: 'git_log' },
    { name: 'git_diff' },
  ];

  // This is the exact filtering logic from agent-lifecycle.ts getOrCreateSession()
  function filterToolsForActor(actorName: string): { name: string }[] {
    const builtIn = getBuiltInActor(actorName);
    if (!builtIn?.allowedTools) return allTools;
    return allTools.filter(t => builtIn.allowedTools!.includes(t.name));
  }

  it('should give Ben only 5 squad_* tools, no file or git tools', () => {
    const benTools = filterToolsForActor('ben');
    expect(benTools).toHaveLength(5);
    expect(benTools.map(t => t.name)).toEqual([
      'squad_route', 'squad_send', 'squad_pulse', 'squad_read_session', 'squad_status',
    ]);
  });

  it('should give Coordinator only 3 squad_* tools', () => {
    const coordTools = filterToolsForActor('coordinator');
    expect(coordTools).toHaveLength(3);
    expect(coordTools.map(t => t.name)).toEqual([
      'squad_pulse', 'squad_read_session', 'squad_status',
    ]);
  });

  it('should give Sage 6 squad_* tools', () => {
    const sageTools = filterToolsForActor('sage');
    expect(sageTools).toHaveLength(6);
    const names = sageTools.map(t => t.name);
    expect(names).toContain('squad_decide');
    expect(names).toContain('squad_memory');
    expect(names).toContain('squad_skill');
    expect(names).not.toContain('view');
    expect(names).not.toContain('bash');
  });

  it('should give workspace agents ALL tools (no restriction)', () => {
    const fensterTools = filterToolsForActor('fenster');
    expect(fensterTools).toHaveLength(allTools.length);
  });

  it('should be case-insensitive via getBuiltInActor', () => {
    const benTools = filterToolsForActor('Ben');
    expect(benTools).toHaveLength(5);
  });

  it('should exclude every MCP bridge tool from built-in actors', () => {
    const mcpToolNames = ['view', 'edit', 'create', 'grep', 'glob', 'bash', 'git_log', 'git_diff'];
    for (const actorName of getBuiltInActorNames()) {
      const tools = filterToolsForActor(actorName);
      const toolNames = tools.map(t => t.name);
      for (const mcpTool of mcpToolNames) {
        expect(toolNames, `${actorName} must not have '${mcpTool}'`).not.toContain(mcpTool);
      }
    }
  });
});
