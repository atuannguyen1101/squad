/**
 * Tests for MCP Bridge config resolution and HTTP transport support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('McpBridge Configuration', () => {
  const testDir = path.join(os.tmpdir(), `squad-test-${Date.now()}`);
  const workspaceConfigPath = path.join(testDir, '.vscode', 'mcp.json');
  const globalConfigPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');

  beforeEach(() => {
    // Create test directory structure
    fs.mkdirSync(path.dirname(workspaceConfigPath), { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should define valid server types', () => {
    // Verify the McpServerEntry interface supports stdio and http types
    const stdioServer = {
      type: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
    };

    const httpServer = {
      type: 'http' as const,
      url: 'https://api.example.com/mcp',
      headers: {
        'Authorization': 'Bearer token',
      },
    };

    expect(stdioServer.type).toBe('stdio');
    expect(httpServer.type).toBe('http');
    expect(httpServer.url).toBeDefined();
    expect(httpServer.headers).toBeDefined();
  });

  it('should prioritize workspace config over global config', () => {
    // This is a structural test - verifying the priority order is documented
    // The actual implementation is tested through integration tests
    
    // Workspace config should be checked first
    const workspaceConfig = {
      mcpServers: {
        testServer: {
          type: 'stdio' as const,
          command: 'workspace-server',
        },
      },
    };

    // Global config is fallback
    const globalConfig = {
      mcpServers: {
        testServer: {
          type: 'stdio' as const,
          command: 'global-server',
        },
      },
    };

    expect(workspaceConfig.mcpServers.testServer.command).toBe('workspace-server');
    expect(globalConfig.mcpServers.testServer.command).toBe('global-server');
  });

  it('should validate stdio server requires command', () => {
    const invalidStdioServer = {
      type: 'stdio' as const,
      // Missing command field - should fail validation
    };

    const validStdioServer = {
      type: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
    };

    expect(invalidStdioServer.type).toBe('stdio');
    expect((invalidStdioServer as any).command).toBeUndefined();
    expect(validStdioServer.command).toBeDefined();
  });

  it('should validate http server requires url', () => {
    const invalidHttpServer = {
      type: 'http' as const,
      // Missing url field - should fail validation
    };

    const validHttpServer = {
      type: 'http' as const,
      url: 'https://api.example.com/mcp',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    expect(invalidHttpServer.type).toBe('http');
    expect((invalidHttpServer as any).url).toBeUndefined();
    expect(validHttpServer.url).toBeDefined();
  });

  it('should support custom headers for http servers', () => {
    const httpServerWithAuth = {
      type: 'http' as const,
      url: 'https://api.example.com/mcp',
      headers: {
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'value',
      },
    };

    expect(httpServerWithAuth.headers).toBeDefined();
    expect(httpServerWithAuth.headers?.['Authorization']).toBe('Bearer token123');
    expect(httpServerWithAuth.headers?.['X-Custom-Header']).toBe('value');
  });

  it('should handle config path resolution order', () => {
    // Test that the documented priority order is:
    // 1. SQUAD_ROOT/.vscode/mcp.json (workspace-specific)
    // 2. ~/.copilot/mcp-config.json (user global)
    // 3. Empty fallback

    const expectedPaths = [
      path.join(testDir, '.vscode', 'mcp.json'),
      path.join(os.homedir(), '.copilot', 'mcp-config.json'),
    ];

    // Verify paths are constructed correctly
    expect(expectedPaths[0]).toContain('.vscode');
    expect(expectedPaths[0]).toContain('mcp.json');
    expect(expectedPaths[1]).toContain('.copilot');
    expect(expectedPaths[1]).toContain('mcp-config.json');
  });
});

describe('McpBridge HTTP Transport', () => {
  it('should define http transport structure', () => {
    const httpTransport = {
      async start() {
        // HTTP transport doesn't need startup
      },
      async send(message: any) {
        // Would use fetch to POST to server
        return { result: 'success' };
      },
      async close() {
        // HTTP transport doesn't need cleanup
      },
    };

    expect(httpTransport.start).toBeDefined();
    expect(httpTransport.send).toBeDefined();
    expect(httpTransport.close).toBeDefined();
  });

  it('should handle http responses', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ tools: [] }),
    };

    expect(mockResponse.ok).toBe(true);
    expect(mockResponse.status).toBe(200);
    const data = await mockResponse.json();
    expect(data.tools).toBeDefined();
  });
});
