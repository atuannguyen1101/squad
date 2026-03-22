/**
 * MCP Bridge — Proxies external MCP servers as squad tools.
 *
 * On startup, spawns configured MCP servers (from ~/.copilot/mcp-config.json),
 * discovers their tools via the MCP protocol, and registers them as squad tools.
 * Agents can then call `github_get_pull_request(...)` etc. directly.
 *
 * Supports stdio (local) MCP servers. HTTP/SSE servers require auth context
 * that the squad server doesn't have, so they're skipped with a warning.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defineTool } from './index.js';
import type { SquadTool, SquadToolResult } from '../adapter/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface McpBridgeConfig {
  /** Path to MCP config file (default: ~/.copilot/mcp-config.json) */
  configPath?: string;
  /** Server names to skip (e.g., 'squad' to avoid circular spawning) */
  skipServers?: string[];
}

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
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
      configPath: config.configPath ?? path.join(os.homedir(), '.copilot', 'mcp-config.json'),
      skipServers: config.skipServers ?? ['squad'],
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

      // Only stdio/local servers can be spawned — HTTP servers need auth context we don't have
      const serverType = server.type ?? 'stdio';
      if (serverType === 'http' || serverType === 'sse') {
        console.error(`[mcp-bridge] Skipping ${name}: HTTP/SSE servers not supported (need auth context). Use stdio server instead.`);
        continue;
      }

      if (!server.command) {
        console.error(`[mcp-bridge] Skipping ${name}: no command specified`);
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
    const transport = new StdioClientTransport({
      command: server.command!,
      args: server.args ?? [],
      env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
      cwd: server.cwd,
    });

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
    console.error(`[mcp-bridge] Connected to ${name}: ${toolNames.length} tools (${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''})`);
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
   * Read MCP server config from disk.
   */
  private readConfig(): Record<string, McpServerEntry> | null {
    try {
      const raw = fs.readFileSync(this.config.configPath!, 'utf-8');
      const config = JSON.parse(raw) as { mcpServers?: Record<string, McpServerEntry> };
      return config.mcpServers ?? null;
    } catch {
      return null;
    }
  }
}
