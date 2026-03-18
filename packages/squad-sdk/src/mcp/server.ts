/**
 * Squad MCP Server
 *
 * Wraps SquadServer as an MCP stdio server. Copilot spawns this process
 * and discovers squad_dispatch, squad_status, squad_list_agents tools.
 */

import { MCPServer } from './protocol.js';
import { SquadServer, type SquadServerConfig } from '../server/index.js';
import type { SquadConfig } from '../runtime/config.js';

export interface SquadMCPServerOptions {
  /** Squad root directory */
  squadRoot: string;
  /** Squad configuration */
  squadConfig?: SquadConfig;
  /** Server name for MCP */
  serverName?: string;
  /** Server version for MCP */
  serverVersion?: string;
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

  // Lazy start — connect to Copilot on first dispatch
  async function ensureStarted(): Promise<void> {
    if (!started) {
      try {
        await server.start();
        started = true;
        process.stderr.write('[squad-mcp] Server connected to Copilot backend\n');
      } catch (err) {
        process.stderr.write(`[squad-mcp] Failed to start: ${err instanceof Error ? err.message : err}\n`);
        throw err;
      }
    }
  }

  // --- Register tools ---

  // squad_dispatch: Send work to a named agent
  mcp.addTool(
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
      const result = await server.dispatch(args.agentName, args.message, args.context);
      return {
        content: [{
          type: 'text',
          text: `Dispatched to ${args.agentName} (session: ${result.sessionId}, status: ${result.status})`,
        }],
      };
    },
  );

  // squad_status: Get server status
  mcp.addTool(
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
      return {
        content: [{
          type: 'text',
          text: [
            `Squad Server: ${status.running ? 'running' : 'stopped'}`,
            `Active sessions: ${status.activeSessions}`,
            `Connected: ${status.connectedToHost}`,
            status.agents.length > 0 ? `Agents:\n${agentList}` : 'No active agents',
          ].join('\n'),
        }],
      };
    },
  );

  // squad_list_agents: List active agent sessions
  mcp.addTool(
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

  // squad_close_session: Close a specific agent session
  mcp.addTool(
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

  // --- Graceful shutdown ---
  const shutdown = async () => {
    process.stderr.write('[squad-mcp] Shutting down...\n');
    if (started) {
      await server.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Start MCP protocol loop ---
  process.stderr.write('[squad-mcp] Squad MCP server ready (waiting for Copilot)\n');
  await mcp.start();
}
