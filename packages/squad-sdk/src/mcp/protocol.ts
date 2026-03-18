/**
 * MCP Protocol Handler — JSON-RPC 2.0 over stdio
 *
 * Implements the Model Context Protocol for tool registration
 * and invocation. Copilot spawns this as a child process.
 */

import * as readline from 'node:readline';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPToolHandler {
  (args: Record<string, any>): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

export class MCPServer {
  private tools = new Map<string, { definition: MCPTool; handler: MCPToolHandler }>();
  private serverInfo: { name: string; version: string };

  constructor(name: string, version: string) {
    this.serverInfo = { name, version };
  }

  /** Register a tool */
  addTool(definition: MCPTool, handler: MCPToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  /** Start the stdio JSON-RPC loop */
  async start(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return; // Skip empty lines
      try {
        const request = JSON.parse(trimmed);
        const response = await this.handleRequest(request);
        if (response) {
          // JSON-RPC responses go to stdout, one per line
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch {
        // Parse error
        const errorResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    });

    rl.on('close', () => {
      process.exit(0);
    });
  }

  private async handleRequest(request: any): Promise<any> {
    const { id, method, params } = request;

    // Notifications (no id) don't get responses
    if (id === undefined) return null;

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          },
        };

      case 'notifications/initialized':
        return null; // No response to notifications

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: Array.from(this.tools.values()).map(t => t.definition),
          },
        };

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        const tool = this.tools.get(toolName);

        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: Unknown tool "${toolName}"` }],
              isError: true,
            },
          };
        }

        try {
          const result = await tool.handler(toolArgs);
          return { jsonrpc: '2.0', id, result };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            },
          };
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }
}
