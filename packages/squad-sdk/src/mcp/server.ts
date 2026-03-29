/**
 * Squad MCP Server
 *
 * Wraps SquadServer as an MCP stdio server. Copilot spawns this process
 * and discovers user-facing Squad tools:
 * squad_run, squad_ask, squad_respond, squad_wait, squad_status,
 * squad_cancel, squad_analyze_run.
 *
 * Internal tools (squad_dispatch, squad_send, squad_read_session, etc.)
 * are available to agents inside sessions as SquadTools but NOT exposed
 * on the MCP surface.
 */

import { MCPServer } from './protocol.js';
import { SquadServer, type SquadServerConfig } from '../server/index.js';
import { TOOL_CALL_PLACEHOLDER } from '../server/agent-lifecycle.js';
import type { SquadConfig } from '../runtime/config.js';
import { createPulse, formatPulseForUser, type PulsePhase, type PulseStatus } from '../pulse/index.js';
import { createEmptyIntentGraph, serializeIntentGraph, updateIntentGraph, parseUnderstandPhaseOutput, parseRoutePhaseOutput, type IntentGraph } from '../intent/index.js';
import { PipelineRunner, parseRoutingDecision, generateImplPhases, isValidRoutingResponse, type PipelineDefinition, type PipelineRunnerDeps } from '../pipeline/index.js';
import { analyzeRun, formatAnalysisReport, type SessionSnapshot } from './analyze-run.js';
import { triggerAutoSageAnalysis } from './auto-sage.js';
import { resolveDashboardPort, persistPort, clearPersistedPort } from './dashboard-port.js';
import { parseCharterMetadata } from '../config/agent-source.js';
import { RunContextManager } from './run-context.js';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Default set of tools exposed on the MCP surface.
 * These are user-facing tools that Copilot can discover and invoke.
 */
export const DEFAULT_PUBLIC_TOOLS = new Set([
  'squad_run',
  'squad_ask',
  'squad_respond',
  'squad_wait',
  'squad_status',
  'squad_cancel',
  'squad_analyze_run',
] as const);

/**
 * Internal tools available to agents but not exposed via MCP.
 * These are used for agent-to-agent coordination inside sessions.
 */
export const INTERNAL_TOOLS = new Set([
  'squad_dispatch',
  'squad_send',
  'squad_read_session',
  'squad_close_session',
  'squad_pulse',
  'squad_roster',
  'squad_list_agents',
  'squad_monitor',
  'squad_memory',
  'squad_decide',
  'squad_intent',
  'squad_wait_for_idle',
] as const);

/**
 * All available tools (public + internal).
 * Use this to expose all tools for testing or advanced scenarios.
 */
export const ALL_TOOLS = new Set([
  ...DEFAULT_PUBLIC_TOOLS,
  ...INTERNAL_TOOLS,
] as const);


export interface SquadMCPServerOptions {
  /** Squad root directory */
  squadRoot: string;
  /** Squad configuration */
  squadConfig?: SquadConfig;
  /** Server name for MCP */
  serverName?: string;
  /** Server version for MCP */
  serverVersion?: string;
  /**
   * Override which tools are exposed on the MCP surface for Copilot discovery.
   * By default, only user-facing tools are public (squad_run, squad_ask, etc.).
   * Internal coordination tools (squad_dispatch, squad_send, etc.) remain available
   * to agents inside sessions but are not exposed via MCP.
   * 
   * Set this to customize tool visibility for specific deployment scenarios.
   */
  publicTools?: Set<string>;
}

/**
 * Cache for agent role metadata.
 * Key: agentName, Value: { role, isPlannerRole, isDocWriterRole }
 */
const agentRoleCache = new Map<string, { role: string; isPlannerRole: boolean; isDocWriterRole: boolean }>();

/**
 * Helper to detect if an agent is a planner/lead/orchestrator.
 * These roles produce planning output rather than code.
 */
function createIsPlannerRoleDetector(squadRoot: string): (agentName: string) => boolean {
  return (agentName: string) => {
    if (agentRoleCache.has(agentName)) {
      return agentRoleCache.get(agentName)!.isPlannerRole;
    }
    
    const charterPath = path.join(squadRoot, '.squad', 'agents', agentName, 'charter.md');
    try {
      const content = fs.readFileSync(charterPath, 'utf-8');
      const metadata = parseCharterMetadata(content);
      const role = metadata.role?.toLowerCase() ?? '';
      
      // Planner/lead/orchestrator roles: produce planning output
      const isPlannerRole = role.includes('lead') || 
                           role.includes('planner') || 
                           role.includes('orchestrator') ||
                           role.includes('coordinator') ||
                           role.includes('architect');
      
      // Doc writer roles: produce documentation, not code
      const isDocWriterRole = role.includes('devrel') ||
                             role.includes('technical writer') ||
                             role.includes('documentation') ||
                             role.includes('docs');
      
      agentRoleCache.set(agentName, { role, isPlannerRole, isDocWriterRole });
      return isPlannerRole;
    } catch {
      return false; // Charter not found or unreadable - assume code implementer
    }
  };
}

/**
 * Helper to detect if an agent is a doc writer.
 * These roles produce documentation rather than code.
 */
function createIsDocWriterRoleDetector(squadRoot: string): (agentName: string) => boolean {
  return (agentName: string) => {
    if (agentRoleCache.has(agentName)) {
      return agentRoleCache.get(agentName)!.isDocWriterRole;
    }
    
    const charterPath = path.join(squadRoot, '.squad', 'agents', agentName, 'charter.md');
    try {
      const content = fs.readFileSync(charterPath, 'utf-8');
      const metadata = parseCharterMetadata(content);
      const role = metadata.role?.toLowerCase() ?? '';
      
      // Planner/lead/orchestrator roles: produce planning output
      const isPlannerRole = role.includes('lead') || 
                           role.includes('planner') || 
                           role.includes('orchestrator') ||
                           role.includes('coordinator') ||
                           role.includes('architect');
      
      // Doc writer roles: produce documentation, not code
      const isDocWriterRole = role.includes('devrel') ||
                             role.includes('technical writer') ||
                             role.includes('documentation') ||
                             role.includes('docs');
      
      agentRoleCache.set(agentName, { role, isPlannerRole, isDocWriterRole });
      return isDocWriterRole;
    } catch {
      return false; // Charter not found or unreadable - assume code implementer
    }
  };
}

