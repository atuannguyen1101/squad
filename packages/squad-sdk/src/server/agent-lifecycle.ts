/**
 * Agent Session Lifecycle Manager
 *
 * Manages persistent agent sessions within the orchestration server.
 * Sessions are created on-demand, reused while active, and auto-cleaned
 * when idle (via SessionPool's idle timeout).
 *
 * Charter compilation reads .squad/agents/{name}/charter.md, history.md,
 * and team decisions to build a complete system prompt for each agent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SquadClientWithPool } from '../client/index.js';
import type { SquadSession, SquadSessionConfig, SquadTool, SquadMCPServerConfig } from '../adapter/types.js';
import type { EventBus } from '../runtime/event-bus.js';
import { CharterCompiler, type AgentCharter } from '../agents/index.js';
import type { ServerPersistence, SessionRegistryEntry, ServerStateSnapshot } from './persistence.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionManagerConfig {
  /** SquadClientWithPool for creating/managing sessions */
  client: SquadClientWithPool;
  /** EventBus for lifecycle event emission */
  eventBus: EventBus;
  /** Root directory of the squad project (parent of .squad/) */
  squadRoot: string;
  /** Squad tools to inject into every agent session */
  tools: SquadTool<any>[];
  /** Default model when charter doesn't specify one */
  defaultModel?: string;
  /** Working directory for agent sessions */
  workingDirectory?: string;
  /** MCP servers to attach to agent sessions. If not provided, loaded from ~/.copilot/mcp-config.json */
  mcpServers?: Record<string, SquadMCPServerConfig>;
}

export interface AgentSessionEntry {
  /** Agent name */
  agentName: string;
  /** The live SDK session */
  session: SquadSession;
  /** Compiled charter used to create the session */
  charter: AgentCharter;
  /** Timestamp when the session was created */
  createdAt: Date;
  /** Timestamp of the last dispatched message */
  lastActiveAt: Date;
}

export interface DispatchResult {
  /** Session ID used for the dispatch */
  sessionId: string;
  /** Status of the dispatch */
  status: 'sent' | 'created_and_sent';
  /** Agent name */
  agentName: string;
}

export interface ActiveSessionInfo {
  agentName: string;
  sessionId: string;
  createdAt: Date;
  lastActiveAt: Date;
  charterRole: string;
}

// Maximum bytes of history to include in the compiled charter prompt
const MAX_HISTORY_BYTES = 2048;

/**
 * Resolve a potentially abbreviated agent name to the full directory name
 * under .squad/agents/. Matches by exact name, then prefix, then substring.
 * Returns the original name if no match is found (falls back to default charter).
 */
function resolveAgentName(squadRoot: string, input: string): string {
  const agentsDir = path.join(squadRoot, '.squad', 'agents');
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name as string);
  } catch {
    return input;
  }

  const lower = input.toLowerCase();
  if (entries.includes(input)) return input;

  const exactCI = entries.find(e => e.toLowerCase() === lower);
  if (exactCI) return exactCI;

  const prefixMatches = entries.filter(e => e.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0]!;

  const substringMatches = entries.filter(e => e.toLowerCase().includes(lower));
  if (substringMatches.length === 1) return substringMatches[0]!;

  return input;
}

/**
 * Load MCP server configs from ~/.copilot/mcp-config.json.
 * Returns a map compatible with SquadSessionConfig.mcpServers.
 * Excludes the squad MCP server itself to avoid circular spawning.
 */
