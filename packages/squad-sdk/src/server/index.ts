/**
 * Squad Orchestration Server
 *
 * Persistent Node.js process that manages agent sessions, enables
 * inter-agent communication via squad_dispatch/squad_send, and provides monitoring
 * via EventBus + optional RemoteBridge.
 *
 * Wires together all SDK primitives:
 *   SquadClientWithPool → SquadCoordinator → AgentSessionManager → ToolRegistry
 *                                              ↕
 *                                          EventBus ──→ RemoteBridge (optional)
 */

import { SquadClientWithPool, type SquadClientWithPoolConfig } from '../client/index.js';
import { SquadCoordinator, type SquadCoordinatorOptions } from '../coordinator/index.js';
import { McpBridge } from '../tools/mcp-bridge.js';
import { ToolRegistry } from '../tools/index.js';
import { EventBus } from '../runtime/event-bus.js';
import { RemoteBridge } from '../remote/bridge.js';
import type { RemoteBridgeConfig } from '../remote/types.js';
import type { SquadConfig } from '../runtime/config.js';
import type { CeremonyConfig } from '../config/schema.js';
import type { SquadSession } from '../adapter/types.js';
import { AgentSessionManager, type AgentSessionManagerConfig, type DispatchResult, type ActiveSessionInfo } from './agent-lifecycle.js';
import { ServerPersistence, type PersistenceConfig, type ServerStateSnapshot } from './persistence.js';
import { EventHistory, type HistoryEvent } from './event-history.js';
import { PulseCollector, createPulse as createPulseFn, filterPulseForUser as filterPulseFn } from '../pulse/index.js';
import { Scratchpad } from '../scratchpad/index.js';
import { enableLearningPersistence } from '../agents/learning-persistence.js';
import type { UnsubscribeFn } from '../runtime/event-bus.js';

// ============================================================================
// Types
// ============================================================================

export interface SquadServerConfig {
  /** Squad configuration (from squad.config.ts or loadConfig()) */
  squadConfig: SquadConfig;
  /** Client connection options */
  clientConfig?: Partial<SquadClientWithPoolConfig>;
  /** Squad root directory (for charter/history file resolution) */
  squadRoot?: string;
  /** Enable RemoteBridge for WebSocket monitoring */
  enableRemote?: boolean;
  /** RemoteBridge port (0 = auto) */
  remotePort?: number;
  /** Default model for agents without a charter-specified model */
  defaultModel?: string;
  /** Working directory for agent sessions */
  workingDirectory?: string;
}

export interface SquadServerStatus {
  /** Whether the server is running */
  running: boolean;
  /** Number of active agent sessions */
  activeSessions: number;
  /** Session pool capacity */
  poolCapacity: number;
  /** Whether the client is connected to the host */
  connectedToHost: boolean;
  /** Active agent details */
  agents: ActiveSessionInfo[];
  /** RemoteBridge state (if enabled) */
  remoteState?: 'stopped' | 'starting' | 'running' | 'error';
}

// ============================================================================
// SquadServer
// ============================================================================

export class SquadServer {
  private readonly config: SquadServerConfig;
  private readonly eventBus: EventBus;
  private readonly eventHistory: EventHistory;
  private readonly toolRegistry: ToolRegistry;
  private readonly persistence: ServerPersistence;
  private readonly pulseCollector: PulseCollector;
  private readonly scratchpad: Scratchpad;
  private readonly serverStartedAt: string;

  private client: SquadClientWithPool | null = null;
  private coordinator: SquadCoordinator | null = null;
  private sessionManager: AgentSessionManager | null = null;
  private remoteBridge: RemoteBridge | null = null;
  private mcpBridge: McpBridge | null = null;
  private running = false;
  private learningUnsubscribe: UnsubscribeFn | null = null;

