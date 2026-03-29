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
import { getBuiltInActor } from '../agents/built-in-actors.js';
import { extractSessionLearnings } from '../agents/session-learnings.js';
import { appendToHistory, createHistoryShadow, readHistory } from '../agents/history-shadow.js';
import type { ServerPersistence, SessionRegistryEntry, ServerStateSnapshot } from './persistence.js';
import { CeremonyTriggerEngine } from './ceremony-triggers.js';
import type { CeremonyConfig } from '../config/schema.js';
import {
  applyContextWindow,
  createContextWindowState,
  type ContextWindowConfig,
  type ContextWindowState,
} from '../context/index.js';
import { injectInstructions } from '../agents/instruction-injector.js';
import { safeSendAndWait, DispatchSemaphore } from '../mcp/dispatch-utils.js';

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
  /** Enforce this model for ALL agents, overriding charter preferences */
  enforceModel?: string;
  /** Working directory for agent sessions */
  workingDirectory?: string;
  /** MCP servers to attach to agent sessions. If not provided, loaded from ~/.copilot/mcp-config.json */
  mcpServers?: Record<string, SquadMCPServerConfig>;
  /** Ceremony configurations for auto-dispatch after pipeline completion */
  ceremonies?: CeremonyConfig[];
  /** Context windowing configuration. If provided, auto-summarization is enabled. */
  contextWindowConfig?: Partial<ContextWindowConfig>;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface AgentSessionEntry {
  /** Agent name */
  agentName: string;
  /** Run ID this session belongs to (for multi-run isolation) */
  runId?: string;
  /** The live SDK session */
  session: SquadSession;
  /** Compiled charter used to create the session */
  charter: AgentCharter;
  /** Timestamp when the session was created */
  createdAt: Date;
  /** Timestamp of the last dispatched message */
  lastActiveAt: Date;
  /** Captured conversation messages */
  messages: SessionMessage[];
  /** Context windowing state — tracks summarization progress */
  contextWindowState: ContextWindowState;
  /** File paths this agent is working on (for instruction injection) */
  workingFilePaths?: string[];
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
  runId?: string;
  createdAt: Date;
  lastActiveAt: Date;
  charterRole: string;
  messageCount: number;
}

// Maximum bytes of history to include in the compiled charter prompt
const MAX_HISTORY_BYTES = 2048;

/**
 * Placeholder message recorded when an agent completes its turn via tool calls
 * (file edits, commands) but returns no text response. Exported so gates can
 * distinguish it from real agent output.
 */
export const TOOL_CALL_PLACEHOLDER = '[Agent completed turn — work performed via tool calls]';

/**
 * Extract text content from a sendAndWait response.
 * Returns null when the response is empty, undefined, or contains no text —
 * which typically means the agent did work via tool calls only.
 */