function loadUserMCPServers(): Record<string, SquadMCPServerConfig> | undefined {
  const configPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as { mcpServers?: Record<string, any> };
    if (!config.mcpServers) return undefined;

    const result: Record<string, SquadMCPServerConfig> = {};
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (name === 'squad') continue;
      result[name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env,
        type: server.type ?? 'stdio',
        tools: server.tools ?? ['*'],
      } as SquadMCPServerConfig;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// AgentSessionManager
// ============================================================================

export class AgentSessionManager {
  private readonly client: SquadClientWithPool;
  private readonly eventBus: EventBus;
  private readonly squadRoot: string;
  private readonly tools: SquadTool<any>[];
  private readonly defaultModel: string | undefined;
  private readonly workingDirectory: string | undefined;
  private readonly charterCompiler: CharterCompiler;
  private readonly mcpServers: Record<string, SquadMCPServerConfig> | undefined;

  /** Optional persistence layer for crash recovery */
  private persistence: ServerPersistence | null = null;
  private serverStartedAt: string = new Date().toISOString();

  /** Active agent sessions keyed by agent name */
  private sessions: Map<string, AgentSessionEntry> = new Map();

  constructor(config: AgentSessionManagerConfig) {
    this.client = config.client;
    this.eventBus = config.eventBus;
    this.squadRoot = config.squadRoot;
    this.tools = config.tools;
    this.defaultModel = config.defaultModel;
    this.workingDirectory = config.workingDirectory;
    this.charterCompiler = new CharterCompiler();
    this.mcpServers = config.mcpServers ?? loadUserMCPServers();
  }

  /**
   * Attach a persistence layer for crash recovery.
   * Should be called before any sessions are created.
   */
  setPersistence(persistence: ServerPersistence, serverStartedAt?: string): void {
    this.persistence = persistence;
    if (serverStartedAt) {
      this.serverStartedAt = serverStartedAt;
    }
  }

  /**
   * Export current sessions as registry entries for persistence.
   */
  getRegistryEntries(): SessionRegistryEntry[] {
    return Array.from(this.sessions.values()).map(entry => ({
      sessionId: entry.session.sessionId,
      agentName: entry.agentName,
      createdAt: entry.createdAt.toISOString(),
      lastMessageAt: entry.lastActiveAt.toISOString(),
      status: 'active' as const,
    }));
  }

  /**
   * Export full server state snapshot for auto-save.
   */
  getStateSnapshot(): ServerStateSnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      serverStartedAt: this.serverStartedAt,
      sessions: this.getRegistryEntries(),
      poolSize: this.client.pool.size,
      poolCapacity: this.client.pool.size,
    };
  }

  /**
   * Get an existing session for an agent, or create a new one.
   * Sessions are keyed by agent name — each agent has at most one active session.
   */
  async getOrCreateSession(agentName: string): Promise<{ session: SquadSession; created: boolean; resolvedName: string }> {
    // Resolve abbreviated names (e.g. "koba" → "kobayashi")
    const resolved = resolveAgentName(this.squadRoot, agentName);

    const existing = this.sessions.get(resolved);
    if (existing) {
      return { session: existing.session, created: false, resolvedName: resolved };
    }

    // Check the pool for an orphaned session (e.g. created outside this manager)
    const poolSession = this.client.pool.findByAgent(resolved);
    if (poolSession) {
      this.client.pool.remove(poolSession.id);
    }

    const charter = await this.compileCharter(resolved);
    const systemPrompt = await this.buildSystemPrompt(resolved, charter);

    const sessionConfig: SquadSessionConfig = {
      model: charter.modelPreference ?? this.defaultModel,
      tools: this.tools,
      systemMessage: {
        mode: 'replace' as const,
        content: systemPrompt,
      },
      workingDirectory: this.workingDirectory ?? this.squadRoot,
      onPermissionRequest: () => ({ kind: 'approved' as const }),
      mcpServers: this.mcpServers,
    };

    const session = await this.client.createSession(sessionConfig);

    const now = new Date();
    const entry: AgentSessionEntry = {
      agentName: resolved,
      session,
      charter,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(resolved, entry);

    // Persist registry after new session creation
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    await this.eventBus.emit({
      type: 'session:created',
      sessionId: session.sessionId,
      agentName: resolved,
      payload: { role: charter.role, model: charter.modelPreference ?? this.defaultModel },
      timestamp: now,
    });

    return { session, created: true, resolvedName: resolved };
  }

  /**
   * Send a message to an agent, creating a session if needed.
   * Returns dispatch metadata including the session ID and whether a new session was created.
   */
  async dispatch(agentName: string, message: string, context?: string): Promise<DispatchResult> {
    const { session, created, resolvedName } = await this.getOrCreateSession(agentName);

    const prompt = context
      ? `${message}\n\n<context>\n${context}\n</context>`
      : message;

    await session.sendMessage({ prompt });

    // Update last-active timestamp
    const entry = this.sessions.get(resolvedName);
    if (entry) {
      entry.lastActiveAt = new Date();
    }

    // Persist updated lastMessageAt
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    await this.eventBus.emit({
      type: 'session:message',
      sessionId: session.sessionId,
      agentName: resolvedName,
      payload: { direction: 'outbound', promptLength: prompt.length },
      timestamp: new Date(),
    });

    return {
      sessionId: session.sessionId,
      status: created ? 'created_and_sent' : 'sent',
      agentName: resolvedName,
    };
  }

  /**
   * Compile a charter for the given agent.
   * Reads charter.md from .squad/agents/{name}/charter.md.
   * Falls back to a minimal default if the file doesn't exist.
   */
  async compileCharter(agentName: string): Promise<AgentCharter> {
    const charterPath = path.join(this.squadRoot, '.squad', 'agents', agentName, 'charter.md');

    try {
      return await this.charterCompiler.compile(charterPath);
    } catch {
      // Charter file missing or malformed — use a sensible default
      return {
        name: agentName,
        displayName: agentName,
        role: 'general-purpose agent',
        expertise: [],
        style: '',
        prompt: `You are ${agentName}, a general-purpose agent in this squad.`,
      };
    }
  }

  /**
   * Build the full system prompt for an agent session.
   * Combines charter content, recent history, team decisions, and tool descriptions.
   */
  private async buildSystemPrompt(agentName: string, charter: AgentCharter): Promise<string> {
    const sections: string[] = [];

    // 1. Agent identity header
    sections.push(`# ${charter.displayName}\n`);
    sections.push(`**Role:** ${charter.role}`);
    if (charter.expertise.length > 0) {
      sections.push(`**Expertise:** ${charter.expertise.join(', ')}`);
    }
    if (charter.style) {
      sections.push(`**Style:** ${charter.style}`);
    }
    sections.push('');

    // 2. Charter content
    sections.push(charter.prompt);
    sections.push('');

    // 3. Recent history (last ~2KB)
    const historyContent = this.readFileSafe(
      path.join(this.squadRoot, '.squad', 'agents', agentName, 'history.md'),
    );
    if (historyContent) {
      const trimmed = historyContent.length > MAX_HISTORY_BYTES
        ? '...\n' + historyContent.slice(-MAX_HISTORY_BYTES)
        : historyContent;
      sections.push('## Recent History\n');
      sections.push(trimmed);
      sections.push('');
    }

    // 4. Team decisions
    const decisionsContent = this.readFileSafe(
      path.join(this.squadRoot, '.squad', 'decisions.md'),
    );
    if (decisionsContent) {
      sections.push('## Team Decisions\n');
      sections.push(decisionsContent);
      sections.push('');
    }

    // 5. Available squad tools
    const toolNames = this.tools.map(t => t.name);
    if (toolNames.length > 0) {
      sections.push('## Available Squad Tools\n');
      sections.push(`You have access to these squad coordination tools: ${toolNames.join(', ')}`);
      sections.push('Use squad_route to delegate work to other agents in the team.');
      sections.push('Use squad_decide to record team decisions.');
      sections.push('Use squad_memory to record learnings for future sessions.');
      sections.push('Use squad_status to check on other agents and sessions.');
      sections.push('');
    }

    return sections.join('\n');
  }

  /**
   * Gracefully close a specific agent's session.
   */
  async closeSession(agentName: string): Promise<void> {
    const entry = this.sessions.get(agentName);
    if (!entry) return;

    try {
      await entry.session.close();
    } catch {
      // Session may already be closed — that's fine
    }

    this.sessions.delete(agentName);

    // Persist registry after session removal
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    await this.eventBus.emit({
      type: 'session:destroyed',
      sessionId: entry.session.sessionId,
      agentName,
      payload: {
        durationMs: Date.now() - entry.createdAt.getTime(),
      },
      timestamp: new Date(),
    });
  }

  /**
   * Close all active agent sessions.
   */
  async closeAll(): Promise<void> {
    const agents = Array.from(this.sessions.keys());
    await Promise.allSettled(agents.map(name => this.closeSession(name)));
  }

  /**
   * List all active agent sessions with metadata.
   */
  listActiveSessions(): ActiveSessionInfo[] {
    return Array.from(this.sessions.values()).map(entry => ({
      agentName: entry.agentName,
      sessionId: entry.session.sessionId,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      charterRole: entry.charter.role,
    }));
  }

  /**
   * Check if a session exists for the given agent.
   */
  hasSession(agentName: string): boolean {
    return this.sessions.has(agentName);
  }

  /**
   * Get the number of active sessions.
   */
  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Read a file synchronously, returning null if it doesn't exist or can't be read.
   */
  private readFileSafe(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}