export async function createSquadMCPServer(options: SquadMCPServerOptions): Promise<void> {
  const mcp = new MCPServer(
    options.serverName ?? 'squad-orchestration-server',
    options.serverVersion ?? '0.8.25',
  );

  // Create SquadServer (connects to Copilot backend)
  const serverConfig: SquadServerConfig = {
    squadConfig: options.squadConfig ?? {
      version: '1',
      models: {
        defaultModel: 'claude-sonnet-4.5',
        defaultTier: 'standard',
        fallbackChains: { premium: [], standard: [], fast: [] },
      },
      routing: { rules: [] },
    } satisfies SquadConfig,
    squadRoot: options.squadRoot,
    enableRemote: false, // No WebSocket for MCP mode
  };
  const server = new SquadServer(serverConfig);

  let started = false;
  let serverStartTime = Date.now();
  let dashboardUrl: string | null = null;

  // Lazy start — connect to Copilot on first dispatch
  async function ensureStarted(): Promise<void> {
    if (!started) {
      try {
        await server.start();
        started = true;
        serverStartTime = Date.now();
        process.stderr.write('[squad-mcp] Server connected to Copilot backend\n');
      } catch (err) {
        process.stderr.write(`[squad-mcp] Failed to start: ${err instanceof Error ? err.message : err}\n`);
        throw err;
      }
    }
  }

  // --- Register tools ---
  //
  // Tool Visibility Strategy:
  // =========================
  // USER-FACING TOOLS (exposed on MCP surface for Copilot discovery):
  //   - squad_run: Start a new coordinated agent run through Ben
  //   - squad_ask: Send a follow-up question to a running squad
  //   - squad_respond: Respond to a question from the squad
  //   - squad_wait: Wait for all agents to reach idle or specific status
  //   - squad_status: Get server status and dashboard URL
  //   - squad_cancel: Cancel a running session
  //   - squad_analyze_run: Analyze completed run and generate report
  //
  // INTERNAL TOOLS (NOT exposed on MCP surface, available as SquadTools for agent sessions):
  //   - squad_dispatch: Agent-to-agent task routing
  //   - squad_send: Agent-to-agent synchronous communication
  //   - squad_read_session: Agent session history inspection
  //   - squad_close_session: Session lifecycle management
  //   - squad_pulse: Status update reporting
  //   - squad_roster: Team roster access
  //   - squad_list_agents: Agent discovery
  //   - squad_monitor: Session monitoring
  //   - squad_memory: Agent memory management
  //   - squad_decide: Decision recording
  //   - squad_intent: Intent graph state management
  //   - squad_wait_for_idle: Internal coordination primitive
  //
  // IMPLEMENTATION PATTERN:
  // -----------------------
  // All tools are defined using registerTool(), which checks the publicTools set.
  // - If a tool is in publicTools → registered with MCP (Copilot can discover it)
  // - If NOT in publicTools → handler exists but not exposed on MCP surface
  //
  // This replaces the old if(false) pattern, which was dead code vulnerable to
  // refactoring errors. The new pattern is configuration-driven and type-safe.
  //
  // To expose internal tools (e.g., for testing or advanced scenarios), pass
  // a custom publicTools Set via SquadMCPServerOptions.publicTools.

  // Define which tools are exposed on the MCP surface
  // Can be overridden via options.publicTools for custom deployments
  const publicTools = options.publicTools ?? DEFAULT_PUBLIC_TOOLS;

  /**
   * Helper to conditionally register tools based on visibility configuration.
   * 
   * All tools are defined via this function. If a tool's name is in the publicTools
   * set, it gets registered with the MCP server (making it discoverable by Copilot).
   * If not in the set, the handler is defined but not exposed - it remains available
   * to agents inside sessions via the SquadTools interface.
   * 
   * This pattern ensures all tools have consistent implementations while allowing
   * flexible visibility control without dead code branches.
   */
  const registerTool = (
    schema: {
      name: string;
      description: string;
      inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
      };
    },
    handler: (args: Record<string, any>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
  ) => {
    if (publicTools.has(schema.name)) {
      mcp.addTool(schema, handler);
    }
    // Internal tools remain defined for documentation but are not registered
  };

  // squad_dispatch: Send work to a named agent [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_dispatch',
      description: 'Send a task to a named squad agent. Creates or reuses a persistent session for the agent, compiles their charter, and sends the message. Use this when one agent needs another agent to do work.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the target agent (e.g., "fenster", "keaton")' },
          message: { type: 'string', description: 'The task or message to send to the agent' },
          context: { type: 'string', description: 'Optional additional context' },
        },
        required: ['agentName', 'message'],
      },
    },
    async (args) => {
      await ensureStarted();
      trackAgentMessage(args.agentName);
      const result = await server.dispatch(args.agentName, args.message, args.context);
      const resolvedNote = result.agentName !== args.agentName
        ? ` (resolved "${args.agentName}" → "${result.agentName}")`
        : '';
      return {
        content: [{
          type: 'text',
          text: `Dispatched to ${result.agentName}${resolvedNote} (session: ${result.sessionId}, status: ${result.status})`,
        }],
      };
    },
  );

  // squad_status: Get server status
  registerTool(
    {
      name: 'squad_status',
      description: 'Get the current status of the Squad orchestration server, including active sessions, pool capacity, and agent details.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      if (!started) {
        return {
          content: [{ type: 'text', text: 'Server not started yet. No active sessions.' }],
        };
      }
      const status = server.getStatus();
      const agentList = status.agents.map(a => `  - ${a.agentName}: ${a.charterRole} (session: ${a.sessionId.slice(0, 8)})`).join('\n');

      // Uptime
      const uptimeMs = Date.now() - serverStartTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const uptimeMin = Math.floor(uptimeSec / 60);
      const uptimeStr = uptimeMin > 0
        ? `${uptimeMin}m ${uptimeSec % 60}s`
        : `${uptimeSec}s`;

      // Recent events summary
      const history = server.getEventHistory();
      const recentEvents = history.recent(3);
      const recentSummary = recentEvents.length > 0
        ? recentEvents.map(e => {
          const ts = e.timestamp.slice(11, 19);
          return `  ${ts} ${e.summary}`;
        }).join('\n')
        : '  (none)';

      return {
        content: [{
          type: 'text',
          text: [
            `Squad Server: ${status.running ? 'running' : 'stopped'}`,
            `Uptime: ${uptimeStr}`,
            `Active sessions: ${status.activeSessions}`,
            `Connected: ${status.connectedToHost}`,
            dashboardUrl ? `Dashboard: ${dashboardUrl}` : null,
            `Events recorded: ${history.size}`,
            status.agents.length > 0 ? `Agents:\n${agentList}` : 'No active agents',
            `Recent activity:\n${recentSummary}`,
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  );

  // squad_list_agents: List active agent sessions [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_list_agents',
      description: 'List all active agent sessions managed by the orchestration server.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      if (!started) {
        return { content: [{ type: 'text', text: '[]' }] };
      }
      const mgr = server.getSessionManager();
      const sessions = mgr?.listActiveSessions() ?? [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(sessions, null, 2),
        }],
      };
    },
  );

  // squad_close_session: Close a specific agent session [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_close_session',
      description: 'Close a specific agent session by agent name. The session will be removed from the pool.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the agent whose session to close' },
        },
        required: ['agentName'],
      },
    },
    async (args) => {
      if (!started) {
        return { content: [{ type: 'text', text: `No active session for ${args.agentName}` }] };
      }
      const mgr = server.getSessionManager();
      await mgr?.closeSession(args.agentName);
      return {
        content: [{ type: 'text', text: `Session closed for ${args.agentName}` }],
      };
    },
  );

  // squad_monitor: Get recent server events for monitoring/debugging [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_monitor',
      description: 'Get recent server events and activity. Shows what agents have been doing, session lifecycle events, errors, and routing decisions. Use for monitoring and debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of recent events to return (default: 20, max: 100)' },
          agentName: { type: 'string', description: 'Filter events by agent name' },
          type: { type: 'string', description: 'Filter events by type (e.g., "session", "dispatch", "error")' },
        },
      },
    },
    async (args) => {
      if (!started) {
        return { content: [{ type: 'text', text: 'Server not started yet. No events recorded.' }] };
      }
      const history = server.getEventHistory();
      const events = history.recent(
        Math.min(args.count || 20, 100),
        { type: args.type, agentName: args.agentName },
      );

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No events recorded yet.' }] };
      }

      const lines = events.map(e => {
        const ts = e.timestamp.slice(11, 19); // HH:MM:SS
        const agent = e.agentName ? ` [${e.agentName}]` : '';
        return `${ts}${agent} ${e.summary}`;
      });

      return {
        content: [{
          type: 'text',
          text: `Recent events (${events.length}/${history.size} total):\n${lines.join('\n')}`,
        }],
      };
    },
  );

  // squad_roster: Discover available agents from .squad/agents/ [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_roster',
      description: 'List all available squad agents with their roles, expertise, and model preferences. Reads from .squad/agents/ charters. Use this to discover who is on the team before dispatching.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const agentsDir = path.join(options.squadRoot, '.squad', 'agents');
      try {
        const dirs = fs.readdirSync(agentsDir, { withFileTypes: true })
          .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'))
          .map((d: any) => d.name as string);

        const roster: string[] = [];
        for (const name of dirs) {
          const charterPath = path.join(agentsDir, name, 'charter.md');
          try {
            const content = fs.readFileSync(charterPath, 'utf-8');
            const roleMatch = content.match(/^#\s+.+?\s*[-—]\s*(.+)/m)
              || content.match(/\*\*Role:\*\*\s*(.+)/m)
              || content.match(/Role:\s*(.+)/m);
            const role = roleMatch?.[1]?.trim() ?? 'agent';

            const expertiseMatch = content.match(/\*\*Expertise:\*\*\s*(.+)/m);
            const expertise = expertiseMatch?.[1]?.trim() ?? '';

            const modelMatch = content.match(/Preferred:\s*(.+)/m);
            const model = modelMatch?.[1]?.trim() ?? 'auto';

            roster.push(`  ${name}: ${role}${expertise ? ' | ' + expertise : ''}${model !== 'auto' ? ' [model: ' + model + ']' : ''}`);
          } catch {
            roster.push(`  ${name}: (no charter)`);
          }
        }

        // Also read team.md for the full roster table if it exists
        const teamPath = path.join(options.squadRoot, '.squad', 'team.md');
        let teamInfo = '';
        try {
          const teamContent = fs.readFileSync(teamPath, 'utf-8');
          const membersMatch = teamContent.match(/## Members[\s\S]*?(\|[\s\S]*?\|)/);
          if (membersMatch) teamInfo = '\n\nTeam table from team.md:\n' + membersMatch[0].slice(0, 1000);
        } catch { /* no team.md */ }

        return {
          content: [{
            type: 'text',
            text: roster.length > 0
              ? `Available agents (${roster.length}):\n${roster.join('\n')}${teamInfo}`
              : 'No agents found in .squad/agents/',
          }],
        };
      } catch {
        return {
          content: [{ type: 'text', text: 'Could not read .squad/agents/ — is this a squad-enabled repo?' }],
        };
      }
    },
  );

  // --- Graceful shutdown ---

  // squad_send: Send a message and wait for the agent's response [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_send',
      description: 'Send a message to an existing agent session and wait for their response. Use this for synchronous back-and-forth communication between agents. The agent must already have an active session (created via squad_dispatch). Returns the agent\'s full response text.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the target agent (must have an active session)' },
          message: { type: 'string', description: 'The message to send to the agent' },
        },
        required: ['agentName', 'message'],
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      trackAgentMessage(args.agentName);
      try {
        const response = await mgr.sendFollowUp(args.agentName, args.message);
        if (response) {
          return {
            content: [{ type: 'text', text: response }],
          };
        }
        return {
          content: [{ type: 'text', text: `Message sent to ${args.agentName} but no response captured (agent may still be processing). Use squad_read_session to check later.` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Failed to send to ${args.agentName}: ${msg}` }],
        };
      }
    },
  );

  // squad_read_session: Read an agent's conversation history [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_read_session',
      description: 'Read the conversation history of an agent session. Returns all messages (user dispatches and agent responses). Use this to check what an agent has done, read their output, or monitor progress.',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the agent whose session to read' },
          lastN: { type: 'number', description: 'Only return the last N messages (default: all)' },
        },
        required: ['agentName'],
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      const messages = mgr.getMessages(args.agentName);
      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: `No messages found for ${args.agentName}. Agent may not have an active session.` }],
        };
      }

      const sliced = args.lastN ? messages.slice(-args.lastN) : messages;
      const formatted = sliced.map((m, i) => {
        const role = m.role === 'user' ? '→ SENT' : '← REPLY';
        const ts = m.timestamp ? ` (${m.timestamp.slice(11, 19)})` : '';
        const content = m.content.length > 4000
          ? m.content.slice(0, 4000) + '\n... (truncated)'
          : m.content;
        return `[${i + 1}] ${role}${ts}:\n${content}`;
      }).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text',
          text: `Session history for ${args.agentName} (${sliced.length}/${messages.length} messages):\n\n${formatted}`,
        }],
      };
    },
  );

  // squad_decide: Record a team decision [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_decide',
      description: 'Record a team decision to .squad/decisions/inbox/. Decisions are reviewed and merged into decisions.md by the team. Use this when making architectural, design, or process choices that affect other agents.',
      inputSchema: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Agent name making the decision (e.g., "keaton")' },
          summary: { type: 'string', description: 'Brief one-line summary of the decision' },
          body: { type: 'string', description: 'Full decision details and rationale' },
        },
        required: ['author', 'summary', 'body'],
      },
    },
    async (args) => {
      try {
        const inboxDir = path.resolve(options.squadRoot, '.squad', 'decisions', 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const slug = args.summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 50);
        const filename = path.join(inboxDir, `${args.author}-${slug}.md`);

        const content = [
          `### ${timestamp}: ${args.summary}`,
          '',
          `**By:** ${args.author}`,
          `**What:** ${args.body}`,
          '',
        ].join('\n');

        fs.writeFileSync(filename, content, 'utf-8');

        return {
          content: [{ type: 'text', text: `Decision recorded: ${filename}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to write decision: ${err instanceof Error ? err.message : err}` }],
        };
      }
    },
  );

  // squad_memory: Append to agent history [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_memory',
      description: 'Append an entry to an agent\'s history file (.squad/agents/{name}/history.md). Use to record learnings, session outcomes, or important context for future sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Agent name whose history to update' },
          section: { type: 'string', enum: ['learnings', 'updates', 'sessions'], description: 'Section to append to' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['agent', 'section', 'content'],
      },
    },
    async (args) => {
      try {
        const historyFile = path.resolve(options.squadRoot, '.squad', 'agents', args.agent, 'history.md');

        if (!fs.existsSync(historyFile)) {
          return {
            content: [{ type: 'text', text: `History file not found for ${args.agent}. File expected at: ${historyFile}` }],
          };
        }

        const sectionHeader = `## ${args.section.charAt(0).toUpperCase() + args.section.slice(1)}`;
        const timestamp = new Date().toISOString();
        const entry = `\n### ${timestamp}\n${args.content}\n`;

        let fileContent = fs.readFileSync(historyFile, 'utf-8');
        const sectionIndex = fileContent.indexOf(sectionHeader);
        if (sectionIndex !== -1) {
          const nextSectionIndex = fileContent.indexOf('\n## ', sectionIndex + sectionHeader.length);
          const insertIndex = nextSectionIndex === -1 ? fileContent.length : nextSectionIndex;
          fileContent = fileContent.slice(0, insertIndex) + entry + fileContent.slice(insertIndex);
        } else {
          fileContent += `\n${sectionHeader}\n${entry}`;
        }

        fs.writeFileSync(historyFile, fileContent, 'utf-8');

        return {
          content: [{ type: 'text', text: `Appended to ${args.agent} history (${args.section})` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to update history: ${err instanceof Error ? err.message : err}` }],
        };
      }
    },
  );

  let dashServer: http.Server | null = null;
  const shutdown = async () => {
    process.stderr.write('[squad-mcp] Shutting down...\n');
    clearPersistedPort(options.squadRoot);
    if (dashServer) dashServer.close();
    if (started) {
      await server.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Team Ben: Multi-run state management (TODO: complete migration) ---
  const runContextManager = new RunContextManager();

  // Legacy singleton state (will be removed after full migration)
  let activeIntentGraph: IntentGraph | null = null;
  let pendingUserQuestions: string[] = [];
  let waitResolvers: Array<(value: string) => void> = [];
  let activePipelines: PipelineRunner[] = [];
  let activeRunId: string | null = null;

  // Pulse collector
  const pulseCollector = server.getPulseCollector();

  pulseCollector.setOnUserRelevantPulse((pulse) => {
    const questions = pulse.questionsForUser ?? [];
    if (questions.length > 0) {
      pendingUserQuestions.push(...questions);
    }
    const reason = questions.length > 0 ? 'question'
      : pulse.phase === 'done' ? 'done'
      : pulse.status === 'error' ? 'error'
      : 'event';
    for (const resolver of waitResolvers) {
      resolver(reason);
    }
    waitResolvers = [];
  });

  // Wire progress regression detection — log regression events for diagnostics
  pulseCollector.setOnProgressRegression((agent, oldProgress, newProgress) => {
    process.stderr.write(
      `[squad-mcp] Progress regression: ${agent} went from ${oldProgress}% to ${newProgress}%\n`,
    );
  });

  // Wire message count tracking — track dispatches per agent across the session.
  // The PulseCollector emits a warning pulse when an agent exceeds the threshold
  // (default: 25 messages), signaling potential infinite loops or runaway agents.
  const trackAgentMessage = (agentName: string) => {
    pulseCollector.trackMessage(agentName);
  };

  // Helper to resolve RunContext with fallback to most recent run
  const resolveRunContext = (runId?: string) => {
    if (runId) {
      const context = runContextManager.get(runId);
      if (!context) {
        throw new Error(`Run ${runId} not found`);
      }
      return context;
    }
    const context = runContextManager.getMostRecent();
    if (!context) {
      throw new Error('No active run. Use squad_run to start a new run.');
    }
    return context;
  };

  // squad_run: Start a team run via Ben (user-facing entry point)
  registerTool(
    {
      name: 'squad_run',
      description: 'Start a team run through Ben, your team representative. Ben will understand your request, ask clarifying questions if needed, and coordinate the team. This is the primary entry point for all work requests.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What you want the team to do' },
          context: { type: 'string', description: 'Optional additional context (e.g., relevant files, constraints)' },
        },
        required: ['message'],
      },
    },
    async (args) => {
      if (activeRunId) {
        return {
          content: [{
            type: 'text',
            text: `A run is already active (${activeRunId}). Use squad_cancel to stop it first, or squad_wait to monitor progress.`,
          }],
        };
      }

      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      const runId = `run-${Date.now()}`;
      activeRunId = runId;
      
      // Create RunContext for multi-run support (currently only tracked, not fully used)
      const runContext = runContextManager.create(runId, args.message);
      
      activeIntentGraph = createEmptyIntentGraph(args.message);
      pulseCollector.clear();
      server.getScratchpad().clear();
      pendingUserQuestions = [];
      activePipelines = [];

      const contextAddendum = args.context
        ? `\n\nAdditional context from user:\n${args.context}`
        : '';

      const agentsDir = path.join(options.squadRoot, '.squad', 'agents');
      let agentRoster: { name: string; role: string }[] = [];
      try {
        const dirs = fs.readdirSync(agentsDir, { withFileTypes: true })
          .filter((d: any) => d.isDirectory() && !d.name.startsWith('_'));
        for (const d of dirs) {
          const charterPath = path.join(agentsDir, d.name as string, 'charter.md');
          try {
            const content = fs.readFileSync(charterPath, 'utf-8');
            const roleMatch = content.match(/\*\*Role:\*\*\s*(.+)/m)
              || content.match(/Role:\s*(.+)/m)
              || content.match(/^#\s+.+?\s*[-—]\s*(.+)/m);
            agentRoster.push({ name: d.name as string, role: roleMatch?.[1]?.trim() ?? '' });
          } catch { agentRoster.push({ name: d.name as string, role: '' }); }
        }
      } catch { /* no agents dir */ }

      if (agentRoster.length === 0) {
        return {
          content: [{ type: 'text', text: 'No agents found. Create at least one agent with a charter in .squad/agents/ before running.' }],
        };
      }

      let routingContext = '';
      try {
        const routingPath = path.join(options.squadRoot, '.squad', 'routing.md');
        routingContext = fs.readFileSync(routingPath, 'utf-8');
      } catch { /* no routing.md */ }

      const rosterSummary = agentRoster.map(a => `- ${a.name}: ${a.role}`).join('\n');

      const waitForResponse = async (agentName: string, timeoutMs: number): Promise<string | null> => {
        let currentCount = mgr.getMessages(agentName, runId).filter((m: any) => m.role === 'assistant').length;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const msgs = mgr.getMessages(agentName, runId);
          const replies = msgs.filter((m: any) => m.role === 'assistant');
          if (replies.length > currentCount) {
            // If the agent asked questions via pulse, don't accept this reply yet.
            // Wait for the user to respond (squad_respond clears pendingUserQuestions),
            // then capture the agent's NEXT reply after Q&A resolution.
            if (runContext.pendingUserQuestions.length > 0) {
              currentCount = replies.length;
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
            return replies[replies.length - 1]?.content ?? null;
          }
          await new Promise(r => setTimeout(r, 3000));
        }
        return null;
      };

      const pipelineDeps: PipelineRunnerDeps = {
        dispatch: async (agentName: string, task: string, context?: string) => {
          trackAgentMessage(agentName);
          const result = await mgr.dispatch(agentName, task, context, runId);
          // Grab the latest assistant reply captured by sendAndWait in dispatch
          const msgs = mgr.getMessages(agentName, runId);
          const lastReply = msgs.filter((m: any) => m.role === 'assistant').pop();
          
          // AUTO-EMIT DONE PULSE: After agent completes, emit completion signal
          // so gates have completion data without requiring agents to call squad_pulse manually.
          const responseContent = lastReply?.content ?? '';
          const derivedSummary = responseContent.length > 100 
            ? responseContent.substring(0, 97) + '...' 
            : responseContent || 'Work completed';
          
          runContext.pulseCollector.record(createPulse({
            agent: result.agentName,
            phase: 'done',
            status: 'ok',
            progressPct: 100,
            summary: derivedSummary,
            blockers: [],
            questionsForUser: [],
            artifacts: [],
            nextStep: '',
          }));
          
          return {
            sessionId: result.sessionId,
            status: result.status,
            agentName: result.agentName,
            response: lastReply?.content ?? undefined,
          };
        },
        waitForResponse,
        onPhaseStart: (phaseId: string, agent: string) => {
          runContext.pulseCollector.record(createPulse({
            agent, phase: 'starting', status: 'ok', progressPct: 0,
            summary: `Phase ${phaseId} starting`, blockers: [], questionsForUser: [],
            artifacts: [], nextStep: phaseId,
          }));
        },
        onPhaseComplete: (result) => {
          // Include agent response in pulse so findings surface through squad_wait
          const agentResponse = typeof result.output === 'string' && result.output.length > 0
            ? result.output.slice(0, 500) + (result.output.length > 500 ? '\n...(truncated)' : '')
            : '';
          const summary = result.error
            ? result.error
            : agentResponse
              ? `${agentResponse}`
              : `Phase ${result.phaseId} completed`;

          runContext.pulseCollector.record(createPulse({
            agent: result.agent,
            phase: result.status === 'completed' ? 'done' : 'blocked',
            status: result.status === 'completed' ? 'ok' : 'error',
            progressPct: result.status === 'completed' ? 100 : 0,
            summary,
            blockers: result.error ? [result.error] : [],
            questionsForUser: [], artifacts: [], nextStep: '',
          }));

          // --- Intent Graph updates at key milestones ---
          if (result.status === 'completed' && runContext.intentGraph && typeof result.output === 'string') {
            if (result.phaseId === 'understand') {
              const updates = parseUnderstandPhaseOutput(result.output);
              runContext.intentGraph = updateIntentGraph(runContext.intentGraph, updates);
              activeIntentGraph = runContext.intentGraph; // Keep legacy in sync
            } else if (result.phaseId === 'route') {
              const updates = parseRoutePhaseOutput(result.output);
              runContext.intentGraph = updateIntentGraph(runContext.intentGraph, updates);
              activeIntentGraph = runContext.intentGraph; // Keep legacy in sync
            }
          }
        },
        onPipelineComplete: (state) => {
          // Only emit a progress pulse here — this is the understand+route
          // pipeline, NOT the full run.  The real "done" pulse is emitted
          // after the impl+review pipeline finishes (see below).
          runContext.pulseCollector.record(createPulse({
            agent: 'ben', phase: state.status === 'completed' ? 'implementing' : 'blocked',
            status: state.status === 'completed' ? 'ok' : 'error',
            progressPct: state.status === 'completed' ? 30 : 100,
            summary: state.status === 'completed'
              ? 'Routing complete. Starting implementation pipeline.'
              : 'Routing failed. Check phase results.',
            blockers: [], questionsForUser: [], artifacts: [], nextStep: '',
          }));
        },
      };

      const phases: import('../pipeline/types.js').PhaseDefinition[] = [
        {
          id: 'understand',
          agent: 'ben',
          task: [
            'A user has a new request. Understand it deeply.',
            'If anything is unclear, use squad_pulse with questionsForUser.',
            'Respond with a clear summary of what needs to be done.',
            'Do NOT dispatch to any agents. Just understand and summarize.',
            '',
            `User request: ${args.message}${contextAddendum}`,
          ].join('\n'),
          gate: {
            validate: (o: unknown) => {
              if (typeof o === 'string' && (o as string).length > 20) return true;
              // Fallback: check if agent emitted a done pulse (auto-emitted by dispatch)
              const benPulses = pulseCollector.getByAgent('ben');
              return benPulses.some((p: any) => p.phase === 'done' && p.progressPct === 100);
            },
            description: 'Ben must produce a substantive understanding',
          },
          timeout: 120_000,
        },
        {
          id: 'route',
          agent: 'coordinator',
          task: [
            'Pick the best agents from this workspace roster to implement and optionally review the following task.',
            '',
            `Task: ${args.message}${contextAddendum}`,
            '',
            'Available agents:',
            rosterSummary,
            '',
            routingContext ? `Routing rules:\n${routingContext.slice(0, 4000)}` : 'No routing.md found.',
            '',
            'Respond with ONLY a JSON object, nothing else.',
            '',
            'For a simple task (single concern), use:',
            '{"implementer": "agent_name", "reviewer": "agent_name"}',
            'Or if routing rules say no review is needed:',
            '{"implementer": "agent_name", "reviewer": null}',
            '',
            'For a multi-part task with independent parts that different agents can handle in parallel, use:',
            '{"subtasks": [{"agent": "agent_a", "task": "part 1 description"}, {"agent": "agent_b", "task": "part 2 description"}], "reviewer": "agent_name"}',
            'Or without review:',
            '{"subtasks": [...], "reviewer": null}',
            '',
            'Pick the agent whose role best matches the task. If routing rules specify a mandatory reviewer, always assign one. Read the routing rules carefully.',
          ].join('\n'),
          dependsOn: ['understand'],
          gate: {
            validate: isValidRoutingResponse,
            description: 'Coordinator must return valid JSON with implementer (required) and optional reviewer',
          },
          timeout: 60_000,
        },
      ];

      const pipelineDefinition: PipelineDefinition = {
        id: runId,
        name: 'Team Ben Run',
        phases,
      };

      const pipeline = new PipelineRunner(pipelineDefinition, pipelineDeps);
      runContext.activePipelines.push(pipeline);
      activePipelines.push(pipeline); // Keep legacy in sync

      pipeline.run().then(async (state) => {
        const routeResult = state.phaseResults.get('route');
        if (routeResult?.status !== 'completed' || !routeResult.output) return;

        // --- Parse Coordinator response and generate implementation phases ---
        const routingDecision = parseRoutingDecision(routeResult.output as string);
        if (!routingDecision) return;

        // Apply defaultReviewer if coordinator returned null and config specifies one
        if (routingDecision.reviewer === null && options.squadConfig?.routing?.defaultReviewer) {
          const defaultRev = options.squadConfig.routing.defaultReviewer.toLowerCase();
          if (routingDecision.kind === 'single') {
            routingDecision.reviewer = defaultRev;
          } else if (routingDecision.kind === 'multi') {
            routingDecision.reviewer = defaultRev;
          }
        }

        const revName = routingDecision.reviewer;
        
        // Create role detectors for gate validation
        const isPlannerRole = createIsPlannerRoleDetector(options.squadRoot);
        const isDocWriterRole = createIsDocWriterRoleDetector(options.squadRoot);

        const implPhases = generateImplPhases(routingDecision, {
          message: args.message,
          contextAddendum,
          toolCallPlaceholder: TOOL_CALL_PLACEHOLDER,
          hasDonePulse: (agentName: string) => {
            const agentPulses = runContext.pulseCollector.getByAgent(agentName);
            return agentPulses.some(p => p.phase === 'done');
          },
          isPlannerRole,
          isDocWriterRole,
          timeout: 300_000,
        });

        const implPipelineDeps: PipelineRunnerDeps = {
          ...pipelineDeps,
          dispatch: async (agentName: string, task: string, context?: string) => {
            trackAgentMessage(agentName);
            const result = await mgr.dispatch(agentName, task, context, runId);
            
            // CRITICAL: Do NOT call waitForDonePulse here (landmine #1 - causes deadlock)
            // Instead, emit the done pulse immediately after dispatch returns
            const msgs = mgr.getMessages(agentName, runId);
            const lastReply = msgs.filter((m: any) => m.role === 'assistant').pop();
            
            // AUTO-EMIT DONE PULSE immediately after dispatch
            const responseContent = lastReply?.content ?? '';
            const derivedSummary = responseContent.length > 100
              ? responseContent.substring(0, 97) + '...'
              : responseContent || 'Work completed';
            runContext.pulseCollector.record(createPulse({
              agent: agentName,
              phase: 'done',
              status: 'ok',
              progressPct: 100,
              summary: derivedSummary,
              blockers: [],
              questionsForUser: [],
              artifacts: [],
              nextStep: '',
            }));
            
            return {
              sessionId: result.sessionId,
              status: result.status,
              agentName: result.agentName,
              response: lastReply?.content ?? undefined,
            };
          },
        };

        const implPipeline = new PipelineRunner(
          { id: `impl-${Date.now()}`, name: 'Implementation', phases: implPhases },
          implPipelineDeps,
        );
        runContext.activePipelines.push(implPipeline);
        activePipelines.push(implPipeline); // Keep legacy in sync
        const implState = await implPipeline.run();

        // Emit the REAL "Pipeline complete" pulse — all four phases
        // (understand, route, implement, review) have now finished.
        // This is the signal that squad_wait should wake on.
        runContext.pulseCollector.record(createPulse({
          agent: 'ben', phase: implState.status === 'completed' ? 'done' : 'blocked',
          status: implState.status === 'completed' ? 'ok' : 'error',
          progressPct: 100,
          summary: implState.status === 'completed'
            ? 'Pipeline complete. All phases passed.\n\nUse squad_run or squad_ask for all interactions — Ben is your interface.'
            : 'Pipeline failed. Check phase results.',
          blockers: [], questionsForUser: [], artifacts: [], nextStep: '',
        }));

        // Auto-close run sessions on pipeline completion
        if (mgr) {
          try {
            await mgr.closeRunSessions(runId);
          } catch (err) {
            process.stderr.write(`[squad-mcp] Failed to close run sessions: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }

        // Mark run as completed
        runContextManager.complete(runId);

        // Auto-Sage: fire-and-forget post-processing after pipeline completion.
        // Runs AFTER the "done" pulse so squad_wait is not blocked.
        const autoAnalyze = options.squadConfig?.autoAnalyze ?? false;
        process.stderr.write(`[squad] auto-sage: autoAnalyze=${String(autoAnalyze)}, pipelineStatus=${implState.status}\n`);
        if (implState.status === 'completed' && autoAnalyze) {
          const autoMgr = server.getSessionManager();
          if (!autoMgr) {
            process.stderr.write('[squad] auto-sage: skipped — session manager unavailable\n');
          } else {
            triggerAutoSageAnalysis({
              pulseCollector: runContext.pulseCollector,
              listActiveSessions: () => autoMgr.listActiveSessions().filter(s => s.runId === runId),
              getMessages: (agentName: string) => autoMgr.getMessages(agentName, runId),
              dispatch: async (agentName: string, message: string, context?: string) => {
                const result = await mgr.dispatch(agentName, message, context, runId);
                const msgs = autoMgr.getMessages(agentName, runId);
                const lastReply = msgs.filter((m: any) => m.role === 'assistant').pop();
                return { response: lastReply?.content ?? undefined };
              },
              squadRoot: options.squadRoot,
            }).catch((err: unknown) => {
              // Auto-analysis errors are non-fatal but must not be silent
              process.stderr.write(`[squad] auto-sage: triggerAutoSageAnalysis failed: ${err instanceof Error ? err.message : String(err)}\n`);
            });
          }
        }
      }).catch((err) => {
        runContext.pulseCollector.record(createPulse({
          agent: 'ben', phase: 'blocked', status: 'error', progressPct: 100,
          summary: `Pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
          blockers: [String(err)], questionsForUser: [], artifacts: [], nextStep: '',
        }));
      }).finally(() => {
        activeRunId = null;
      });

      return {
        content: [{
          type: 'text',
          text: [
            `Pipeline started: understand(ben) → route(coordinator) → implement + review (selected by coordinator)`,
            `Intent: ${args.message}`,
            `Roster: ${rosterSummary.split('\n').length} agents available`,
            dashboardUrl ? `Dashboard: ${dashboardUrl}` : null,
            'Use squad_wait to monitor progress.',
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  );

  // squad_ask: Send a follow-up message to Ben mid-run
  registerTool(
    {
      name: 'squad_ask',
      description: 'Send a follow-up message or answer to Ben during an active run. Use this to answer questions Ben asked, provide additional context, or change direction.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Your message to Ben' },
          runId: { type: 'string', description: 'Optional run ID (defaults to most recent active run)' },
        },
        required: ['message'],
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      try {
        const context = resolveRunContext(args.runId);
        const response = await mgr.sendFollowUp('ben', args.message, context.runId);

        for (const resolver of context.waitResolvers) {
          resolver('user_response');
        }
        context.waitResolvers = [];
        context.pendingUserQuestions = [];

        return {
          content: [{
            type: 'text',
            text: response ?? 'Message sent to Ben.',
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: err instanceof Error ? err.message : 'Failed to send message.',
          }],
        };
      }
    },
  );

  // squad_respond: Answer a specific question from the team
  registerTool(
    {
      name: 'squad_respond',
      description: 'Answer a pending question from the team. Use this when squad_wait returns questions that need your input.',
      inputSchema: {
        type: 'object',
        properties: {
          answer: { type: 'string', description: 'Your answer to the team\'s question' },
          runId: { type: 'string', description: 'Optional run ID (defaults to most recent active run)' },
        },
        required: ['answer'],
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      try {
        const context = resolveRunContext(args.runId);
        
        const questionContext = context.pendingUserQuestions.length > 0
          ? `User answered the following questions: ${context.pendingUserQuestions.map(q => q.question).join('; ')}\n\nAnswer: ${args.answer}`
          : `User response: ${args.answer}`;

        const response = await mgr.sendFollowUp('ben', questionContext, context.runId);

        for (const resolver of context.waitResolvers) {
          resolver('user_response');
        }
        context.waitResolvers = [];
        context.pendingUserQuestions = [];

        return {
          content: [{
            type: 'text',
            text: response ?? 'Response delivered to Ben.',
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: err instanceof Error ? err.message : 'Failed to send response.',
          }],
        };
      }
    },
  );

  // squad_pulse: Agents emit structured status updates [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_pulse',
      description: 'Emit a structured status update (Pulse). Use this at milestones to report progress, ask questions, or signal completion. The coordinator will route user-relevant pulses to Ben automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Your agent name' },
          phase: { type: 'string', enum: ['starting', 'analyzing', 'implementing', 'testing', 'reviewing', 'done', 'blocked'], description: 'Current phase' },
          status: { type: 'string', enum: ['ok', 'warning', 'error'], description: 'Status level' },
          progressPct: { type: 'number', description: 'Progress percentage (0-100)' },
          summary: { type: 'string', description: 'Brief summary of what happened' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'List of blockers (empty if none)' },
          questionsForUser: { type: 'array', items: { type: 'string' }, description: 'Questions that need user input (empty if none)' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Files or outputs produced (empty if none)' },
          nextStep: { type: 'string', description: 'What you will do next' },
        },
        required: ['agent', 'phase', 'status', 'progressPct', 'summary'],
      },
    },
    async (args) => {
      const pulse = createPulse({
        agent: args.agent,
        phase: args.phase as PulsePhase,
        status: (args.status ?? 'ok') as PulseStatus,
        progressPct: args.progressPct ?? 0,
        summary: args.summary,
        blockers: args.blockers ?? [],
        questionsForUser: args.questionsForUser ?? [],
        artifacts: args.artifacts ?? [],
        nextStep: args.nextStep ?? '',
      });

      const filter = pulseCollector.record(pulse);

      return {
        content: [{
          type: 'text',
          text: `Pulse recorded: [${pulse.agent}] ${pulse.phase} ${pulse.progressPct}% — ${filter.userRelevant ? '(user-relevant: ' + filter.reason + ')' : '(internal)'}`,
        }],
      };
    },
  );

  // squad_intent: Inspect the current intent graph [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_intent',
      description: 'Return the current Intent Graph for the active run. Shows the parsed goal, constraints, acceptance criteria, task assignments, and status. Useful for inspecting how the team understood your request.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      if (!activeIntentGraph) {
        return {
          content: [{
            type: 'text',
            text: 'No active intent graph. Use squad_run to start a run first.',
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: serializeIntentGraph(activeIntentGraph),
        }],
      };
    },
  );

  // squad_wait: Block until something needs user attention
  registerTool(
    {
      name: 'squad_wait',
      description: 'Wait for a team event that needs your attention — a question from an agent, a milestone, an error, or run completion. Blocks until something happens or timeout. Use this instead of polling squad_status.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', description: 'Maximum wait time in ms (default: 120000 = 2 min)' },
          runId: { type: 'string', description: 'Optional run ID (defaults to most recent active run)' },
        },
      },
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? 120_000;

      try {
        const context = resolveRunContext(args.runId);
        const runPulseCollector = context.pulseCollector;

        const queued = runPulseCollector.drainUserQueue();
        if (queued.length > 0) {
          return {
            content: [{
              type: 'text',
              text: queued.map(p => formatPulseForUser(p)).join('\n\n---\n\n'),
            }],
          };
        }

        let myResolver: ((value: string) => void) | undefined;
        const reason = await Promise.race([
          new Promise<string>(resolve => {
            myResolver = resolve;
            context.waitResolvers.push(resolve);
          }),
          new Promise<string>(resolve => {
            setTimeout(() => resolve('timeout'), timeoutMs);
          }),
        ]);

        if (myResolver) {
          context.waitResolvers = context.waitResolvers.filter(r => r !== myResolver);
        }

        if (reason === 'timeout') {
          const latest = runPulseCollector.getLatestByAgent();
          const summaryLines = [...latest.entries()].map(
            ([agent, p]) => `${agent}: ${p.phase} ${p.progressPct}% — ${p.summary}`,
          );
          return {
            content: [{
              type: 'text',
              text: summaryLines.length > 0
                ? `No user-relevant events in ${timeoutMs / 1000}s. Current status:\n${summaryLines.join('\n')}`
                : `No events in ${timeoutMs / 1000}s. Team may still be working. Use squad_status for details.`,
            }],
          };
        }

        const newPulses = runPulseCollector.drainUserQueue();
        if (newPulses.length > 0) {
          return {
            content: [{
              type: 'text',
              text: newPulses.map(p => formatPulseForUser(p)).join('\n\n---\n\n'),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: context.pendingUserQuestions.length > 0
              ? `Team has questions:\n${context.pendingUserQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n\nUse squad_respond to answer.`
              : `Event received (${reason}). Use squad_status for details.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: err instanceof Error ? err.message : 'Wait failed.',
          }],
        };
      }
    },
  );

  // squad_wait_for_idle: Block until all agent sessions are idle [INTERNAL - Not exposed on MCP]
  registerTool(
    {
      name: 'squad_wait_for_idle',
      description: 'Block until all agent sessions have been idle (no new messages) for the specified duration. Use this to wait for a pipeline run to complete before grading or processing results. Returns a summary of agents and messages when idle.',
      inputSchema: {
        type: 'object',
        properties: {
          idleMs: { type: 'number', description: 'Idle threshold in ms — resolve after this much inactivity (default: 30000)' },
          timeoutMs: { type: 'number', description: 'Maximum wait time in ms before timing out (default: 1800000 = 30 min)' },
        },
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      const idleMs = args.idleMs ?? 30_000;
      const timeoutMs = args.timeoutMs ?? 1_800_000;

      try {
        const result = await mgr.waitForIdle(idleMs, timeoutMs);
        return {
          content: [{
            type: 'text',
            text: [
              `Pipeline idle after ${Math.round(result.durationMs / 1000)}s.`,
              `Active agents: ${result.agents.length > 0 ? result.agents.join(', ') : '(none)'}`,
              `Total messages: ${result.totalMessages}`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Wait failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );

  // squad_cancel: Cancel an active pipeline run
  registerTool(
    {
      name: 'squad_cancel',
      description: 'Cancel an active squad_run pipeline. Cancels all running phases, closes agent sessions, and returns a summary of what was completed before cancellation.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'Optional run ID to cancel (defaults to most recent active run)' },
          all: { type: 'boolean', description: 'If true, cancel all active runs' },
        },
      },
    },
    async (args) => {
      const mgr = started ? server.getSessionManager() : null;
      
      if (args.all) {
        // Cancel all active runs
        const allContexts = runContextManager.getAll().filter(c => c.status === 'active');
        if (allContexts.length === 0) {
          return {
            content: [{ type: 'text', text: 'No active runs to cancel.' }],
          };
        }

        const summaryLines: string[] = [];
        for (const context of allContexts) {
          // Cancel pipelines
          for (const pipeline of context.activePipelines) {
            pipeline.cancel();
            const state = pipeline.getState();
            const completed = [...state.phaseResults.entries()]
              .filter(([, r]) => r.status === 'completed')
              .map(([id]) => id);
            summaryLines.push(`Run ${context.runId}: cancelled (${completed.length} phases completed: ${completed.join(', ') || 'none'})`);
          }

          // Close agent sessions for this run
          if (mgr) {
            try {
              await mgr.closeRunSessions(context.runId);
              summaryLines.push(`Run ${context.runId}: closed agent sessions.`);
            } catch (err) {
              summaryLines.push(`Run ${context.runId}: failed to close sessions: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Resolve waiters and mark as cancelled
          for (const resolver of context.waitResolvers) {
            resolver('cancelled');
          }
          runContextManager.cancel(context.runId);
        }

        return {
          content: [{ type: 'text', text: summaryLines.join('\n') }],
        };
      }

      // Cancel specific run (or most recent)
      try {
        const context = resolveRunContext(args.runId);
        
        if (context.activePipelines.length === 0) {
          return {
            content: [{ type: 'text', text: `Run ${context.runId} has no active pipelines.` }],
          };
        }

        const summaryLines: string[] = [];
        for (const pipeline of context.activePipelines) {
          pipeline.cancel();
          const state = pipeline.getState();
          const completed = [...state.phaseResults.entries()]
            .filter(([, r]) => r.status === 'completed')
            .map(([id]) => id);
          summaryLines.push(`Pipeline ${state.pipelineId}: cancelled (${completed.length} phases completed: ${completed.join(', ') || 'none'})`);
        }

        // Close agent sessions for this run
        if (mgr) {
          try {
            // BLOCKER #6 FIX: Count sessions BEFORE closing them
            const sessionsToClose = mgr.listActiveSessions().filter(s => s.runId === context.runId);
            const sessionCount = sessionsToClose.length;
            
            await mgr.closeRunSessions(context.runId);
            summaryLines.push(`Closed ${sessionCount} agent session(s).`);
          } catch (err) {
            summaryLines.push(`Failed to close sessions: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Clear context state
        context.activePipelines = [];
        context.pendingUserQuestions = [];
        for (const resolver of context.waitResolvers) {
          resolver('cancelled');
        }
        context.waitResolvers = [];

        context.pulseCollector.record(createPulse({
          agent: 'ben', phase: 'done', status: 'warning', progressPct: 100,
          summary: 'Run cancelled by user.',
          blockers: [], questionsForUser: [], artifacts: [], nextStep: '',
        }));

        runContextManager.cancel(context.runId);

        return {
          content: [{ type: 'text', text: summaryLines.join('\n') }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'Cancel failed.' }],
        };
      }
    },
  );

  // squad_analyze_run: Sage's post-run analysis tool
  registerTool(
    {
      name: 'squad_analyze_run',
      description: 'Analyze a completed Squad run. Reads pulse history and agent session messages, then produces a structured report with concrete improvement proposals for charters, routing rules, and SDK config. Intended for post-run retrospectives (Sage).',
      inputSchema: {
        type: 'object',
        properties: {
          agentFilter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of agent names to include. If omitted, all agents are analyzed.',
          },
        },
      },
    },
    async (args) => {
      await ensureStarted();
      const mgr = server.getSessionManager();
      if (!mgr) throw new Error('Server not ready');

      // Gather pulse history
      const collector = server.getPulseCollector();
      let pulses = [...collector.getAll()];

      // Gather session snapshots
      const activeSessions = mgr.listActiveSessions();
      let sessionSnapshots: SessionSnapshot[] = activeSessions.map(info => {
        const messages = mgr.getMessages(info.agentName);
        return {
          agentName: info.agentName,
          messageCount: messages.length,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content.length > 2000 ? m.content.slice(0, 2000) + '…(truncated)' : m.content,
            timestamp: m.timestamp,
          })),
        };
      });

      // Apply agent filter if provided
      if (args.agentFilter && Array.isArray(args.agentFilter) && args.agentFilter.length > 0) {
        const filterSet = new Set(args.agentFilter as string[]);
        pulses = pulses.filter(p => filterSet.has(p.agent));
        sessionSnapshots = sessionSnapshots.filter(s => filterSet.has(s.agentName));
      }

      if (pulses.length === 0 && sessionSnapshots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No run data found. Either no agents have been dispatched, or pulse/session data has been cleared.',
          }],
        };
      }

      const report = analyzeRun({
        pulses,
        sessions: sessionSnapshots,
        squadRoot: options.squadRoot,
      });

      return {
        content: [{
          type: 'text',
          text: formatAnalysisReport(report),
        }],
      };
    },
  );

  // --- Start dashboard HTTP server ---
  const envPort = process.env['SQUAD_DASHBOARD_PORT']
    ? parseInt(process.env['SQUAD_DASHBOARD_PORT'], 10)
    : undefined;
  const configPort = options.squadConfig?.dashboardPort;
  const dashPort = await resolveDashboardPort({
    squadRoot: options.squadRoot,
    configPort: typeof configPort === 'number' ? configPort : undefined,
    envPort: Number.isNaN(envPort) ? undefined : envPort,
  });
  const dashboardPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
    '..', '..', '..', 'squad-cli', 'src', 'dashboard', 'index.html',
  );
  // Also check dist-relative path for when running from compiled output
  const distDashPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
    '..', '..', '..', '..', 'squad-cli', 'src', 'dashboard', 'index.html',
  );
  const htmlPath = fs.existsSync(dashboardPath) ? dashboardPath : fs.existsSync(distDashPath) ? distDashPath : null;

  if (htmlPath) {
    dashServer = http.createServer(async (req, res) => {
      // CORS for all API routes
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end();
        return;
      }
      const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(htmlPath).pipe(res);
      } else if (req.url === '/api/status') {
        const st = started ? server.getStatus() : { running: false, activeSessions: 0, agents: [], poolCapacity: 0, connectedToHost: false };
        const history = started ? server.getEventHistory() : null;
        res.writeHead(200, cors);
        res.end(JSON.stringify({
          ...st,
          started,
          uptime: started ? Math.floor((Date.now() - serverStartTime) / 1000) : 0,
          sessionCount: st.activeSessions,
          recentEvents: history?.recent(100) ?? [],
          totalEvents: history?.size ?? 0,
        }));
      } else if (req.url === '/api/dispatch' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => body += c.toString());
        req.on('end', async () => {
          try {
            const { agentName, message, context } = JSON.parse(body);
            if (!agentName || !message) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'agentName and message required' })); return; }
            await ensureStarted();
            const result = await server.dispatch(agentName, message, context);
            res.writeHead(200, cors);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, cors);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      } else if (req.url === '/api/close' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => body += c.toString());
        req.on('end', async () => {
          try {
            const { agentName } = JSON.parse(body);
            if (!agentName) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'agentName required' })); return; }
            const mgr = server.getSessionManager();
            await mgr?.closeSession(agentName);
            res.writeHead(200, cors);
            res.end(JSON.stringify({ closed: agentName }));
          } catch (err) {
            res.writeHead(500, cors);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      } else if (req.url?.startsWith('/api/sessions/') && req.method === 'GET') {
        const agentName = decodeURIComponent(req.url.split('/api/sessions/')[1]?.split('?')[0] ?? '');
        if (!agentName) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'agent name required' })); return; }
        const mgr = server.getSessionManager();
        const messages = mgr?.getMessages(agentName) ?? [];
        res.writeHead(200, cors);
        res.end(JSON.stringify({ agentName, messages }));
      } else if (req.url === '/api/send' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => body += c.toString());
        req.on('end', async () => {
          try {
            const { agentName, message } = JSON.parse(body);
            if (!agentName || !message) { res.writeHead(400, cors); res.end(JSON.stringify({ error: 'agentName and message required' })); return; }
            const mgr = server.getSessionManager();
            const response = await mgr?.sendFollowUp(agentName, message);
            res.writeHead(200, cors);
            res.end(JSON.stringify({ sent: true, agentName, response }));
          } catch (err) {
            res.writeHead(500, cors);
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    dashServer.listen(dashPort, () => {
      const addr = dashServer!.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : dashPort;
      dashboardUrl = `http://localhost:${actualPort}`;
      persistPort(options.squadRoot, actualPort);
      process.stderr.write(`[squad-mcp] Dashboard: ${dashboardUrl}\n`);
    });
    dashServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`[squad-mcp] Dashboard port ${dashPort} in use, trying random port\n`);
        dashServer!.listen(0, () => {
          const addr = dashServer!.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
          dashboardUrl = `http://localhost:${actualPort}`;
          persistPort(options.squadRoot, actualPort);
          process.stderr.write(`[squad-mcp] Dashboard: ${dashboardUrl}\n`);
        });
      }
    });
  }

  // --- Eager start — connect to Copilot backend immediately ---
  // Don't block MCP protocol — start in background, retry on dispatch if needed
  ensureStarted().catch(() => {
    process.stderr.write('[squad-mcp] Eager start failed — will retry on first dispatch\n');
  });

  // --- Start MCP protocol loop ---
  process.stderr.write('[squad-mcp] Squad MCP server ready (waiting for Copilot)\n');
  await mcp.start();
}