export function extractResponseContent(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result.length > 0 ? result : null;
  const r = result as Record<string, unknown>;
  if (typeof r.text === 'string' && (r.text as string).length > 0) return r.text as string;
  if (r.data && typeof (r.data as Record<string, unknown>).content === 'string') {
    const c = String((r.data as Record<string, unknown>).content);
    return c.length > 0 ? c : null;
  }
  if (typeof r.content === 'string' && (r.content as string).length > 0) return r.content as string;
  return null;
}

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
      const serverType = server.type ?? 'stdio';

      if (serverType === 'http' || serverType === 'sse') {
        // Remote MCP server
        result[name] = {
          type: serverType,
          url: server.url,
          headers: server.headers,
          tools: server.tools ?? ['*'],
        } as SquadMCPServerConfig;
      } else {
        // Local/stdio MCP server
        result[name] = {
          command: server.command,
          args: server.args ?? [],
          env: server.env,
          cwd: server.cwd,
          type: serverType,
          tools: server.tools ?? ['*'],
        } as SquadMCPServerConfig;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generate a session key for the sessions map.
 * Format: agentName::runId (or just agentName if no runId)
 */
function makeSessionKey(agentName: string, runId?: string): string {
  return runId ? `${agentName}::${runId}` : agentName;
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
  private readonly enforceModel: string | undefined;
  private readonly workingDirectory: string | undefined;
  private readonly charterCompiler: CharterCompiler;
  private readonly mcpServers: Record<string, SquadMCPServerConfig> | undefined;
  private readonly ceremonyEngine: CeremonyTriggerEngine | null;
  private readonly contextWindowConfig: Partial<ContextWindowConfig> | undefined;

  /** Optional persistence layer for crash recovery */
  private persistence: ServerPersistence | null = null;
  private serverStartedAt: string = new Date().toISOString();

  /** Active agent sessions keyed by agentName::runId (or just agentName for legacy) */
  private sessions: Map<string, AgentSessionEntry> = new Map();

  /** Dispatch semaphore to serialize sendAndWait calls (max 1 concurrent) */
  private dispatchSemaphore: DispatchSemaphore;

  constructor(config: AgentSessionManagerConfig & { dispatchSemaphore?: DispatchSemaphore }) {
    this.client = config.client;
    this.eventBus = config.eventBus;
    this.squadRoot = config.squadRoot;
    this.tools = config.tools;
    this.defaultModel = config.defaultModel;
    this.enforceModel = config.enforceModel;
    this.workingDirectory = config.workingDirectory;
    this.charterCompiler = new CharterCompiler();
    this.mcpServers = config.mcpServers ?? loadUserMCPServers();
    this.contextWindowConfig = config.contextWindowConfig;
    this.dispatchSemaphore = config.dispatchSemaphore ?? new DispatchSemaphore(1);
    this.ceremonyEngine = config.ceremonies?.length
      ? new CeremonyTriggerEngine(
          config.ceremonies,
          (agentName, message) => this.dispatch(agentName, message),
          () => Array.from(this.sessions.keys()),
        )
      : null;
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
   * Sessions are keyed by agentName::runId for multi-run isolation.
   * If no runId is provided, uses legacy single-session keying.
   */
  async getOrCreateSession(
    agentName: string,
    runId?: string
  ): Promise<{ session: SquadSession; created: boolean; resolvedName: string; sessionKey: string }> {
    // Resolve abbreviated names (e.g. "koba" → "kobayashi") then normalize case
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const sessionKey = makeSessionKey(resolved, runId);

    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return { session: existing.session, created: false, resolvedName: resolved, sessionKey };
    }

    // Check the pool for an orphaned session (e.g. created outside this manager)
    const poolSession = this.client.pool.findByAgent(resolved);
    if (poolSession) {
      this.client.pool.remove(poolSession.id);
    }

    const charter = await this.compileCharter(resolved);
    
    // Get working file paths from existing session (if any) for instruction injection
    const existingEntry = this.sessions.get(resolved);
    const workingFilePaths = existingEntry?.workingFilePaths;

    // --- Tool filtering: unified for both built-in actors and chartered agents ---
    // Priority: built-in allowedTools > charter excludedTools > charter allowedTools > all tools
    const builtIn = getBuiltInActor(resolved);
    let sessionTools: SquadTool<any>[];

    if (builtIn?.allowedTools) {
      // Built-in actors: strict allowlist from code
      sessionTools = this.tools.filter(t => builtIn.allowedTools!.includes(t.name));
    } else if (charter.excludedTools && charter.excludedTools.length > 0) {
      // Chartered agents with excludedTools: remove specific tools
      const excluded = new Set(charter.excludedTools);
      sessionTools = this.tools.filter(t => !excluded.has(t.name));
    } else if (charter.allowedTools && charter.allowedTools.length > 0) {
      // Chartered agents with allowedTools: strict allowlist
      const allowed = new Set(charter.allowedTools);
      sessionTools = this.tools.filter(t => allowed.has(t.name));
    } else {
      // Default: all tools
      sessionTools = this.tools;
    }

    const systemPrompt = await this.buildSystemPrompt(resolved, charter, workingFilePaths, sessionTools);

    // Note: MCP tools are provided via the MCP Bridge (tools/mcp-bridge.ts) which
    // spawns MCP servers at squad server startup and registers their tools as squad tools.
    // The native SessionConfig.mcpServers path is not used because the copilot CLI
    // doesn't expose MCP server tools to programmatic SDK sessions.

    const sessionConfig: SquadSessionConfig = {
      // enforceModel overrides everything — charter preferences ignored
      // defaultModel is fallback when charter doesn't specify
      model: this.enforceModel ?? charter.modelPreference ?? this.defaultModel,
      tools: sessionTools,
      systemMessage: {
        mode: 'replace' as const,
        content: systemPrompt,
      },
      workingDirectory: this.workingDirectory ?? this.squadRoot,
      onPermissionRequest: () => ({ kind: 'approved' as const }),
    };

    const session = await this.client.createSession(sessionConfig);

    const now = new Date();
    const entry: AgentSessionEntry = {
      agentName: resolved,
      runId,
      session,
      charter,
      createdAt: now,
      lastActiveAt: now,
      messages: [],
      contextWindowState: createContextWindowState(),
    };
    this.sessions.set(sessionKey, entry);

    // Subscribe to session events to capture assistant responses
    try {
      session.on('message', (event) => {
        const content = typeof event.content === 'string' ? event.content
          : typeof event.text === 'string' ? event.text
          : JSON.stringify(event);
        entry.messages.push({
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        });
        entry.lastActiveAt = new Date();
      });
    } catch {
      // Session may not support event subscription — continue without
    }

    // Persist registry after new session creation
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    await this.eventBus.emit({
      type: 'session:created',
      sessionId: session.sessionId,
      agentName: resolved,
      payload: { role: charter.role, model: charter.modelPreference ?? this.defaultModel, runId },
      timestamp: now,
    });

    return { session, created: true, resolvedName: resolved, sessionKey };
  }

  /**
   * Send a message to an agent, creating a session if needed.
   * Returns dispatch metadata including the session ID and whether a new session was created.
   * 
   * @param agentName - Name of the agent to dispatch to
   * @param message - Message to send
   * @param context - Optional context to append
   * @param runId - Optional run ID for multi-run isolation
   */
  async dispatch(agentName: string, message: string, context?: string, runId?: string): Promise<DispatchResult> {
    const { session, created, resolvedName, sessionKey } = await this.getOrCreateSession(agentName, runId);

    const prompt = context
      ? `${message}\n\n<context>\n${context}\n</context>`
      : message;

    this.ceremonyEngine?.onActivity();

    const entry = this.sessions.get(sessionKey);
    if (entry) {
      entry.lastActiveAt = new Date();
      entry.messages.push({
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      });
    }

    // Use safeSendAndWait with semaphore protection to capture the assistant's response
    if (session.sendAndWait) {
      try {
        // Acquire semaphore before sending (max 1 concurrent sendAndWait)
        const release = await this.dispatchSemaphore.acquire();
        try {
          const result = await safeSendAndWait(session, prompt, 90_000);
          const content = extractResponseContent(result);
          if (entry) {
            if (content) {
              entry.messages.push({ role: 'assistant', content, timestamp: new Date().toISOString() });
            } else if (result != null) {
              // Agent completed its turn but returned empty text — likely did work via
              // tool calls (file edits, commands). Record a placeholder so waitForResponse
              // can detect that the turn finished instead of timing out.
              entry.messages.push({
                role: 'assistant',
                content: TOOL_CALL_PLACEHOLDER,
                timestamp: new Date().toISOString(),
              });
            }
          }
        } finally {
          release();
        }
      } catch (error: any) {
        // Check if this is a "Session not found" error
        const isSessionNotFound = error?.message?.includes('Session not found') || 
                                  error?.toString?.()?.includes('Session not found');
        
        if (isSessionNotFound) {
          // Session expired — remove stale session and retry with a fresh one
          this.sessions.delete(sessionKey);
          try {
            const { session: newSession, sessionKey: newKey } = await this.getOrCreateSession(agentName, runId);
            if (newSession.sendAndWait) {
              const release = await this.dispatchSemaphore.acquire();
              try {
                const retryResult = await safeSendAndWait(newSession, prompt, 90_000);
                const retryContent = extractResponseContent(retryResult);
                const newEntry = this.sessions.get(newKey);
                if (newEntry) {
                  if (retryContent) {
                    newEntry.messages.push({ role: 'assistant', content: retryContent, timestamp: new Date().toISOString() });
                  } else if (retryResult != null) {
                    newEntry.messages.push({
                      role: 'assistant',
                      content: TOOL_CALL_PLACEHOLDER,
                      timestamp: new Date().toISOString(),
                    });
                  }
                }
              } finally {
                release();
              }
            } else {
              // New session doesn't support sendAndWait — fall back to sendMessage
              await newSession.sendMessage({ prompt });
            }
          } catch {
            // Retry failed — fall back to fire-and-forget with the new session
            const currentEntry = this.sessions.get(sessionKey);
            if (currentEntry?.session) {
              await currentEntry.session.sendMessage({ prompt });
            }
          }
        } else {
          // Timeout or other error — fall back to fire-and-forget
          await session.sendMessage({ prompt });
        }
      }
    } else {
      await session.sendMessage({ prompt });
    }

    // Persist updated lastMessageAt
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    // Apply context windowing if configured
    if (this.contextWindowConfig && entry) {
      await this.maybeApplyContextWindow(entry);
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
   * Set the working file paths for an agent session.
   * This enables instruction injection based on which files the agent is working on.
   * The system prompt will be updated on the next session creation to include relevant instructions.
   */
  setWorkingFilePaths(agentName: string, filePaths: string[]): void {
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const entry = this.sessions.get(resolved);
    if (entry) {
      entry.workingFilePaths = filePaths;
    }
  }

  /**
   * Get the working file paths for an agent session.
   */
  getWorkingFilePaths(agentName: string): string[] | undefined {
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const entry = this.sessions.get(resolved);
    return entry?.workingFilePaths;
  }

  /**
   * Compile a charter for the given agent.
   * Priority: workspace .squad/agents/{name}/charter.md > SDK built-in actor > generic fallback.
   */
  async compileCharter(agentName: string): Promise<AgentCharter> {
    const charterPath = path.join(this.squadRoot, '.squad', 'agents', agentName, 'charter.md');

    try {
      const charter = await this.charterCompiler.compile(charterPath);
      console.log(`[Charter Loading] ✓ Successfully loaded charter for ${agentName}`);
      return charter;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      
      const builtIn = getBuiltInActor(agentName);
      if (builtIn) {
        console.error(`[Charter Loading] ✗ Failed to load charter for ${agentName} at ${charterPath}`);
        console.error(`[Charter Loading]   Error: ${errorMsg}`);
        if (errorStack) {
          console.error(`[Charter Loading]   Stack: ${errorStack}`);
        }
        console.warn(`[Charter Loading] → Using built-in charter as fallback`);
        return {
          name: builtIn.name,
          displayName: builtIn.displayName,
          role: builtIn.role,
          expertise: builtIn.expertise,
          style: builtIn.style,
          prompt: builtIn.charter,
        };
      }

      console.error(`[Charter Loading] ✗ Failed to load charter for ${agentName} at ${charterPath}`);
      console.error(`[Charter Loading]   Error: ${errorMsg}`);
      if (errorStack) {
        console.error(`[Charter Loading]   Stack: ${errorStack}`);
      }
      console.warn(`[Charter Loading] → Using generic fallback. Agent may lack squad_pulse() instrumentation.`);
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
   * 
   * @param agentName - The agent name
   * @param charter - The compiled charter
   * @param workingFilePaths - Optional list of file paths the agent is working on (for instruction injection)
   */
  private async buildSystemPrompt(agentName: string, charter: AgentCharter, workingFilePaths?: string[], sessionTools?: SquadTool<any>[]): Promise<string> {
    try {
      const sections: string[] = [];

      // 1. Agent identity header
      try {
        sections.push(`# ${charter.displayName}\n`);
        sections.push(`**Role:** ${charter.role}`);
        if (charter.expertise && charter.expertise.length > 0) {
          sections.push(`**Expertise:** ${charter.expertise.join(', ')}`);
        }
        if (charter.style) {
          sections.push(`**Style:** ${charter.style}`);
        }
        sections.push('');
      } catch (err) {
        console.error(`[System Prompt] ✗ Error building identity header for ${agentName}: ${err}`);
        sections.push(`# ${agentName}\n`);
        sections.push('');
      }

      // 2. Charter content
      try {
        if (charter.prompt) {
          sections.push(charter.prompt);
          sections.push('');
        } else {
          console.warn(`[System Prompt] ⚠ Charter for ${agentName} has no prompt content`);
          sections.push(`You are ${agentName}, a squad agent.`);
          sections.push('');
        }
      } catch (err) {
        console.error(`[System Prompt] ✗ Error adding charter content for ${agentName}: ${err}`);
        sections.push(`You are ${agentName}, a squad agent.`);
        sections.push('');
      }

      // 3. Project-specific instructions (auto-injected for all agents)
      try {
        const instructionsSection = injectInstructions(this.squadRoot);
        if (instructionsSection) {
          sections.push(instructionsSection);
          sections.push('');
        }
      } catch (err) {
        console.error(`[System Prompt] ✗ Error injecting instructions for ${agentName}: ${err}`);
      }

      // 4. Recent history — section-aware injection
      //    Prioritize Learnings + Decisions (most actionable), then Patterns + Issues.
      //    Skip raw Context section (already in charter) and References (low signal).
      try {
        const historyInjection = this.buildHistoryInjection(agentName);
        if (historyInjection) {
          sections.push('## Recent History\n');
          sections.push(historyInjection);
          sections.push('');
        }
      } catch (err) {
        console.error(`[System Prompt] ✗ Error building history injection for ${agentName}: ${err}`);
        // Continue without history - not critical
      }

      // 5. Team decisions
      try {
        const decisionsContent = this.readFileSafe(
          path.join(this.squadRoot, '.squad', 'decisions.md'),
        );
        if (decisionsContent) {
          sections.push('## Team Decisions\n');
          sections.push(decisionsContent);
          sections.push('');
        }
      } catch (err) {
        console.error(`[System Prompt] ✗ Error reading team decisions for ${agentName}: ${err}`);
        // Continue without decisions - not critical
      }

      // 6. Available squad tools (SDK-injected)
      try {
        const toolNames = this.tools.map(t => t.name);
        const hasSDKTools = toolNames.some(n => n === 'squad_route');
      } catch (err) {
        console.error(`[System Prompt] ✗ Error checking squad tools for ${agentName}: ${err}`);
      }

      // 7. Available tools — list only the tools this agent's session actually has.
      // Tool filtering happens at session creation (see getOrCreateSession).
      // The system prompt simply documents what the agent can call.
      try {
        const toolNames = sessionTools?.map(t => t.name) ?? this.tools.map(t => t.name);
        if (toolNames.length > 0) {
          sections.push('## Available Tools\n');
          sections.push('You have the following tools available:');
          for (const name of toolNames) {
            sections.push(`- \`${name}\``);
          }
          sections.push('');
          sections.push('**Work directly.** Use your tools to complete the task yourself. Do not simulate or role-play other agents.');
          sections.push('');
        }
      } catch (err) {
        console.error(`[System Prompt] ✗ Error building tools section for ${agentName}: ${err}`);
      }

      const result = sections.join('\n');
      
      if (result.length < 50) {
        console.error(`[System Prompt] ✗ Generated system prompt for ${agentName} is suspiciously short (${result.length} chars). This may indicate a problem.`);
      } else {
        console.log(`[System Prompt] ✓ Successfully built system prompt for ${agentName} (${result.length} chars)`);
      }
      
      return result;
    } catch (err) {
      // Catastrophic failure - return minimal fallback prompt
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      
      console.error(`[System Prompt] ✗✗✗ CRITICAL: Failed to build system prompt for ${agentName}`);
      console.error(`[System Prompt]     Error: ${errorMsg}`);
      if (errorStack) {
        console.error(`[System Prompt]     Stack: ${errorStack}`);
      }
      console.warn(`[System Prompt] → Returning minimal fallback prompt`);
      
      // Return absolute minimal prompt as last resort
      return `# ${charter?.displayName || agentName}

${charter?.prompt || `You are ${agentName}, a squad agent. Your charter failed to load properly - please check the logs.`}

## Squad Communication

You can communicate with other squad members using these tools:
- \`squad_route(targetAgent, task, context?)\` — Send a task to another agent
- \`squad_send(agentName, message)\` — Send a message and wait for response
- \`squad_read_session(agentName, lastN?)\` — Read an agent's conversation history
- \`squad_decide(author, summary, body)\` — Record a team decision
- \`squad_memory(agent, section, content)\` — Append to an agent's history
- \`squad_status()\` — Check session pool state`;
    }
  }

  /**
   * Merge global MCP servers with charter-declared MCP servers.
   * 
   * Charter's ## MCP Servers section can:
   * 1. Reference servers by name → pulls config from global mcpServers (loaded from ~/.copilot/mcp-config.json)
   * 2. Apply tool filters → overrides the tools list for that server
   * 
   * If a charter declares no MCP servers, all global servers are passed through (current behavior).
   * If a charter declares specific servers, only those servers are included (whitelist mode).
   */
  private mergeMcpServers(charter: AgentCharter): Record<string, SquadMCPServerConfig> | undefined {
    const charterMcp = charter.mcpServers;
    
    // No charter MCP declarations → pass through all global servers (backward compatible)
    if (!charterMcp || Object.keys(charterMcp).length === 0) {
      return this.mcpServers;
    }

    // No global servers to reference → nothing to merge
    if (!this.mcpServers) {
      return undefined;
    }

    // Charter declares specific servers → whitelist mode
    const merged: Record<string, SquadMCPServerConfig> = {};

    for (const [name, decl] of Object.entries(charterMcp)) {
      const globalServer = this.mcpServers[name];
      if (!globalServer) continue; // Charter references a server we don't have — skip

      // Clone the global config and apply charter's tool filter if specified
      const serverConfig = { ...globalServer };
      if (decl.tools && decl.tools.length > 0) {
        serverConfig.tools = decl.tools;
      }
      merged[name] = serverConfig;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Gracefully close a specific agent's session.
   * Extracts learnings from the conversation and persists them to the
   * agent's history shadow before destroying the session.
   */
  /**
   * Close a specific agent session.
   * If runId is provided, closes only that specific run's session.
   * Otherwise closes the legacy single-session or the first matching session.
   */
  async closeSession(agentName: string, runId?: string): Promise<void> {
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const sessionKey = makeSessionKey(resolved, runId);
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;

    // Capture data BEFORE deletion for learning persistence
    const capturedMessages = [...entry.messages];
    const sessionDuration = Date.now() - entry.createdAt.getTime();

    // Extract and persist learnings from this session (best-effort)
    await this.persistSessionLearnings(resolved, capturedMessages);

    try {
      await entry.session.close();
    } catch {
      // Session may already be closed — that's fine
    }

    // Remove from session pool to free capacity
    this.client.pool.remove(entry.session.sessionId);

    this.sessions.delete(sessionKey);

    // Persist registry after session removal
    if (this.persistence) {
      try { this.persistence.saveRegistry(this.getRegistryEntries()); } catch { /* best-effort */ }
    }

    await this.eventBus.emit({
      type: 'session:destroyed',
      sessionId: entry.session.sessionId,
      agentName: resolved,
      payload: {
        durationMs: sessionDuration,
        messages: capturedMessages,
        messageCount: capturedMessages.length,
        runId: entry.runId,
      },
      timestamp: new Date(),
    });

    this.ceremonyEngine?.onSessionClosed(resolved);
  }

  /**
   * Close all sessions for a specific run.
   */
  async closeRunSessions(runId: string): Promise<void> {
    const sessionKeys = Array.from(this.sessions.keys()).filter(key => key.includes(`::${runId}`));
    await Promise.allSettled(sessionKeys.map(key => {
      const agentName = key.split('::')[0];
      return this.closeSession(agentName!, runId);
    }));
  }

  /**
   * Close all active agent sessions.
   */
  async closeAll(): Promise<void> {
    this.ceremonyEngine?.disable();
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
      runId: entry.runId,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      charterRole: entry.charter.role,
      messageCount: entry.messages.length,
    }));
  }

  /**
   * Get conversation messages for a specific agent session.
   * If runId is provided, looks up the session key; otherwise uses legacy lookup.
   */
  getMessages(agentName: string, runId?: string): SessionMessage[] {
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const sessionKey = makeSessionKey(resolved, runId);
    return this.sessions.get(sessionKey)?.messages ?? [];
  }

  /**
   * Send a follow-up message to an existing agent session.
   * 
   * @param agentName - Name of the agent
   * @param message - Follow-up message to send
   * @param runId - Optional run ID for multi-run isolation
   */
  async sendFollowUp(agentName: string, message: string, runId?: string): Promise<string | null> {
    const resolved = resolveAgentName(this.squadRoot, agentName).toLowerCase();
    const sessionKey = makeSessionKey(resolved, runId);
    const entry = this.sessions.get(sessionKey);
    if (!entry) throw new Error(`No active session for ${resolved}${runId ? ` (runId: ${runId})` : ''}`);

    entry.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
    entry.lastActiveAt = new Date();

    // Use safeSendAndWait with semaphore protection if available
    if (entry.session.sendAndWait) {
      try {
        const release = await this.dispatchSemaphore.acquire();
        try {
          const result = await safeSendAndWait(entry.session, message, 90_000);
          const content = extractResponseContent(result);
          if (content) {
            entry.messages.push({ role: 'assistant', content, timestamp: new Date().toISOString() });
          } else if (result != null) {
            // Agent completed its turn with empty text — likely did work via tool calls.
            const placeholder = TOOL_CALL_PLACEHOLDER;
            entry.messages.push({ role: 'assistant', content: placeholder, timestamp: new Date().toISOString() });
            return placeholder;
          }
          return content;
        } finally {
          release();
        }
      } catch (error: any) {
        // Check if this is a "Session not found" error
        const isSessionNotFound = error?.message?.includes('Session not found') || 
                                  error?.toString?.()?.includes('Session not found');
        
        if (isSessionNotFound) {
          // Session expired — remove stale session and retry with a fresh one
          this.sessions.delete(sessionKey);
          try {
            const { session: newSession, sessionKey: newKey } = await this.getOrCreateSession(agentName, runId);
            if (newSession.sendAndWait) {
              const release = await this.dispatchSemaphore.acquire();
              try {
                const retryResult = await safeSendAndWait(newSession, message, 90_000);
                const retryContent = extractResponseContent(retryResult);
                const newEntry = this.sessions.get(newKey);
                if (newEntry) {
                  if (retryContent) {
                    newEntry.messages.push({ role: 'assistant', content: retryContent, timestamp: new Date().toISOString() });
                  } else if (retryResult != null) {
                    const placeholder = TOOL_CALL_PLACEHOLDER;
                    newEntry.messages.push({ role: 'assistant', content: placeholder, timestamp: new Date().toISOString() });
                    return placeholder;
                  }
                }
                return retryContent;
              } finally {
                release();
              }
            } else {
              // New session doesn't support sendAndWait — fall back to sendMessage
              await newSession.sendMessage({ prompt: message });
              return null;
            }
          } catch {
            // Retry failed — fall back to fire-and-forget with the new session
            const currentEntry = this.sessions.get(sessionKey);
            if (currentEntry?.session) {
              await currentEntry.session.sendMessage({ prompt: message });
            }
            return null;
          }
        } else {
          // Timeout or other error — fall back to fire-and-forget
          await entry.session.sendMessage({ prompt: message });
          return null;
        }
      }
    }

    await entry.session.sendMessage({ prompt: message });
    return null;
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
   * Wait until no session has had activity for `idleMs` milliseconds.
   * Resolves with a summary of what happened. Rejects on timeout.
   */
  waitForIdle(idleMs: number, timeoutMs: number): Promise<{ agents: string[]; totalMessages: number; durationMs: number }> {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`waitForIdle timed out after ${timeoutMs}ms`));
          return;
        }

        const sessions = Array.from(this.sessions.values());
        if (sessions.length === 0) {
          resolve({ agents: [], totalMessages: 0, durationMs: Date.now() - startTime });
          return;
        }

        const lastActivity = Math.max(...sessions.map(s => s.lastActiveAt.getTime()));
        const elapsed = Date.now() - lastActivity;

        if (elapsed >= idleMs) {
          const agents = sessions.map(s => s.agentName);
          const totalMessages = sessions.reduce((sum, s) => sum + s.messages.length, 0);
          resolve({ agents, totalMessages, durationMs: Date.now() - startTime });
          return;
        }

        setTimeout(check, Math.min(5000, idleMs - elapsed + 500));
      };
      setTimeout(check, idleMs);
    });
  }

  /**
   * Apply context windowing to a session if the message count exceeds the threshold.
   * Replaces older messages with a summary to keep token usage bounded.
   *
   * Scope: This operates on Squad's tracking layer (entry.messages), which is the
   * source for squad_read_session, inter-agent communication, and observability.
   * The Copilot SDK session maintains its own LLM context internally.
   */
  private async maybeApplyContextWindow(entry: AgentSessionEntry): Promise<void> {
    try {
      const result = await applyContextWindow(
        entry.messages,
        entry.contextWindowState,
        this.contextWindowConfig,
      );

      if (result.summarized) {
        entry.messages = result.messages;
        entry.contextWindowState = result.state;
      }
    } catch {
      // Context windowing failure is non-fatal — continue with full history
    }
  }

  /**
   * Build a section-aware history injection for the system prompt.
   *
   * Prioritizes actionable sections (Learnings, Decisions) over contextual
   * ones (Patterns, Issues). Respects MAX_HISTORY_BYTES budget. Returns
   * null if no history exists or all sections are empty.
   */
  private buildHistoryInjection(agentName: string): string | null {
    try {
      const historyContent = this.readFileSafe(
        path.join(this.squadRoot, '.squad', 'agents', agentName, 'history.md'),
      );
      if (!historyContent) return null;

      // Parse sections in priority order
      const prioritySections = ['Learnings', 'Decisions', 'Patterns', 'Issues'] as const;
      const extracted: string[] = [];
      let totalLength = 0;

      for (const sectionName of prioritySections) {
        try {
          const sectionRegex = new RegExp(
            `^##\\s+${sectionName}\\s*$([\\s\\S]*?)(?=^##\\s|$)`,
            'm',
          );
          const match = historyContent.match(sectionRegex);
          if (!match) continue;

          const content = match[1]!.trim();
          // Skip empty sections or placeholder comments
          if (!content || /^<!--.*-->$/.test(content)) continue;

          const sectionBlock = `### ${sectionName}\n\n${content}`;

          // Respect budget — stop adding sections when we'd exceed the limit
          if (totalLength + sectionBlock.length > MAX_HISTORY_BYTES) {
            // Try to fit a truncated version
            const remaining = MAX_HISTORY_BYTES - totalLength;
            if (remaining > 100) {
              extracted.push(`### ${sectionName}\n\n…${content.slice(-(remaining - 30))}`);
            }
            break;
          }

          extracted.push(sectionBlock);
          totalLength += sectionBlock.length;
        } catch (err) {
          console.error(`[History Injection] ✗ Error processing section ${sectionName} for ${agentName}: ${err}`);
          // Continue to next section
        }
      }

      return extracted.length > 0 ? extracted.join('\n\n') : null;
    } catch (err) {
      console.error(`[History Injection] ✗ Failed to build history injection for ${agentName}: ${err}`);
      return null;
    }
  }

  /**
   * Extract learnings from a session's messages and persist them to the
   * agent's history shadow. Best-effort — failures are swallowed to avoid
   * blocking session teardown.
   */
  private async persistSessionLearnings(
    agentName: string,
    messages: SessionMessage[],
  ): Promise<void> {
    try {
      if (messages.length === 0) return;

      const result = extractSessionLearnings(messages, agentName);
      if (!result.hasContent) return;

      // Ensure the history shadow exists
      await createHistoryShadow(this.squadRoot, agentName);

      // Append each extracted section
      for (const learning of result.learnings) {
        await appendToHistory(
          this.squadRoot,
          agentName,
          learning.section,
          learning.content,
        );
      }
    } catch {
      // Learning persistence is best-effort — never block session close
    }
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
