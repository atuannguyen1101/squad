/**
 * Squad MCP Server
 *
 * Wraps SquadServer as an MCP stdio server. Copilot spawns this process
 * and discovers squad_dispatch, squad_status, squad_list_agents tools.
 */

import { MCPServer } from './protocol.js';
import { SquadServer, type SquadServerConfig } from '../server/index.js';
import type { SquadConfig } from '../runtime/config.js';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

  // squad_monitor: Get recent server events for monitoring/debugging
  mcp.addTool(
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

  // squad_roster: Discover available agents from .squad/agents/
  mcp.addTool(
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
  let dashServer: http.Server | null = null;
  const shutdown = async () => {
    process.stderr.write('[squad-mcp] Shutting down...\n');
    if (dashServer) dashServer.close();
    if (started) {
      await server.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Start dashboard HTTP server ---
  const dashPort = parseInt(process.env['SQUAD_DASHBOARD_PORT'] ?? '3850', 10);
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
            await mgr?.sendFollowUp(agentName, message);
            res.writeHead(200, cors);
            res.end(JSON.stringify({ sent: true, agentName }));
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
      process.stderr.write(`[squad-mcp] Dashboard: ${dashboardUrl}\n`);
    });
    dashServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`[squad-mcp] Dashboard port ${dashPort} in use, trying random port\n`);
        dashServer!.listen(0, () => {
          const addr = dashServer!.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
          dashboardUrl = `http://localhost:${actualPort}`;
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
