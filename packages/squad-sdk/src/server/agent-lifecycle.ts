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
import * as path from 'node:path';
import type { SquadClientWithPool } from '../client/index.js';
import type { SquadSession, SquadSessionConfig, SquadTool } from '../adapter/types.js';
import type { EventBus } from '../runtime/event-bus.js';
import { CharterCompiler, type AgentCharter } from '../agents/index.js';

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
  }

  /**
   * Get an existing session for an agent, or create a new one.
   * Sessions are keyed by agent name — each agent has at most one active session.
   */
  async getOrCreateSession(agentName: string): Promise<{ session: SquadSession; created: boolean }> {
    const existing = this.sessions.get(agentName);
    if (existing) {
      return { session: existing.session, created: false };
    }

    // Check the pool for an orphaned session (e.g. created outside this manager)
    const poolSession = this.client.pool.findByAgent(agentName);
    if (poolSession) {
      // Pool has a session tracked by agent name but we lost our local reference.
      // We can't recover the SquadSession handle, so remove the stale pool entry
      // and create a fresh session.
      this.client.pool.remove(poolSession.id);
    }

    const charter = await this.compileCharter(agentName);
    const systemPrompt = await this.buildSystemPrompt(agentName, charter);

    const sessionConfig: SquadSessionConfig = {
      model: charter.modelPreference ?? this.defaultModel,
      tools: this.tools,
      systemMessage: {
        mode: 'replace' as const,
        content: systemPrompt,
      },
      workingDirectory: this.workingDirectory ?? this.squadRoot,
    };

    const session = await this.client.createSession(sessionConfig);

    const now = new Date();
    const entry: AgentSessionEntry = {
      agentName,
      session,
      charter,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(agentName, entry);

    await this.eventBus.emit({
      type: 'session:created',
      sessionId: session.sessionId,
      agentName,
      payload: { role: charter.role, model: charter.modelPreference ?? this.defaultModel },
      timestamp: now,
    });

    return { session, created: true };
  }

  /**
   * Send a message to an agent, creating a session if needed.
   * Returns dispatch metadata including the session ID and whether a new session was created.
   */
  async dispatch(agentName: string, message: string, context?: string): Promise<DispatchResult> {
    const { session, created } = await this.getOrCreateSession(agentName);

    const prompt = context
      ? `${message}\n\n<context>\n${context}\n</context>`
      : message;

    await session.sendMessage({ prompt });

    // Update last-active timestamp
    const entry = this.sessions.get(agentName);
    if (entry) {
      entry.lastActiveAt = new Date();
    }

    await this.eventBus.emit({
      type: 'session:message',
      sessionId: session.sessionId,
      agentName,
      payload: { direction: 'outbound', promptLength: prompt.length },
      timestamp: new Date(),
    });

    return {
      sessionId: session.sessionId,
      status: created ? 'created_and_sent' : 'sent',
      agentName,
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