  constructor(config: SquadServerConfig) {
    this.config = config;
    this.eventBus = new EventBus();
    this.eventHistory = new EventHistory(100);
    this.serverStartedAt = new Date().toISOString();

    // Subscribe to all EventBus events and record in history
    this.eventBus.subscribeAll(async (event) => {
      const summary = this.summarizeEvent(event);
      if (summary) {
        this.eventHistory.push({
          type: event.type,
          agentName: event.agentName,
          summary,
          details: event.payload as Record<string, unknown>,
        });
      }
    });

    const squadRoot = config.squadRoot ?? process.cwd();

    // Initialize persistence for crash recovery
    this.persistence = new ServerPersistence({
      squadRoot,
      autoSave: true,
      autoSaveInterval: 30_000,
    });

    // Initialize ToolRegistry with lazy getters so it can reference
    // components that aren't created until start().
    this.pulseCollector = new PulseCollector();
    this.scratchpad = new Scratchpad();

    this.toolRegistry = new ToolRegistry(
      // squadRoot for file-based tools (decisions, history, skills)
      squadRoot,
      // sessionPoolGetter — returns the SessionPool once client is connected
      () => this.client?.pool ?? null,
      // dispatchGetter — returns the dispatch function once session manager exists
      () => {
        if (!this.sessionManager) return undefined;
        const mgr = this.sessionManager;
        return async (agentName: string, task: string, context?: string) => {
          const result = await mgr.dispatch(agentName, task, context);
          return { sessionId: result.sessionId, status: result.status };
        };
      },
      // sendFollowUpGetter — returns the sendFollowUp function for squad_send
      () => {
        if (!this.sessionManager) return undefined;
        const mgr = this.sessionManager;
        return async (agentName: string, message: string) => {
          return mgr.sendFollowUp(agentName, message);
        };
      },
      // getMessagesGetter — returns the getMessages function for squad_read_session
      () => {
        if (!this.sessionManager) return undefined;
        const mgr = this.sessionManager;
        return (agentName: string) => {
          return mgr.getMessages(agentName);
        };
      },
      // pulseRecordGetter — records a pulse in the shared collector
      () => {
        const collector = this.pulseCollector;
        return (pulse: { agent: string; phase: string; status: string; progressPct: number; summary: string; blockers?: string[]; questionsForUser?: string[]; artifacts?: string[]; nextStep?: string }) => {
          const p = createPulseFn({
            agent: pulse.agent,
            phase: pulse.phase as any,
            status: (pulse.status ?? 'ok') as any,
            progressPct: pulse.progressPct ?? 0,
            summary: pulse.summary,
            blockers: pulse.blockers ?? [],
            questionsForUser: pulse.questionsForUser ?? [],
            artifacts: pulse.artifacts ?? [],
            nextStep: pulse.nextStep ?? '',
          });
          return collector.record(p);
        };
      },
      // scratchpadGetter — returns the shared scratchpad
      () => this.scratchpad,
    );
  }

