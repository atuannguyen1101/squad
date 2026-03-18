/**
 * Squad Serve — Orchestration Server
 *
 * `squad serve [--port N] [--no-remote]`
 * Starts a persistent orchestration server that manages agent sessions,
 * enables inter-agent communication via squad_route, and provides
 * monitoring via EventBus + optional RemoteBridge.
 */

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { detectSquadDir } from '../core/detect-squad-dir.js';
import { fatal } from '../core/errors.js';
import { GREEN, DIM, BOLD, RESET, YELLOW } from '../core/output.js';

export interface ServeOptions {
  port: number;
  remote: boolean;
}

export async function runServe(cwd: string, options: ServeOptions): Promise<void> {
  // 1. Detect squad directory
  const squadDirInfo = detectSquadDir(cwd);
  const teamMdPath = path.join(squadDirInfo.path, 'team.md');

  if (!fs.existsSync(teamMdPath)) {
    fatal('No squad found — run init first.');
  }

  // 2. Load squad config
  // Try squad.config.ts first, fall back to directory-based config
  const configPath = path.join(cwd, 'squad.config.ts');
  let squadConfig: any;

  if (fs.existsSync(configPath)) {
    // Dynamic import of squad.config.ts
    try {
      const module = await import(configPath);
      squadConfig = module.default;
    } catch {
      console.log(`${YELLOW}⚠${RESET} Could not load squad.config.ts, using directory config`);
      squadConfig = await loadDirBasedConfig(squadDirInfo.path);
    }
  } else {
    squadConfig = await loadDirBasedConfig(squadDirInfo.path);
  }

  // 3. Print startup banner
  console.log(`\n${BOLD}🚀 Squad Orchestration Server${RESET}`);
  console.log(`${DIM}Managing persistent agent sessions with inter-agent routing.${RESET}\n`);

  // 4. Initialize server
  // Dynamic import to avoid loading server code when not needed
  const { SquadServer } = await import('@bradygaster/squad-sdk/server');

  const server = new SquadServer({
    squadConfig,
    squadRoot: path.dirname(squadDirInfo.path),
    enableRemote: options.remote,
    remotePort: options.port || 0,
  });

  // 5. Start server
  try {
    await server.start();
    const status = server.getStatus();

    console.log(`${GREEN}✓${RESET} Server running`);
    console.log(`  ${DIM}Squad root:${RESET}  ${path.dirname(squadDirInfo.path)}`);
    console.log(`  ${DIM}Sessions:${RESET}    ${status.activeSessions} active`);
    console.log(`  ${DIM}Connected:${RESET}   ${status.connectedToHost ? 'yes' : 'no'}`);
    if (options.remote) {
      console.log(`  ${DIM}Remote:${RESET}      enabled`);
    }
    console.log();
    console.log(`${DIM}Agents can now use squad_route for inter-agent communication.${RESET}`);
    console.log(`${DIM}Press Ctrl+C to stop.${RESET}\n`);

    // 6. Subscribe to events for logging
    const eventBus = server.getEventBus();
    eventBus.subscribeAll(async (event: any) => {
      const ts = new Date().toLocaleTimeString();
      const agent = event.agentName ? ` ${BOLD}${event.agentName}${RESET}` : '';

      switch (event.type) {
        case 'session:created':
        case 'session.created':
          console.log(`${GREEN}+${RESET} [${ts}]${agent} session created`);
          break;
        case 'session:destroyed':
        case 'session.destroyed':
          console.log(`${DIM}-${RESET} [${ts}]${agent} session closed`);
          break;
        case 'session:error':
        case 'session.error':
          console.log(`${YELLOW}!${RESET} [${ts}]${agent} error: ${event.payload?.error || 'unknown'}`);
          break;
        case 'agent:milestone':
          console.log(`${DIM}→${RESET} [${ts}]${agent} ${event.payload?.milestone || ''}`);
          break;
        case 'coordinator:routing':
          if (event.payload?.phase === 'complete') {
            console.log(`${DIM}⇒${RESET} [${ts}] routed: ${event.payload?.strategy} → ${event.payload?.agents?.join(', ') || 'unknown'}`);
          }
          break;
        case 'dispatch':
          console.log(`${GREEN}▶${RESET} [${ts}]${agent} dispatched: ${(event.payload?.message || '').slice(0, 60)}`);
          break;
        default:
          if (event.type.includes('error')) {
            console.log(`${YELLOW}!${RESET} [${ts}] ${event.type}${agent}`);
          }
          break;
      }
    });

    // 7. Start dashboard HTTP server
    const dashboardDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../dashboard',
    );
    const dashboardPath = path.join(dashboardDir, 'index.html');

    if (fs.existsSync(dashboardPath)) {
      const dashPort = options.port || 3847;
      const dashServer = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          fs.createReadStream(dashboardPath).pipe(res);
        } else if (req.url === '/api/status') {
          const st = server.getStatus();
          const history = server.getEventHistory();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({
            ...st,
            sessionCount: st.activeSessions,
            recentEvents: history.recent(50),
          }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      dashServer.listen(dashPort, () => {
        console.log(`  ${DIM}Dashboard:${RESET}   http://localhost:${dashPort}`);
      });

      // Close dashboard server alongside the main server
      const _origStop = server.stop.bind(server);
      server.stop = async () => { dashServer.close(); await _origStop(); };
    }

  } catch (err) {
    fatal(`Failed to start server: ${(err as Error).message}`);
  }

  // 8. Keep alive + graceful shutdown
  return new Promise<void>((resolve) => {
    let isShuttingDown = false;
    const shutdown = async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n${DIM}Shutting down...${RESET}`);
      await server.stop();
      console.log(`${DIM}🛑 Server stopped.${RESET}`);
      resolve();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// Helper: load config from .squad/ directory files
async function loadDirBasedConfig(squadDir: string): Promise<any> {
  const teamMd = fs.readFileSync(path.join(squadDir, 'team.md'), 'utf-8');
  const routingMd = fs.existsSync(path.join(squadDir, 'routing.md'))
    ? fs.readFileSync(path.join(squadDir, 'routing.md'), 'utf-8')
    : '';

  // Minimal config from directory
  return {
    team: { name: 'squad', description: 'Squad team' },
    routing: { rules: [] },
  };
}
