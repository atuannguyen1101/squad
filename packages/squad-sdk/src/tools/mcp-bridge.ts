/**
 * MCP Bridge — Proxies external MCP servers as squad tools.
 *
 * On startup, spawns configured MCP servers (from multiple config locations),
 * discovers their tools via the MCP protocol, and registers them as squad tools.
 * Agents can then call `github_get_pull_request(...)` etc. directly.
 *
 * Supports both stdio (local) and HTTP MCP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { defineTool } from './index.js';
import type { SquadTool, SquadToolResult } from '../adapter/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface McpBridgeConfig {
  /** Path to MCP config file (default: multi-path resolution) */
  configPath?: string;
  /** Server names to skip (e.g., 'squad' to avoid circular spawning) */
  skipServers?: string[];
  /** Regex pattern for server names to skip (e.g., /squad/i skips squad-portal, squad-ben) */
  skipPattern?: RegExp;
  /** Squad root directory for workspace config resolution */
  squadRoot?: string;
}

interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: Transport;
  tools: string[];
}

/**
 * MCP Bridge — spawns external MCP servers and proxies their tools to squad agents.
 */
export class McpBridge {
  private servers: Map<string, ConnectedServer> = new Map();
  private config: McpBridgeConfig;
  private bridgedTools: SquadTool<any>[] = [];

  constructor(config: McpBridgeConfig = {}) {
    this.config = {
      configPath: config.configPath,
      skipServers: config.skipServers ?? ['squad'],
      skipPattern: config.skipPattern,
      squadRoot: config.squadRoot,
    };
  }

  /**
   * Initialize the bridge: read config, spawn servers, discover tools.
   * Returns the list of bridged tools ready to register.
   */
  async initialize(): Promise<SquadTool<any>[]> {
    const mcpConfig = this.readConfig();
    if (!mcpConfig) return [];

    for (const [name, server] of Object.entries(mcpConfig)) {
      if (this.config.skipServers?.includes(name)) continue;
      if (this.config.skipPattern?.test(name)) continue;

      const serverType = server.type ?? 'stdio';

      // Validate server configuration
      if (serverType === 'stdio' && !server.command) {
        console.error(`[mcp-bridge] Skipping ${name}: stdio server requires command`);
        continue;
      }

      if ((serverType === 'http' || serverType === 'sse') && !server.url) {
        console.error(`[mcp-bridge] Skipping ${name}: ${serverType} server requires url`);
        continue;
      }

      try {
        await this.connectServer(name, server);
      } catch (err) {
        console.error(`[mcp-bridge] Failed to connect to ${name}:`, err instanceof Error ? err.message : err);
      }
    }

    return this.bridgedTools;
  }

