import { describe, it, expect, beforeEach } from 'vitest';

describe('EventHistory', () => {
  let EventHistory: any;

  beforeEach(async () => {
    const mod = await import('../packages/squad-sdk/src/server/event-history.js');
    EventHistory = mod.EventHistory;
  });

  it('should store and retrieve events', () => {
    const history = new EventHistory(10);
    history.push({ type: 'test', summary: 'event 1' });
    history.push({ type: 'test', summary: 'event 2' });
    
    const events = history.recent();
    expect(events).toHaveLength(2);
    expect(events[0].summary).toBe('event 1');
    expect(events[1].summary).toBe('event 2');
  });

  it('should auto-assign id and timestamp', () => {
    const history = new EventHistory();
    const event = history.push({ type: 'test', summary: 'hello' });
    
    expect(event.id).toBe(1);
    expect(event.timestamp).toBeDefined();
    expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('should enforce max size (ring buffer)', () => {
    const history = new EventHistory(3);
    history.push({ type: 'a', summary: '1' });
    history.push({ type: 'b', summary: '2' });
    history.push({ type: 'c', summary: '3' });
    history.push({ type: 'd', summary: '4' }); // pushes out '1'
    
    const events = history.recent(10);
    expect(events).toHaveLength(3);
    expect(events[0].summary).toBe('2');
    expect(events[2].summary).toBe('4');
  });

  it('should filter by type', () => {
    const history = new EventHistory();
    history.push({ type: 'session:created', summary: 'created' });
    history.push({ type: 'dispatch', summary: 'dispatched' });
    history.push({ type: 'session:destroyed', summary: 'destroyed' });
    
    const sessions = history.recent(10, { type: 'session' });
    expect(sessions).toHaveLength(2);
  });

  it('should filter by agentName', () => {
    const history = new EventHistory();
    history.push({ type: 'test', agentName: 'fenster', summary: 'a' });
    history.push({ type: 'test', agentName: 'keaton', summary: 'b' });
    history.push({ type: 'test', agentName: 'fenster', summary: 'c' });
    
    const fensterEvents = history.recent(10, { agentName: 'fenster' });
    expect(fensterEvents).toHaveLength(2);
  });

  it('should limit results by count', () => {
    const history = new EventHistory();
    for (let i = 0; i < 10; i++) {
      history.push({ type: 'test', summary: `event ${i}` });
    }
    
    const recent5 = history.recent(5);
    expect(recent5).toHaveLength(5);
    expect(recent5[0].summary).toBe('event 5'); // last 5
  });

  it('should report size', () => {
    const history = new EventHistory();
    expect(history.size).toBe(0);
    history.push({ type: 'test', summary: 'a' });
    expect(history.size).toBe(1);
  });

  it('should clear all events', () => {
    const history = new EventHistory();
    history.push({ type: 'test', summary: 'a' });
    history.push({ type: 'test', summary: 'b' });
    history.clear();
    expect(history.size).toBe(0);
    expect(history.recent()).toEqual([]);
  });
});

// Test MCP squad_monitor tool (protocol-level)
describe('squad_monitor MCP tool', () => {
  let MCPServer: any;

  beforeEach(async () => {
    const mod = await import('../packages/squad-sdk/src/mcp/protocol.js');
    MCPServer = mod.MCPServer;
  });

  it('should be listable via tools/list after registration', async () => {
    const server = new MCPServer('test', '1.0');
    server.addTool(
      {
        name: 'squad_monitor',
        description: 'Monitor events',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => ({ content: [{ type: 'text', text: 'events' }] }),
    );

    const response = await (server as any).handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const toolNames = response.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('squad_monitor');
  });
});