  /**
   * Start the orchestration server.
   *
   * 1. Connect SquadClientWithPool to the host
   * 2. Create AgentSessionManager for on-demand session lifecycle
   * 3. Initialize SquadCoordinator for message routing
   * 4. Optionally start RemoteBridge for WebSocket monitoring
   * 5. Wire EventBus between all components
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('SquadServer is already running');
    }

    const squadRoot = this.config.squadRoot ?? process.cwd();

    // 1. Create and connect the client
    this.client = new SquadClientWithPool(this.config.clientConfig ?? {});
    await this.client.connect();

    // 1b. Initialize MCP Bridge — spawn external MCP servers and discover tools
    this.mcpBridge = new McpBridge({
      squadRoot,
      skipServers: ['squad'],
      skipPattern: /squad/i,
    });
    try {
      const bridgedTools = await this.mcpBridge.initialize();
      for (const tool of bridgedTools) {
        this.toolRegistry.registerTool(tool);
      }
      const bridgeStatus = this.mcpBridge.getStatus();
      if (bridgeStatus.length > 0) {
        process.stderr.write(`[mcp-bridge] Bridged ${bridgeStatus.map(s => `${s.name}(${s.toolCount})`).join(', ')} tools\n`);
      }
    } catch (err) {
      process.stderr.write(`[mcp-bridge] Failed to initialize: ${err instanceof Error ? err.message : err}\n`);
    }

    // 2. Create the agent session manager
    this.sessionManager = new AgentSessionManager({
      client: this.client,
      eventBus: this.eventBus,
      squadRoot,
      tools: this.toolRegistry.getTools(),
      defaultModel: this.config.defaultModel ?? this.config.squadConfig.models?.defaultModel,
      workingDirectory: this.config.workingDirectory ?? squadRoot,
      ceremonies: this.config.squadConfig.ceremonies as CeremonyConfig[] | undefined,
    });

    // Wire persistence into session manager and load any saved state
    this.sessionManager.setPersistence(this.persistence, this.serverStartedAt);

    const savedState = this.persistence.loadState();
    if (savedState) {
      process.stderr.write(`[persistence] Previous state had ${savedState.sessions.length} session(s) from ${savedState.savedAt} — clearing stale state for fresh start\n`);
      // Clear stale state: old sessions can't be reconnected after process restart
      this.persistence.saveState({
        version: 1,
        savedAt: new Date().toISOString(),
        serverStartedAt: this.serverStartedAt,
        sessions: [],
        poolSize: 0,
        poolCapacity: this.client.pool.size,
      });
    }

    // 3. Initialize the coordinator with fan-out deps wired to session manager
    const coordinatorOptions: SquadCoordinatorOptions = {
      config: this.config.squadConfig,
      eventBus: this.eventBus,
      fanOutDeps: {
        compileCharter: async (agentName: string) => {
          return this.sessionManager!.compileCharter(agentName);
        },
        resolveModel: async (charter, override) => {
          return override ?? charter.modelPreference ?? this.config.squadConfig.models?.defaultModel ?? 'claude-sonnet-4.5';
        },
        createSession: async (config: any) => {
          const agentName: string = config.agentName ?? config.name ?? 'unknown';
          const { session } = await this.sessionManager!.getOrCreateSession(agentName);
          return {
            sessionId: session.sessionId,
            sendMessage: async (opts: any) => {
              await session.sendMessage(opts);
            },
          };
        },
        sessionPool: this.client.pool,
        eventBus: this.eventBus as any, // runtime EventBus is compatible with fan-out's expected interface
      },
    };
    this.coordinator = new SquadCoordinator(coordinatorOptions);

    // 4. Optionally start RemoteBridge
    if (this.config.enableRemote) {
      const bridgeConfig: RemoteBridgeConfig = {
        port: this.config.remotePort ?? 0,
        maxHistory: 500,
        repo: '',
        branch: '',
        machine: '',
        squadDir: squadRoot,
      };
      this.remoteBridge = new RemoteBridge(bridgeConfig);

      // Forward all EventBus events to RemoteBridge as messages
      this.eventBus.subscribeAll(async (event) => {
        if (this.remoteBridge) {
          const role = event.type.startsWith('session:') ? 'system' : 'agent';
          this.remoteBridge.addMessage(
            role as 'system' | 'agent',
            `[${event.type}] ${event.agentName ?? ''}: ${JSON.stringify(event.payload)}`,
            event.agentName,
          );
        }
      });

      await this.remoteBridge.start();
    }

    // 5. Enable cross-session learning persistence
    this.learningUnsubscribe = enableLearningPersistence(
      this.eventBus,
      this.pulseCollector,
      {
        enabled: true,
        minMessages: 5,
        maxSectionLength: 500,
        squadRoot,
      },
    );

    this.running = true;

    // Start auto-save after all components are ready
    this.persistence.startAutoSave(() => this.getStateSnapshot());
  }

  /**
   * Graceful shutdown — close all sessions, disconnect client, stop RemoteBridge.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    // Save final state and stop auto-save before tearing down components
    try {
      this.persistence.saveState(this.getStateSnapshot());
    } catch { /* best-effort final save */ }
    this.persistence.stopAutoSave();

    // 1. Close all agent sessions
    if (this.sessionManager) {
      await this.sessionManager.closeAll();
      this.sessionManager = null;
    }

    // 2. Stop RemoteBridge
    if (this.remoteBridge) {
      await this.remoteBridge.stop();
      this.remoteBridge = null;
    }

    // 2b. Shut down MCP bridge
    if (this.mcpBridge) {
      await this.mcpBridge.shutdown();
      this.mcpBridge = null;
    }

    // 3. Disconnect client
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }

    // 4. Clear event handlers and ephemeral state
    if (this.learningUnsubscribe) {
      this.learningUnsubscribe();
      this.learningUnsubscribe = null;
    }
    this.eventBus.clear();
    this.scratchpad.clear();

    this.coordinator = null;
    this.running = false;
  }

  /**
   * Send a message to a specific agent (creates session if needed via AgentSessionManager).
   *
   * @param agentName - Name of the target agent
   * @param message - Message/task content
   * @param context - Optional additional context
   * @returns Dispatch result with session ID and status
   */
  async dispatch(agentName: string, message: string, context?: string): Promise<DispatchResult> {
    if (!this.running || !this.sessionManager) {
      throw new Error('SquadServer is not running. Call start() first.');
    }
    return this.sessionManager.dispatch(agentName, message, context);
  }

  /**
   * Get the current server status.
   */
  getStatus(): SquadServerStatus {
    const activeSessions = this.sessionManager?.listActiveSessions() ?? [];
    return {
      running: this.running,
      activeSessions: activeSessions.length,
      poolCapacity: this.client?.pool.atCapacity ? this.client.pool.size : (this.client?.pool.size ?? 0),
      connectedToHost: this.client?.isConnected() ?? false,
      agents: activeSessions,
      remoteState: this.remoteBridge?.getState(),
    };
  }

  /**
   * Get a full state snapshot (delegates to session manager).
   */
  getStateSnapshot(): ServerStateSnapshot {
    if (this.sessionManager) {
      return this.sessionManager.getStateSnapshot();
    }
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      serverStartedAt: this.serverStartedAt,
      sessions: [],
      poolSize: 0,
      poolCapacity: 0,
    };
  }

  /**
   * Get the EventBus reference for external subscribers.
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get the EventHistory ring buffer for monitoring.
   */
  getEventHistory(): EventHistory {
    return this.eventHistory;
  }

  /**
   * Convert a SquadEvent into a human-readable summary line.
   * Returns null if the event should be skipped.
   */
  private summarizeEvent(event: { type: string; agentName?: string; payload?: unknown }): string | null {
    const p = event.payload as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'session:created':
      case 'session.created':
        return `Session created for ${event.agentName || 'unknown'}`;
      case 'session:destroyed':
      case 'session.destroyed':
        return `Session closed for ${event.agentName || 'unknown'}`;
      case 'coordinator:routing': {
        const agents = Array.isArray(p?.agents) ? (p.agents as string[]).join(', ') : 'unknown';
        const strategy = p?.strategy ?? 'default';
        return `Routed to ${agents} (${strategy})`;
      }
      case 'agent:milestone':
        return `${event.agentName || 'agent'}: ${p?.milestone ?? 'milestone'}`;
      case 'session:error':
        return `Error: ${p?.error ?? p?.message ?? 'unknown'}`;
      default:
        return `${event.type}: ${event.agentName || 'system'}`;
    }
  }

  /**
   * Get the ToolRegistry (e.g. for injecting additional custom tools before start).
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get the SquadCoordinator (available after start).
   */
  getCoordinator(): SquadCoordinator | null {
    return this.coordinator;
  }

  /**
   * Get the AgentSessionManager (available after start).
   */
  getSessionManager(): AgentSessionManager | null {
    return this.sessionManager;
  }

  getPulseCollector(): PulseCollector {
    return this.pulseCollector;
  }

  getScratchpad(): Scratchpad {
    return this.scratchpad;
  }

  /**
   * Whether the server is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }
}

// Re-export lifecycle types for consumers
export {
  AgentSessionManager,
  extractResponseContent,
  TOOL_CALL_PLACEHOLDER,
  type AgentSessionManagerConfig,
  type AgentSessionEntry,
  type DispatchResult,
  type ActiveSessionInfo,
} from './agent-lifecycle.js';

export {
  ServerPersistence,
  type PersistenceConfig,
  type ServerStateSnapshot,
  type SessionRegistryEntry,
} from './persistence.js';

export {
  EventHistory,
  type HistoryEvent,
} from './event-history.js';