  /**
   * Connect to a single MCP server, discover its tools, and create proxy tools.
   */
  private async connectServer(name: string, server: McpServerEntry): Promise<void> {
    const serverType = server.type ?? 'stdio';
    let transport: Transport;

    if (serverType === 'stdio') {
      transport = new StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
        cwd: server.cwd ?? this.config.squadRoot,
      });
    } else if (serverType === 'http' || serverType === 'sse') {
      const url = new URL(server.url!);
      const headers: Record<string, string> = { ...(server.headers ?? {}) };

      // Try to acquire auth token via Squad Auth Proxy (VS Code extension)
      if (!headers['Authorization']) {
        const token = await this.acquireAuthToken(url.origin);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
          console.error(`[mcp-bridge] Acquired auth token for ${name} via auth proxy`);
        }
      }

      if (serverType === 'http') {
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
        });
      } else {
        transport = new SSEClientTransport(url, {
          requestInit: { headers },
        });
      }
    } else {
      throw new Error(`Unsupported server type: ${serverType}`);
    }

    const client = new Client(
      { name: `squad-mcp-bridge-${name}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    // Discover tools via MCP protocol
    const toolsResult = await client.listTools();
    const toolNames: string[] = [];

    for (const tool of toolsResult.tools) {
      const prefixedName = `${name}_${tool.name}`;
      toolNames.push(prefixedName);

      // Create a proxy squad tool for each MCP tool
      const proxyTool = defineTool<Record<string, unknown>>({
        name: prefixedName,
        description: `[${name}] ${tool.description ?? tool.name}`,
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        handler: async (args) => {
          return this.callTool(name, tool.name, args);
        },
      });

      this.bridgedTools.push(proxyTool);
    }

    this.servers.set(name, { name, client, transport, tools: toolNames });
    console.error(`[mcp-bridge] Connected to ${name} (${serverType}): ${toolNames.length} tools (${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''})`);
  }

  /**
   * Proxy a tool call to an MCP server.
   */
  private async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<SquadToolResult> {
    const server = this.servers.get(serverName);
    if (!server) {
      return {
        textResultForLlm: `MCP server '${serverName}' not connected`,
        resultType: 'failure',
        error: `Server not found: ${serverName}`,
      };
    }

    try {
      const result = await server.client.callTool({ name: toolName, arguments: args });

      // Extract text content from MCP result
      const textParts = (result.content as Array<{ type: string; text?: string }>)
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!);
      const text = textParts.join('\n');

      return {
        textResultForLlm: text || JSON.stringify(result.content),
        resultType: result.isError ? 'failure' : 'success',
        ...(result.isError ? { error: text } : {}),
      };
    } catch (err) {
      return {
        textResultForLlm: `MCP call failed: ${err instanceof Error ? err.message : err}`,
        resultType: 'failure',
        error: String(err),
      };
    }
  }

  /**
   * Acquire an auth token via the Squad Auth Proxy (VS Code extension).
   * The proxy runs as a localhost HTTP server and uses VS Code's authentication API.
   * Returns null if the proxy isn't available.
   */
  private async acquireAuthToken(serverOrigin: string): Promise<string | null> {
    const proxyPort = this.findAuthProxyPort();
    if (!proxyPort) return null;

    try {
      // Derive the scope from the server origin (standard Azure AD pattern)
      const scopes = [`${serverOrigin}/.default`];

      const response = await fetch(`http://127.0.0.1:${proxyPort}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
        console.error(`[mcp-bridge] Auth proxy returned ${response.status}: ${err.error ?? 'unknown'}`);
        return null;
      }

      const data = await response.json() as { token?: string; account?: string };
      if (data.token) {
        console.error(`[mcp-bridge] Auth proxy: token acquired for ${data.account ?? 'unknown account'}`);
        return data.token;
      }
      return null;
    } catch (err) {
      console.error(`[mcp-bridge] Auth proxy unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Find the Squad Auth Proxy port from environment, workspace, or global storage.
   */
  private findAuthProxyPort(): number | null {
    // 1. Environment variable (set by the VS Code extension for child processes)
    const envPort = process.env['SQUAD_AUTH_PROXY_PORT'];
    if (envPort) return parseInt(envPort, 10);

    // 2. Workspace file (.squad/.auth-proxy-port)
    if (this.config.squadRoot) {
      const wsPortFile = path.join(this.config.squadRoot, '.squad', '.auth-proxy-port');
      try {
        const port = parseInt(fs.readFileSync(wsPortFile, 'utf-8').trim(), 10);
        if (port > 0) return port;
      } catch { /* not found */ }
    }

    // 3. Home directory fallback
    const homePortFile = path.join(os.homedir(), '.squad', '.auth-proxy-port');
    try {
      const port = parseInt(fs.readFileSync(homePortFile, 'utf-8').trim(), 10);
      if (port > 0) return port;
    } catch { /* not found */ }

    return null;
  }

  /**
   * Shut down all connected MCP servers.
   */
  async shutdown(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.servers.clear();
    this.bridgedTools = [];
  }

  /**
   * Get the list of connected server names and their tool counts.
   */
  getStatus(): { name: string; toolCount: number }[] {
    return Array.from(this.servers.values()).map(s => ({
      name: s.name,
      toolCount: s.tools.length,
    }));
  }

  /**
   * Read MCP server config from disk with multi-path resolution.
   * Priority order:
   *   1. SQUAD_ROOT/.vscode/mcp.json (workspace-specific)
   *   2. ~/.copilot/mcp-config.json (user global)
   *   3. Empty fallback
   */
  private readConfig(): Record<string, McpServerEntry> | null {
    // If explicit path provided, use it
    if (this.config.configPath) {
      return this.readConfigFromPath(this.config.configPath);
    }

    // Multi-path resolution
    const paths: string[] = [];

    // 1. Workspace config
    if (this.config.squadRoot) {
      paths.push(path.join(this.config.squadRoot, '.vscode', 'mcp.json'));
    }

    // 2. User global config
    paths.push(path.join(os.homedir(), '.copilot', 'mcp-config.json'));

    for (const configPath of paths) {
      const config = this.readConfigFromPath(configPath);
      if (config) {
        console.error(`[mcp-bridge] Loaded config from ${configPath}`);
        return config;
      }
    }

    return null;
  }

  /**
   * Read config from a specific path.
   */
  private readConfigFromPath(configPath: string): Record<string, McpServerEntry> | null {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw) as {
        mcpServers?: Record<string, McpServerEntry>;
        servers?: Record<string, McpServerEntry>;
      };
      return config.mcpServers ?? config.servers ?? null;
    } catch {
      return null;
    }
  }
}
