/**
 * Tool Registry — Custom Tools API (PRD 2)
 *
 * Defines Squad's custom tools registered with the SDK via defineTool().
 * Tools provide agents with typed, validated orchestration primitives:
 *   - squad_route:  Route work to another agent via session pool
 *   - squad_decide: Write a typed decision to the inbox drop-box
 *   - squad_memory: Append to agent history (learnings, updates)
 *   - squad_status: Query session pool state
 *   - squad_skill:  Read/write agent skills
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SquadTool, SquadToolInvocation, SquadToolResult } from '../adapter/types.js';
import { getBuiltInActor } from '../agents/built-in-actors.js';
import type { HandoffStore, HandoffKind, HandoffConfidence } from '../handoff/index.js';
import { createPulse, filterPulseForUser, type PulseFilter } from '../pulse/index.js';
import type { Scratchpad } from '../scratchpad/index.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';

const tracer = trace.getTracer('squad-sdk');

// --- Argument Sanitization ---

/** Sensitive field patterns — strip before recording as span attributes. */
const SENSITIVE_PATTERNS = /token|secret|password|key|auth/i;

/**
 * Sanitize tool arguments for OTel span attributes.
 * Strips any field whose name matches sensitive patterns (case-insensitive).
 * Returns JSON string truncated to 1024 chars.
 */
export function sanitizeArgs(args: unknown): string {
  if (args == null || typeof args !== 'object') {
    return JSON.stringify(args ?? null).slice(0, 1024);
  }
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    sanitized[k] = SENSITIVE_PATTERNS.test(k) ? '[REDACTED]' : v;
  }
  return JSON.stringify(sanitized).slice(0, 1024);
}

// --- Tool Types ---

export interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface RouteRequest {
  /** Target agent name */
  targetAgent: string;
  /** Task description for the target agent */
  task: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Context to pass to the target session */
  context?: string;
  /** Structured handoff IDs the target agent should read before starting */
  handoffIds?: string[];
  /** Scratchpad artifact keys the target agent should review before starting */
  artifactKeys?: string[];
}

export interface DecisionRecord {
  /** Decision author (agent name) */
  author: string;
  /** Decision summary */
  summary: string;
  /** Full decision body */
  body: string;
  /** Related agents or PRDs */
  references?: string[];
}

export interface MemoryEntry {
  /** Agent name */
  agent: string;
  /** Section to append to (learnings, updates, sessions) */
  section: 'learnings' | 'updates' | 'sessions';
  /** Content to append */
  content: string;
}

export interface StatusQuery {
  /** Filter by agent name */
  agentName?: string;
  /** Filter by session status */
  status?: string;
  /** Inspect a specific run by runId */
  runId?: string;
  /** Include detailed session metadata */
  verbose?: boolean;
}

export interface RunSessionSnapshot {
  agentName: string;
  sessionId: string;
  messageCount: number;
  lastMessage?: string;
}

export interface RunInspectionSnapshot {
  runId: string;
  sessions: RunSessionSnapshot[];
  scratchpadEntries: Array<{ key: string; producer: string; valuePreview: string }>;
  handoffs: Array<{ handoffId: string; fromAgent: string; toAgent?: string; kind: string; summary: string; artifactKeys: string[] }>;
  communicationEvents: Array<{ summary: string; type: string; agentName?: string }>;
}

export interface ToolCallEventRecord {
  toolName: string;
  sessionId?: string;
  agentName?: string;
  runId?: string;
  details?: Record<string, unknown>;
}

export interface SkillRequest {
  /** Skill name (maps to .squad/skills/{name}/SKILL.md) */
  skillName: string;
  /** Operation: read the skill or write/update it */
  operation: 'read' | 'write';
  /** Skill content (required for write) */
  content?: string;
  /** Confidence level (required for write) */
  confidence?: 'low' | 'medium' | 'high';
}

export interface PulseRequest {
  agent: string;
  phase: 'starting' | 'analyzing' | 'implementing' | 'testing' | 'reviewing' | 'done' | 'blocked';
  status: 'ok' | 'warning' | 'error';
  progressPct: number;
  summary: string;
  blockers?: string[];
  questionsForUser?: string[];
  artifacts?: string[];
  nextStep?: string;
}

export interface ScratchpadWriteRequest {
  /** Key for the artifact (recommended: `agent:name`) */
  key: string;
  /** Value to store */
  value: string;
  /** Agent name writing the artifact */
  producer: string;
  /** Optional tags for filtering */
  tags?: string[];
}

export interface ScratchpadReadRequest {
  /** Key to read */
  key: string;
}

export interface ScratchpadListRequest {
  /** Filter by producer agent */
  producer?: string;
  /** Filter by tag */
  tag?: string;
}

export interface PublishHandoffRequest {
  fromAgent?: string;
  toAgent?: string;
  kind: HandoffKind;
  summary: string;
  details: string;
  artifactKeys?: string[];
  blockers?: string[];
  questions?: string[];
  confidence?: HandoffConfidence;
  tags?: string[];
}

export interface ReadHandoffRequest {
  handoffId: string;
}

export interface ListHandoffsRequest {
  fromAgent?: string;
  toAgent?: string;
  kind?: HandoffKind;
  tag?: string;
  includeBroadcast?: boolean;
}

export interface SessionToolContext {
  agentName: string;
  runId?: string;
}

// --- Proposal Types ---

export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type ProposalPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ProposalRecord {
  /** Proposal title */
  title: string;
  /** Category (e.g. "performance", "architecture", "testing", "documentation") */
  category: string;
  /** Target file or module this proposal affects */
  targetFile: string;
  /** Detailed description of the proposed improvement */
  description: string;
  /** Evidence or rationale supporting this proposal */
  evidence: string;
  /** Priority level */
  priority: ProposalPriority;
  /** Author agent name */
  author?: string;
}

export interface ProposalActionRequest {
  /** Operation to perform */
  operation: 'create' | 'list' | 'update';

  // --- Fields for 'create' ---
  /** Proposal data (required for 'create') */
  proposal?: ProposalRecord;

  // --- Fields for 'list' ---
  /** Filter by status (default: 'pending') */
  statusFilter?: ProposalStatus;

  // --- Fields for 'update' ---
  /** Proposal filename to update (required for 'update') */
  proposalFile?: string;
  /** New status (required for 'update') */
  newStatus?: 'approved' | 'rejected';
  /** Optional reviewer comment */
  reviewComment?: string;
}

// --- Tool Definition Helper ---

/**
 * Define a typed Squad tool with JSON schema parameters.
 * Creates a SquadTool object compatible with the adapter layer.
 */
export function defineTool<TArgs = unknown>(config: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: TArgs, invocation: SquadToolInvocation) => Promise<SquadToolResult> | SquadToolResult;
  /** Optional agent name for span attribution */
  agentName?: string;
}): SquadTool<TArgs> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    // TODO: Parent span context propagation — tool spans should be children of
    // agent.work spans once the agent work span lifecycle is complete.
    handler: async (args: TArgs, invocation: SquadToolInvocation) => {
      const span = tracer.startSpan('squad.tool.call', {
        attributes: {
          'tool.name': config.name,
          ...(config.agentName ? { 'agent.name': config.agentName } : {}),
          ...(invocation?.sessionId ? { 'session.id': invocation.sessionId } : {}),
          ...(invocation?.toolCallId ? { 'tool.call_id': invocation.toolCallId } : {}),
          'tool.args': sanitizeArgs(args),
        },
      });
      const startTime = Date.now();
      try {
        const result = await config.handler(args, invocation);
        const durationMs = Date.now() - startTime;
        const resultType = typeof result === 'string' ? 'unknown' : (result.resultType ?? 'unknown');
        const resultText = typeof result === 'string' ? result : (result.textResultForLlm ?? '');
        span.addEvent('squad.tool.result', {
          'result.type': resultType,
          'result.length': resultText.length,
          'duration_ms': durationMs,
          'success': resultType !== 'failure',
        });
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span.addEvent('squad.tool.error', {
          'error.type': err instanceof Error ? err.constructor.name : 'unknown',
          'error.message': err instanceof Error ? err.message : String(err),
          'duration_ms': durationMs,
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    },
  };
}

// --- Tool Registry ---

export class ToolRegistry {
  private tools: Map<string, SquadTool<any>> = new Map();
  private squadRoot: string;
  private sessionPoolGetter?: () => any;
  private dispatchGetter?: () => ((agentName: string, task: string, context?: string, runId?: string) => Promise<{ sessionId: string; status: string }>) | undefined;
  private sendFollowUpGetter?: () => ((agentName: string, message: string, runId?: string, sourceAgent?: string) => Promise<string | null>) | undefined;
  private getMessagesGetter?: () => ((agentName: string, runId?: string) => { role: string; content: string; timestamp: string }[]) | undefined;
  private pulseRecordGetter?: () => ((pulse: PulseRequest) => PulseFilter) | undefined;
  private scratchpadGetter?: () => Scratchpad | null;
  private sessionContextGetter?: () => ((sessionId: string) => SessionToolContext | null) | undefined;
  private runScratchpadGetter?: () => ((runId?: string) => Scratchpad | null) | undefined;
  private runHandoffStoreGetter?: () => ((runId?: string) => HandoffStore | null) | undefined;
  private listSessionsForRunGetter?: () => ((runId: string) => Array<{ agentName: string; sessionId: string }>) | undefined;
  private toolEventRecorderGetter?: () => ((event: ToolCallEventRecord) => Promise<void> | void) | undefined;
  private runEventsGetter?: () => ((runId: string) => Array<{ summary: string; type: string; agentName?: string }>) | undefined;

  constructor(
    squadRoot = '.squad',
    sessionPoolGetter?: () => any,
    dispatchGetter?: () => ((agentName: string, task: string, context?: string, runId?: string) => Promise<{ sessionId: string; status: string }>) | undefined,
    sendFollowUpGetter?: () => ((agentName: string, message: string, runId?: string, sourceAgent?: string) => Promise<string | null>) | undefined,
    getMessagesGetter?: () => ((agentName: string, runId?: string) => { role: string; content: string; timestamp: string }[]) | undefined,
    pulseRecordGetter?: () => ((pulse: PulseRequest) => PulseFilter) | undefined,
    scratchpadGetter?: () => Scratchpad | null,
    sessionContextGetter?: () => ((sessionId: string) => SessionToolContext | null) | undefined,
    runScratchpadGetter?: () => ((runId?: string) => Scratchpad | null) | undefined,
    runHandoffStoreGetter?: () => ((runId?: string) => HandoffStore | null) | undefined,
    listSessionsForRunGetter?: () => ((runId: string) => Array<{ agentName: string; sessionId: string }>) | undefined,
    toolEventRecorderGetter?: () => ((event: ToolCallEventRecord) => Promise<void> | void) | undefined,
    runEventsGetter?: () => ((runId: string) => Array<{ summary: string; type: string; agentName?: string }>) | undefined,
  ) {
    this.squadRoot = squadRoot;
    this.sessionPoolGetter = sessionPoolGetter;
    this.dispatchGetter = dispatchGetter;
    this.sendFollowUpGetter = sendFollowUpGetter;
    this.getMessagesGetter = getMessagesGetter;
    this.pulseRecordGetter = pulseRecordGetter;
    this.scratchpadGetter = scratchpadGetter;
    this.sessionContextGetter = sessionContextGetter;
    this.runScratchpadGetter = runScratchpadGetter;
    this.runHandoffStoreGetter = runHandoffStoreGetter;
    this.listSessionsForRunGetter = listSessionsForRunGetter;
    this.toolEventRecorderGetter = toolEventRecorderGetter;
    this.runEventsGetter = runEventsGetter;
    this.registerSquadTools();
  }

  private resolveSessionContext(invocation?: SquadToolInvocation): SessionToolContext | undefined {
    const getContext = this.sessionContextGetter?.();
    if (!getContext || !invocation?.sessionId) {
      return undefined;
    }

    return getContext(invocation.sessionId) ?? undefined;
  }

  private resolveScratchpad(invocation?: SquadToolInvocation): Scratchpad | null {
    const runId = this.resolveSessionContext(invocation)?.runId;
    const getRunScratchpad = this.runScratchpadGetter?.();
    if (getRunScratchpad) {
      const pad = getRunScratchpad(runId);
      if (pad) {
        return pad;
      }
    }

    return this.scratchpadGetter?.() ?? null;
  }

  private resolveHandoffStore(invocation?: SquadToolInvocation): HandoffStore | null {
    const runId = this.resolveSessionContext(invocation)?.runId;
    const getStore = this.runHandoffStoreGetter?.();
    if (!getStore) {
      return null;
    }

    return getStore(runId) ?? null;
  }

  private canInspectRun(invocation: SquadToolInvocation | undefined, targetRunId: string): boolean {
    const sourceContext = this.resolveSessionContext(invocation);
    if (!sourceContext) {
      return false;
    }

    if (sourceContext.runId === targetRunId) {
      return true;
    }

    return !!getBuiltInActor(sourceContext.agentName);
  }

  private inspectRun(runId: string): RunInspectionSnapshot | null {
    const listSessions = this.listSessionsForRunGetter?.();
    const getMessages = this.getMessagesGetter?.();
    if (!listSessions || !getMessages) {
      return null;
    }

    const sessions = listSessions(runId).map((session) => {
      const messages = getMessages(session.agentName, runId);
      const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
      return {
        agentName: session.agentName,
        sessionId: session.sessionId,
        messageCount: messages.length,
        lastMessage: lastAssistant?.content,
      };
    });

    const scratchpad = this.runScratchpadGetter?.()?.(runId);
    const scratchpadEntries = scratchpad
      ? scratchpad.list().map((entry) => ({
          key: entry.key,
          producer: entry.producer,
          valuePreview: entry.value.length > 120 ? `${entry.value.slice(0, 120)}...` : entry.value,
        }))
      : [];

    const handoffStore = this.runHandoffStoreGetter?.()?.(runId);
    const handoffs = handoffStore
      ? handoffStore.list().map((entry) => ({
          handoffId: entry.handoffId,
          fromAgent: entry.fromAgent,
          toAgent: entry.toAgent,
          kind: entry.kind,
          summary: entry.summary,
          artifactKeys: [...entry.artifactKeys],
        }))
      : [];

    const communicationEvents = this.runEventsGetter?.()?.(runId) ?? [];

    return {
      runId,
      sessions,
      scratchpadEntries,
      handoffs,
      communicationEvents,
    };
  }

  private async recordToolEvent(
    toolName: string,
    invocation: SquadToolInvocation | undefined,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const recordEvent = this.toolEventRecorderGetter?.();
    if (!recordEvent) {
      return;
    }

    const sourceContext = this.resolveSessionContext(invocation);
    try {
      await recordEvent({
        toolName,
        sessionId: invocation?.sessionId,
        agentName: sourceContext?.agentName,
        runId: sourceContext?.runId,
        details,
      });
    } catch {
      // Observability must not break tool execution.
    }
  }

  private formatRouteContext(args: RouteRequest): string | undefined {
    const extraSections: string[] = [];

    if (args.handoffIds && args.handoffIds.length > 0) {
      extraSections.push([
        'Structured handoff IDs:',
        ...args.handoffIds.map((handoffId) => `- ${handoffId}`),
        'Read these with squad_read_handoff before starting work.',
      ].join('\n'));
    }

    if (args.artifactKeys && args.artifactKeys.length > 0) {
      extraSections.push([
        'Referenced scratchpad artifact keys:',
        ...args.artifactKeys.map((artifactKey) => `- ${artifactKey}`),
        'Read these with squad_scratchpad_read before starting work.',
      ].join('\n'));
    }

    return [args.context, ...extraSections].filter(Boolean).join('\n\n') || undefined;
  }

  private registerSquadTools(): void {
    // squad_route: Route work to another agent
    const squadRoute = defineTool<RouteRequest>({
      name: 'squad_route',
      description: 'Route a task to another agent in the squad. Creates a new session for the target agent with the specified task and context.',
      parameters: {
        type: 'object',
        properties: {
          targetAgent: {
            type: 'string',
            description: 'Name of the agent to route the task to',
          },
          task: {
            type: 'string',
            description: 'Description of the task for the target agent',
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'critical'],
            description: 'Priority level for the routed task',
            default: 'normal',
          },
          context: {
            type: 'string',
            description: 'Additional context to pass to the target session',
          },
          handoffIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Structured handoff IDs the target agent should read before starting',
          },
          artifactKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Scratchpad artifact keys the target agent should review before starting',
          },
        },
        required: ['targetAgent', 'task'],
      },
      handler: async (args, invocation) => {
        if (!args.targetAgent || args.targetAgent.trim() === '') {
          return {
            textResultForLlm: 'Error: Target agent name is required',
            resultType: 'failure',
            error: 'Invalid target agent',
          };
        }

        const dispatch = this.dispatchGetter?.();
        if (!dispatch) {
          // Fallback: no server connected, write to mailbox file instead
          const mailboxDir = path.join(this.squadRoot, '.squad', 'mailbox', args.targetAgent);
          fs.mkdirSync(mailboxDir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const filename = path.join(mailboxDir, `${timestamp}-route.md`);
          const content = [
            `## Routed Task`,
            `**Priority:** ${args.priority || 'normal'}`,
            `**Task:** ${args.task}`,
            args.context ? `**Context:** ${args.context}` : '',
            `**Routed at:** ${new Date().toISOString()}`,
          ].filter(Boolean).join('\n');
          fs.writeFileSync(filename, content, 'utf-8');

          return {
            textResultForLlm: `Task written to mailbox for ${args.targetAgent} (server not connected). Priority: ${args.priority || 'normal'}. File: ${filename}`,
            resultType: 'success',
            toolTelemetry: {
              routeRequest: { targetAgent: args.targetAgent, task: args.task, priority: args.priority || 'normal' },
              fallback: 'mailbox',
              filename,
            },
          };
        }

        try {
          const sourceContext = this.resolveSessionContext(invocation);
          const routeContext = this.formatRouteContext(args);
          const result = sourceContext?.runId
            ? await dispatch(args.targetAgent, args.task, routeContext, sourceContext.runId)
            : await dispatch(args.targetAgent, args.task, routeContext);
          await this.recordToolEvent('squad_route', invocation, {
            targetAgent: args.targetAgent,
            handoffIds: args.handoffIds ?? [],
            artifactKeys: args.artifactKeys ?? [],
            priority: args.priority || 'normal',
          });
          return {
            textResultForLlm: `Task routed to ${args.targetAgent} (session: ${result.sessionId}). Status: ${result.status}. Priority: ${args.priority || 'normal'}.`,
            resultType: 'success',
            toolTelemetry: {
              routeRequest: {
                targetAgent: args.targetAgent,
                task: args.task,
                priority: args.priority || 'normal',
                handoffIds: args.handoffIds ?? [],
                artifactKeys: args.artifactKeys ?? [],
              },
              sessionId: result.sessionId,
              status: result.status,
              sourceRunId: sourceContext?.runId,
            },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            textResultForLlm: `Failed to route task to ${args.targetAgent}: ${errorMessage}`,
            resultType: 'failure',
            error: errorMessage,
          };
        }
      },
    });

    // squad_decide: Write a decision to the inbox
    const squadDecide = defineTool<DecisionRecord>({
      name: 'squad_decide',
      description: 'Write a decision to the team decision inbox. Decisions are stored in .squad/decisions/inbox/ for team review.',
      parameters: {
        type: 'object',
        properties: {
          author: {
            type: 'string',
            description: 'Agent name making the decision',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of the decision',
          },
          body: {
            type: 'string',
            description: 'Full decision details and rationale',
          },
          references: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related agents, PRDs, or issues',
          },
        },
        required: ['author', 'summary', 'body'],
      },
      handler: async (args) => {
        try {
          const inboxDir = path.join(this.squadRoot, '.squad', 'decisions', 'inbox');
          fs.mkdirSync(inboxDir, { recursive: true });

          const decisionId = randomUUID();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const slug = args.summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);
          const filename = path.join(inboxDir, `${args.author}-${slug}.md`);

          const content = [
            `### ${timestamp}: ${args.summary}`,
            '',
            `**By:** ${args.author}`,
            `**What:** ${args.body}`,
            args.references && args.references.length > 0
              ? `**References:** ${args.references.join(', ')}`
              : '',
            '',
            `**Why:** ${args.body}`,
            '',
          ].filter(Boolean).join('\n');

          fs.writeFileSync(filename, content, 'utf-8');

          return {
            textResultForLlm: `Decision written to ${filename} (ID: ${decisionId})`,
            resultType: 'success',
            toolTelemetry: { decisionId, filename, slug },
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to write decision: ${error}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_memory: Append to agent history
    const squadMemory = defineTool<MemoryEntry>({
      name: 'squad_memory',
      description: 'Append an entry to an agent\'s history file. Used to record learnings, updates, or session notes.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Agent name whose history to update',
          },
          section: {
            type: 'string',
            enum: ['learnings', 'updates', 'sessions'],
            description: 'Section to append to',
          },
          content: {
            type: 'string',
            description: 'Content to append to the section',
          },
        },
        required: ['agent', 'section', 'content'],
      },
      handler: async (args) => {
        try {
          const historyFile = path.join(this.squadRoot, '.squad', 'agents', args.agent, 'history.md');
          
          if (!fs.existsSync(historyFile)) {
            return {
              textResultForLlm: `Agent history file not found: ${historyFile}`,
              resultType: 'failure',
              error: 'History file does not exist',
            };
          }

          const sectionHeader = `## ${args.section.charAt(0).toUpperCase() + args.section.slice(1)}`;
          const timestamp = new Date().toISOString();
          const entry = `\n### ${timestamp}\n${args.content}\n`;

          let content = fs.readFileSync(historyFile, 'utf-8');
          
          // Find section and append
          const sectionIndex = content.indexOf(sectionHeader);
          if (sectionIndex !== -1) {
            // Find next section or end of file
            const nextSectionIndex = content.indexOf('\n## ', sectionIndex + sectionHeader.length);
            const insertIndex = nextSectionIndex === -1 ? content.length : nextSectionIndex;
            content = content.slice(0, insertIndex) + entry + content.slice(insertIndex);
          } else {
            // Section doesn't exist, append at end
            content += `\n${sectionHeader}\n${entry}`;
          }

          fs.writeFileSync(historyFile, content, 'utf-8');

          return {
            textResultForLlm: `Appended to ${args.agent} history (${args.section})`,
            resultType: 'success',
            toolTelemetry: { agent: args.agent, section: args.section },
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to update agent memory: ${error}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_status: Query session pool state
    const squadStatus = defineTool<StatusQuery>({
      name: 'squad_status',
      description: 'Query the status of active sessions in the pool. Returns session metadata and current state.',
      parameters: {
        type: 'object',
        properties: {
          agentName: {
            type: 'string',
            description: 'Filter by agent name',
          },
          status: {
            type: 'string',
            description: 'Filter by session status (active, idle, completed)',
          },
          verbose: {
            type: 'boolean',
            description: 'Include detailed session metadata',
            default: false,
          },
        },
      },
      handler: async (args, invocation) => {
        if (args.runId) {
          if (!this.canInspectRun(invocation, args.runId)) {
            return {
              textResultForLlm: `Cross-run inspection is restricted. Agent may only inspect its own run unless it is a built-in actor.`,
              resultType: 'failure',
              error: 'Cross-run inspection is restricted',
            };
          }

          const snapshot = this.inspectRun(args.runId);
          if (!snapshot) {
            return {
              textResultForLlm: `Run inspection is unavailable — server inspection hooks are not connected.`,
              resultType: 'failure',
              error: 'Run inspection unavailable',
            };
          }

          if (snapshot.sessions.length === 0 && snapshot.scratchpadEntries.length === 0 && snapshot.handoffs.length === 0) {
            return {
              textResultForLlm: `Run ${args.runId}: no active sessions, scratchpad entries, or handoffs found.`,
              resultType: 'success',
              toolTelemetry: { runId: args.runId, inspected: true },
            };
          }

          const sessionLines = snapshot.sessions.length > 0
            ? snapshot.sessions.map((session) => {
                const detail = args.verbose && session.lastMessage
                  ? `\n    last assistant message: ${session.lastMessage.slice(0, 240)}`
                  : '';
                return `- ${session.agentName} (${session.sessionId.slice(0, 8)}): ${session.messageCount} messages${detail}`;
              }).join('\n')
            : '- none';

          const scratchpadLines = snapshot.scratchpadEntries.length > 0
            ? snapshot.scratchpadEntries.map((entry) => `- ${entry.key} by ${entry.producer}: ${entry.valuePreview}`).join('\n')
            : '- none';

          const handoffLines = snapshot.handoffs.length > 0
            ? snapshot.handoffs.map((handoff) => `- ${handoff.handoffId} [${handoff.kind}] ${handoff.fromAgent} -> ${handoff.toAgent ?? 'broadcast'}: ${handoff.summary}${handoff.artifactKeys.length > 0 ? ` (artifacts: ${handoff.artifactKeys.join(', ')})` : ''}`).join('\n')
            : '- none';

          const communicationLines = snapshot.communicationEvents.length > 0
            ? snapshot.communicationEvents.map((event) => `- ${event.summary}`).join('\n')
            : '- none';

          return {
            textResultForLlm: [
              `Run ${snapshot.runId} inspection:`,
              `Sessions:\n${sessionLines}`,
              `Scratchpad:\n${scratchpadLines}`,
              `Handoffs:\n${handoffLines}`,
              `Communication trace:\n${communicationLines}`,
            ].join('\n\n'),
            resultType: 'success',
            toolTelemetry: {
              runId: snapshot.runId,
              sessions: snapshot.sessions.length,
              scratchpadEntries: snapshot.scratchpadEntries.length,
              handoffs: snapshot.handoffs.length,
              communicationEvents: snapshot.communicationEvents.length,
            },
          };
        }

        const pool = this.sessionPoolGetter?.();
        const hasServer = !!this.dispatchGetter?.();

        if (!pool) {
          return {
            textResultForLlm: `Session pool not available (server ${hasServer ? 'connected' : 'not connected'}). Pool size: 0, Active sessions: 0`,
            resultType: 'success',
            toolTelemetry: {
              poolAvailable: false,
              serverConnected: hasServer,
              totalSessions: 0,
              activeSessions: 0,
            },
          };
        }

        const allSessions = Array.from((pool as any).sessions?.values() || []);
        let filteredSessions = allSessions;

        // Apply agent name filter (case-insensitive)
        if (args.agentName) {
          const lowerAgentName = args.agentName.toLowerCase();
          filteredSessions = filteredSessions.filter(
            (s: any) => s.agentName.toLowerCase() === lowerAgentName
          );
        }

        // Apply status filter
        if (args.status) {
          filteredSessions = filteredSessions.filter(
            (s: any) => s.status === args.status
          );
        }

        const poolInfo = {
          poolSize: pool.size,
          capacity: (pool as any).config?.maxConcurrent || 0,
          atCapacity: pool.atCapacity,
          activeSessions: pool.active().length,
          totalSessions: allSessions.length,
          filteredCount: filteredSessions.length,
          serverConnected: hasServer,
        };

        // Build response
        const sessionsByAgent: Record<string, number> = {};
        const sessionsByStatus: Record<string, number> = {};

        for (const session of allSessions) {
          const s = session as any;
          sessionsByAgent[s.agentName] = (sessionsByAgent[s.agentName] || 0) + 1;
          sessionsByStatus[s.status] = (sessionsByStatus[s.status] || 0) + 1;
        }

        let textResult = `Pool status: ${poolInfo.poolSize}/${poolInfo.capacity} sessions (${poolInfo.activeSessions} active, server ${hasServer ? 'connected' : 'offline'})`;

        // Show per-agent breakdown prominently
        const agentNames = Object.keys(sessionsByAgent);
        if (agentNames.length > 0) {
          textResult += `\nAgents: ${agentNames.map(name => `${name}(${sessionsByAgent[name]})`).join(', ')}`;
        }

        if (args.agentName || args.status) {
          textResult += `\nFiltered results: ${poolInfo.filteredCount} sessions`;
        }

        if (args.verbose && filteredSessions.length > 0) {
          textResult += '\n\nSessions:';
          for (const session of filteredSessions) {
            const s = session as any;
            const uptime = s.createdAt ? Math.floor((Date.now() - s.createdAt.getTime()) / 1000) : 0;
            textResult += `\n- [${s.agentName}] ${s.id.slice(0, 8)}: ${s.status}, ${uptime}s uptime`;
          }
        }

        return {
          textResultForLlm: textResult,
          resultType: 'success',
          toolTelemetry: {
            poolInfo,
            sessionsByAgent,
            sessionsByStatus,
            filters: {
              agentName: args.agentName,
              status: args.status,
              verbose: args.verbose || false,
            },
          },
        };
      },
    });

    // squad_skill: Read/write agent skills
    const squadSkill = defineTool<SkillRequest>({
      name: 'squad_skill',
      description: 'Read or write agent skill definitions. Skills are stored in .squad/skills/{name}/SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skillName: {
            type: 'string',
            description: 'Skill name (maps to directory name)',
          },
          operation: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'Operation to perform',
          },
          content: {
            type: 'string',
            description: 'Skill content (required for write)',
          },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Confidence level (required for write)',
          },
        },
        required: ['skillName', 'operation'],
      },
      handler: async (args) => {
        try {
          const skillDir = path.join(this.squadRoot, 'skills', args.skillName);
          const skillFile = path.join(skillDir, 'SKILL.md');

          if (args.operation === 'read') {
            if (!fs.existsSync(skillFile)) {
              return {
                textResultForLlm: `Skill not found: ${args.skillName}`,
                resultType: 'failure',
                error: 'Skill file does not exist',
              };
            }

            const content = fs.readFileSync(skillFile, 'utf-8');
            return {
              textResultForLlm: `Skill: ${args.skillName}\n\n${content}`,
              resultType: 'success',
              toolTelemetry: { skillName: args.skillName, operation: 'read' },
            };
          } else {
            // write operation
            if (!args.content) {
              return {
                textResultForLlm: 'Error: content is required for write operation',
                resultType: 'failure',
                error: 'Missing required field: content',
              };
            }

            fs.mkdirSync(skillDir, { recursive: true });

            const skillContent = [
              `# ${args.skillName}`,
              '',
              `**Confidence:** ${args.confidence || 'medium'}`,
              `**Updated:** ${new Date().toISOString()}`,
              '',
              args.content,
            ].join('\n');

            fs.writeFileSync(skillFile, skillContent, 'utf-8');

            return {
              textResultForLlm: `Skill written: ${args.skillName} (${skillFile})`,
              resultType: 'success',
              toolTelemetry: { skillName: args.skillName, operation: 'write', confidence: args.confidence },
            };
          }
        } catch (error) {
          return {
            textResultForLlm: `Failed to ${args.operation} skill: ${error}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_send: Send a message and wait for response
    const squadSend = defineTool<{ agentName: string; message: string }>({
      name: 'squad_send',
      description: 'Send a message to an existing agent session and wait for their response. Use for coordination, handoffs, and checking results.',
      parameters: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the target agent (must have an active session)' },
          message: { type: 'string', description: 'The message to send to the agent' },
        },
        required: ['agentName', 'message'],
      },
      handler: async (args, invocation) => {
        const sendFn = this.sendFollowUpGetter?.();
        if (!sendFn) {
          return {
            textResultForLlm: 'squad_send not available — server not connected.',
            resultType: 'failure',
            error: 'No sendFollowUp function available',
          };
        }
        try {
          const sourceContext = this.resolveSessionContext(invocation);
          const response = sourceContext?.runId
            ? await sendFn(args.agentName, args.message, sourceContext.runId, sourceContext.agentName)
            : await sendFn(args.agentName, args.message, undefined, sourceContext?.agentName);
          await this.recordToolEvent('squad_send', invocation, {
            targetAgent: args.agentName,
            responseCaptured: response != null,
          });
          if (response) {
            return { textResultForLlm: response, resultType: 'success' };
          }
          return {
            textResultForLlm: `Message sent to ${args.agentName} but no response captured. Use squad_read_session to check later.`,
            resultType: 'success',
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to send to ${args.agentName}: ${error instanceof Error ? error.message : error}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_read_session: Read agent conversation history
    const squadReadSession = defineTool<{ agentName: string; lastN?: number }>({
      name: 'squad_read_session',
      description: 'Read the conversation history of an agent session. Returns messages (dispatches and replies). Use to check progress or get results.',
      parameters: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: 'Name of the agent whose session to read' },
          lastN: { type: 'number', description: 'Only return the last N messages (default: all)' },
        },
        required: ['agentName'],
      },
      handler: async (args, invocation) => {
        const getMsgsFn = this.getMessagesGetter?.();
        if (!getMsgsFn) {
          return {
            textResultForLlm: 'squad_read_session not available — server not connected.',
            resultType: 'failure',
            error: 'No getMessages function available',
          };
        }
        try {
          const sourceContext = this.resolveSessionContext(invocation);
          const messages = sourceContext?.runId
            ? getMsgsFn(args.agentName, sourceContext.runId)
            : getMsgsFn(args.agentName);
          await this.recordToolEvent('squad_read_session', invocation, {
            targetAgent: args.agentName,
            messageCount: messages.length,
          });
          if (messages.length === 0) {
            return {
              textResultForLlm: `No messages found for ${args.agentName}. Agent may not have an active session.`,
              resultType: 'success',
            };
          }
          const sliced = args.lastN ? messages.slice(-args.lastN) : messages;
          const formatted = sliced.map((m, i) => {
            const role = m.role === 'user' ? '→ SENT' : '← REPLY';
            const ts = m.timestamp ? ` (${m.timestamp.slice(11, 19)})` : '';
            const content = m.content.length > 4000 ? m.content.slice(0, 4000) + '\n... (truncated)' : m.content;
            return `[${i + 1}] ${role}${ts}:\n${content}`;
          }).join('\n\n---\n\n');
          return {
            textResultForLlm: `Session history for ${args.agentName} (${sliced.length}/${messages.length} messages):\n\n${formatted}`,
            resultType: 'success',
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to read session for ${args.agentName}: ${error instanceof Error ? error.message : error}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // Register all tools
    this.tools.set('squad_route', squadRoute);
    this.tools.set('squad_send', squadSend);
    this.tools.set('squad_read_session', squadReadSession);
    this.tools.set('squad_decide', squadDecide);
    this.tools.set('squad_memory', squadMemory);
    this.tools.set('squad_status', squadStatus);
    this.tools.set('squad_skill', squadSkill);

    const squadPulse = defineTool<PulseRequest>({
      name: 'squad_pulse',
      description: 'Emit a structured status update (Pulse) at milestones. Report progress, ask questions, or signal completion. User-relevant pulses (questions, errors, blockers, done) are automatically surfaced to the user via Ben.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Your agent name' },
          phase: { type: 'string', enum: ['starting', 'analyzing', 'implementing', 'testing', 'reviewing', 'done', 'blocked'], description: 'Current phase' },
          status: { type: 'string', enum: ['ok', 'warning', 'error'], description: 'Status level' },
          progressPct: { type: 'number', description: 'Progress percentage (0-100)' },
          summary: { type: 'string', description: 'Brief summary of what happened' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'List of blockers' },
          questionsForUser: { type: 'array', items: { type: 'string' }, description: 'Questions that need user input' },
          artifacts: { type: 'array', items: { type: 'string' }, description: 'Files or outputs produced' },
          nextStep: { type: 'string', description: 'What you will do next' },
        },
        required: ['agent', 'phase', 'status', 'progressPct', 'summary'],
      },
      handler: async (args) => {
        const recordFn = this.pulseRecordGetter?.();
        if (!recordFn) {
          return {
            textResultForLlm: 'Pulse recorded (no collector active)',
            resultType: 'success' as const,
          };
        }
        const filter = recordFn(args);
        return {
          textResultForLlm: `Pulse recorded: [${args.agent}] ${args.phase} ${args.progressPct}% — ${filter.userRelevant ? '(user-relevant: ' + filter.reason + ')' : '(internal)'}`,
          resultType: 'success' as const,
        };
      },
    });
    this.tools.set('squad_pulse', squadPulse);

    // squad_scratchpad_write: Write to shared scratchpad
    const squadScratchpadWrite = defineTool<ScratchpadWriteRequest>({
      name: 'squad_scratchpad_write',
      description: 'Write a value to the shared scratchpad. Any agent can read values written by any other agent. Cleared between runs.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key for the artifact (recommended format: agent:name)' },
          value: { type: 'string', description: 'Value to store' },
          producer: { type: 'string', description: 'Agent name writing the artifact' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
        },
        required: ['key', 'value', 'producer'],
      },
      handler: async (args, invocation) => {
        const pad = this.resolveScratchpad(invocation);
        if (!pad) {
          return {
            textResultForLlm: 'Scratchpad not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No scratchpad available',
          };
        }
        const result = pad.write(args.key, args.value, args.producer, args.tags ?? []);
        await this.recordToolEvent('squad_scratchpad_write', invocation, {
          key: args.key,
          producer: args.producer,
          created: result.created,
        });
        if (!result.success) {
          return {
            textResultForLlm: `Scratchpad write failed: ${result.error}`,
            resultType: 'failure' as const,
            error: result.error,
          };
        }
        return {
          textResultForLlm: `Scratchpad: ${result.created ? 'created' : 'updated'} key "${args.key}" (${args.value.length} chars)`,
          resultType: 'success' as const,
        };
      },
    });
    this.tools.set('squad_scratchpad_write', squadScratchpadWrite);

    // squad_scratchpad_read: Read from shared scratchpad
    const squadScratchpadRead = defineTool<ScratchpadReadRequest>({
      name: 'squad_scratchpad_read',
      description: 'Read a value from the shared scratchpad by key. Returns the value and metadata.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to read' },
        },
        required: ['key'],
      },
      handler: async (args, invocation) => {
        const pad = this.resolveScratchpad(invocation);
        if (!pad) {
          return {
            textResultForLlm: 'Scratchpad not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No scratchpad available',
          };
        }
        const entry = pad.read(args.key);
        await this.recordToolEvent('squad_scratchpad_read', invocation, {
          key: args.key,
          found: !!entry,
        });
        if (!entry) {
          return {
            textResultForLlm: `Scratchpad: key "${args.key}" not found.`,
            resultType: 'success' as const,
          };
        }
        return {
          textResultForLlm: `Scratchpad [${entry.key}] by ${entry.producer} (${entry.updatedAt}):\n${entry.value}`,
          resultType: 'success' as const,
        };
      },
    });
    this.tools.set('squad_scratchpad_read', squadScratchpadRead);

    // squad_scratchpad_list: List scratchpad entries
    const squadScratchpadList = defineTool<ScratchpadListRequest>({
      name: 'squad_scratchpad_list',
      description: 'List all keys in the shared scratchpad. Optionally filter by producer agent or tag.',
      parameters: {
        type: 'object',
        properties: {
          producer: { type: 'string', description: 'Filter by producer agent' },
          tag: { type: 'string', description: 'Filter by tag' },
        },
      },
      handler: async (args, invocation) => {
        const pad = this.resolveScratchpad(invocation);
        if (!pad) {
          return {
            textResultForLlm: 'Scratchpad not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No scratchpad available',
          };
        }
        const entries = pad.list(args);
        await this.recordToolEvent('squad_scratchpad_list', invocation, {
          producer: args.producer ?? null,
          tag: args.tag ?? null,
          count: entries.length,
        });
        if (entries.length === 0) {
          const filterDesc = args.producer || args.tag
            ? ` (filter: ${[args.producer && `producer=${args.producer}`, args.tag && `tag=${args.tag}`].filter(Boolean).join(', ')})`
            : '';
          return {
            textResultForLlm: `Scratchpad is empty${filterDesc}.`,
            resultType: 'success' as const,
          };
        }
        const stats = pad.stats();
        const listing = entries.map(e =>
          `- ${e.key} (by ${e.producer}, ${e.value.length} chars${e.tags.length > 0 ? `, tags: ${e.tags.join(',')}` : ''})`,
        ).join('\n');
        return {
          textResultForLlm: `Scratchpad: ${stats.entryCount} entries, ${stats.totalSize} chars total\n${listing}`,
          resultType: 'success' as const,
        };
      },
    });
    this.tools.set('squad_scratchpad_list', squadScratchpadList);

    const squadPublishHandoff = defineTool<PublishHandoffRequest>({
      name: 'squad_publish_handoff',
      description: 'Publish a structured handoff for another agent in the same run. Use this instead of burying results in freeform chat when another agent needs your output.',
      parameters: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string', description: 'Optional override for the publishing agent. Defaults to the caller session agent.' },
          toAgent: { type: 'string', description: 'Optional target agent. Omit for broadcast handoffs.' },
          kind: {
            type: 'string',
            enum: ['analysis', 'patch', 'review', 'test-result', 'question', 'artifact', 'summary'],
            description: 'Type of handoff payload',
          },
          summary: { type: 'string', description: 'One-screen summary of the handoff' },
          details: { type: 'string', description: 'Full handoff details for the target agent' },
          artifactKeys: { type: 'array', items: { type: 'string' }, description: 'Scratchpad artifact keys referenced by this handoff' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'Outstanding blockers' },
          questions: { type: 'array', items: { type: 'string' }, description: 'Open questions for the consumer' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Publisher confidence in the handoff' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
        },
        required: ['kind', 'summary', 'details'],
      },
      handler: async (args, invocation) => {
        const store = this.resolveHandoffStore(invocation);
        if (!store) {
          return {
            textResultForLlm: 'Handoff store not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No handoff store available',
          };
        }

        const sourceContext = this.resolveSessionContext(invocation);
        const fromAgent = sourceContext?.agentName ?? args.fromAgent;
        if (!fromAgent) {
          return {
            textResultForLlm: 'Handoff publish failed: source agent could not be resolved.',
            resultType: 'failure' as const,
            error: 'Missing source agent',
          };
        }

        const entry = store.publish({
          runId: sourceContext?.runId,
          fromAgent,
          toAgent: args.toAgent,
          kind: args.kind,
          summary: args.summary,
          details: args.details,
          artifactKeys: args.artifactKeys,
          blockers: args.blockers,
          questions: args.questions,
          confidence: args.confidence,
          tags: args.tags,
        });

        const target = entry.toAgent ? ` to ${entry.toAgent}` : ' (broadcast)';
        await this.recordToolEvent('squad_publish_handoff', invocation, {
          handoffId: entry.handoffId,
          toAgent: entry.toAgent ?? null,
          kind: entry.kind,
          artifactKeys: entry.artifactKeys,
        });
        return {
          textResultForLlm: `Published handoff ${entry.handoffId} (${entry.kind}) from ${entry.fromAgent}${target}. Summary: ${entry.summary}`,
          resultType: 'success' as const,
          toolTelemetry: {
            handoffId: entry.handoffId,
            kind: entry.kind,
            fromAgent: entry.fromAgent,
            toAgent: entry.toAgent ?? null,
            runId: entry.runId ?? null,
          },
        };
      },
    });
    this.tools.set('squad_publish_handoff', squadPublishHandoff);

    const squadReadHandoff = defineTool<ReadHandoffRequest>({
      name: 'squad_read_handoff',
      description: 'Read a structured handoff by ID. Use this before starting work when another agent routed you a handoff.',
      parameters: {
        type: 'object',
        properties: {
          handoffId: { type: 'string', description: 'Handoff ID to read' },
        },
        required: ['handoffId'],
      },
      handler: async (args, invocation) => {
        const store = this.resolveHandoffStore(invocation);
        if (!store) {
          return {
            textResultForLlm: 'Handoff store not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No handoff store available',
          };
        }

        const entry = store.read(args.handoffId);
        await this.recordToolEvent('squad_read_handoff', invocation, {
          handoffId: args.handoffId,
          found: !!entry,
        });
        if (!entry) {
          return {
            textResultForLlm: `Handoff ${args.handoffId} not found.`,
            resultType: 'success' as const,
          };
        }

        const sections = [
          `Handoff ${entry.handoffId}`,
          `From: ${entry.fromAgent}`,
          `To: ${entry.toAgent ?? 'broadcast'}`,
          `Kind: ${entry.kind}`,
          `Confidence: ${entry.confidence}`,
          `Summary: ${entry.summary}`,
          '',
          entry.details,
        ];
        if (entry.artifactKeys.length > 0) {
          sections.push('', 'Artifact keys:', ...entry.artifactKeys.map((artifactKey) => `- ${artifactKey}`));
        }
        if (entry.blockers.length > 0) {
          sections.push('', 'Blockers:', ...entry.blockers.map((blocker) => `- ${blocker}`));
        }
        if (entry.questions.length > 0) {
          sections.push('', 'Questions:', ...entry.questions.map((question) => `- ${question}`));
        }

        return {
          textResultForLlm: sections.join('\n'),
          resultType: 'success' as const,
          toolTelemetry: {
            handoffId: entry.handoffId,
            kind: entry.kind,
            fromAgent: entry.fromAgent,
            toAgent: entry.toAgent ?? null,
          },
        };
      },
    });
    this.tools.set('squad_read_handoff', squadReadHandoff);

    const squadListHandoffs = defineTool<ListHandoffsRequest>({
      name: 'squad_list_handoffs',
      description: 'List structured handoffs in the current run. Use filters to see only your inbox or a specific kind of handoff.',
      parameters: {
        type: 'object',
        properties: {
          fromAgent: { type: 'string', description: 'Filter by publishing agent' },
          toAgent: { type: 'string', description: 'Filter by target agent' },
          kind: {
            type: 'string',
            enum: ['analysis', 'patch', 'review', 'test-result', 'question', 'artifact', 'summary'],
            description: 'Filter by handoff kind',
          },
          tag: { type: 'string', description: 'Filter by tag' },
          includeBroadcast: { type: 'boolean', description: 'When filtering by toAgent, also include broadcast handoffs', default: true },
        },
      },
      handler: async (args, invocation) => {
        const store = this.resolveHandoffStore(invocation);
        if (!store) {
          return {
            textResultForLlm: 'Handoff store not available — server not connected.',
            resultType: 'failure' as const,
            error: 'No handoff store available',
          };
        }

        const entries = store.list(args);
        await this.recordToolEvent('squad_list_handoffs', invocation, {
          fromAgent: args.fromAgent ?? null,
          toAgent: args.toAgent ?? null,
          kind: args.kind ?? null,
          count: entries.length,
        });
        if (entries.length === 0) {
          return {
            textResultForLlm: 'No handoffs found for the current run and filters.',
            resultType: 'success' as const,
          };
        }

        const listing = entries.map((entry) => {
          const target = entry.toAgent ?? 'broadcast';
          return `- ${entry.handoffId} [${entry.kind}] ${entry.fromAgent} -> ${target}: ${entry.summary}`;
        }).join('\n');

        return {
          textResultForLlm: `Handoffs (${entries.length}):\n${listing}`,
          resultType: 'success' as const,
        };
      },
    });
    this.tools.set('squad_list_handoffs', squadListHandoffs);

    // squad_proposals: Manage improvement proposals from Sage
    const squadProposals = defineTool<ProposalActionRequest>({
      name: 'squad_proposals',
      description: 'Manage improvement proposals. Create proposals from Sage analysis, list pending proposals, or approve/reject them. Proposals are stored as markdown files in .squad/proposals/.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['create', 'list', 'update'],
            description: 'Operation to perform: create a new proposal, list existing proposals, or update (approve/reject) a proposal',
          },
          proposal: {
            type: 'object',
            description: 'Proposal data (required for create operation)',
            properties: {
              title: { type: 'string', description: 'Proposal title' },
              category: { type: 'string', description: 'Category (e.g. performance, architecture, testing, documentation)' },
              targetFile: { type: 'string', description: 'Target file or module this proposal affects' },
              description: { type: 'string', description: 'Detailed description of the proposed improvement' },
              evidence: { type: 'string', description: 'Evidence or rationale supporting this proposal' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority level' },
              author: { type: 'string', description: 'Author agent name (defaults to Sage)' },
            },
            required: ['title', 'category', 'targetFile', 'description', 'evidence', 'priority'],
          },
          statusFilter: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected'],
            description: 'Filter proposals by status (default: pending). Used with list operation.',
          },
          proposalFile: {
            type: 'string',
            description: 'Proposal filename to update (required for update operation)',
          },
          newStatus: {
            type: 'string',
            enum: ['approved', 'rejected'],
            description: 'New status for the proposal (required for update operation)',
          },
          reviewComment: {
            type: 'string',
            description: 'Optional reviewer comment when approving/rejecting',
          },
        },
        required: ['operation'],
      },
      handler: async (args) => {
        const proposalsDir = path.join(this.squadRoot, '.squad', 'proposals');

        switch (args.operation) {
          case 'create': {
            if (!args.proposal) {
              return {
                textResultForLlm: 'Error: proposal data is required for create operation',
                resultType: 'failure' as const,
                error: 'Missing proposal data',
              };
            }
            const p = args.proposal;
            if (!p.title || !p.category || !p.targetFile || !p.description || !p.evidence || !p.priority) {
              return {
                textResultForLlm: 'Error: proposal requires title, category, targetFile, description, evidence, and priority',
                resultType: 'failure' as const,
                error: 'Incomplete proposal data',
              };
            }

            fs.mkdirSync(proposalsDir, { recursive: true });

            const timestamp = new Date().toISOString();
            const fileTimestamp = timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const slug = p.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 50);
            const filename = `${fileTimestamp}-${slug}.md`;
            const filepath = path.join(proposalsDir, filename);
            const author = p.author || 'Sage';

            const content = [
              `# ${p.title}`,
              '',
              `| Field | Value |`,
              `|-------|-------|`,
              `| **Status** | pending |`,
              `| **Category** | ${p.category} |`,
              `| **Priority** | ${p.priority} |`,
              `| **Target File** | ${p.targetFile} |`,
              `| **Author** | ${author} |`,
              `| **Created** | ${timestamp} |`,
              '',
              `## Description`,
              '',
              p.description,
              '',
              `## Evidence`,
              '',
              p.evidence,
              '',
            ].join('\n');

            fs.writeFileSync(filepath, content, 'utf-8');

            return {
              textResultForLlm: `Proposal created: ${filename} — "${p.title}" (${p.priority} priority, ${p.category})`,
              resultType: 'success' as const,
              toolTelemetry: { filename, title: p.title, category: p.category, priority: p.priority, author },
            };
          }

          case 'list': {
            if (!fs.existsSync(proposalsDir)) {
              return {
                textResultForLlm: 'No proposals found. The .squad/proposals/ directory does not exist yet.',
                resultType: 'success' as const,
              };
            }

            const files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md'));
            if (files.length === 0) {
              return {
                textResultForLlm: 'No proposals found in .squad/proposals/.',
                resultType: 'success' as const,
              };
            }

            const statusFilter = args.statusFilter || 'pending';
            const proposals: { file: string; title: string; status: string; priority: string; category: string; targetFile: string }[] = [];

            for (const file of files) {
              const content = fs.readFileSync(path.join(proposalsDir, file), 'utf-8');
              const statusMatch = content.match(/\|\s*\*\*Status\*\*\s*\|\s*(\w+)\s*\|/);
              const status = statusMatch?.[1] ?? 'unknown';
              if (status !== statusFilter) continue;

              const titleMatch = content.match(/^#\s+(.+)$/m);
              const priorityMatch = content.match(/\|\s*\*\*Priority\*\*\s*\|\s*(\w+)\s*\|/);
              const categoryMatch = content.match(/\|\s*\*\*Category\*\*\s*\|\s*([^|]+)\s*\|/);
              const targetMatch = content.match(/\|\s*\*\*Target File\*\*\s*\|\s*([^|]+)\s*\|/);

              proposals.push({
                file,
                title: titleMatch?.[1]?.trim() ?? file,
                status,
                priority: priorityMatch?.[1]?.trim() ?? 'unknown',
                category: categoryMatch?.[1]?.trim() ?? 'unknown',
                targetFile: targetMatch?.[1]?.trim() ?? 'unknown',
              });
            }

            if (proposals.length === 0) {
              return {
                textResultForLlm: `No ${statusFilter} proposals found. ${files.length} total proposals in .squad/proposals/.`,
                resultType: 'success' as const,
              };
            }

            const listing = proposals.map(p =>
              `- **${p.title}** [${p.priority}] (${p.category}) → ${p.targetFile}\n  File: ${p.file}`,
            ).join('\n');

            return {
              textResultForLlm: `${proposals.length} ${statusFilter} proposal(s):\n\n${listing}`,
              resultType: 'success' as const,
              toolTelemetry: { count: proposals.length, statusFilter },
            };
          }

          case 'update': {
            if (!args.proposalFile) {
              return {
                textResultForLlm: 'Error: proposalFile is required for update operation',
                resultType: 'failure' as const,
                error: 'Missing proposalFile',
              };
            }
            if (!args.newStatus || (args.newStatus !== 'approved' && args.newStatus !== 'rejected')) {
              return {
                textResultForLlm: 'Error: newStatus must be "approved" or "rejected"',
                resultType: 'failure' as const,
                error: 'Invalid newStatus',
              };
            }

            const filepath = path.join(proposalsDir, args.proposalFile);
            if (!fs.existsSync(filepath)) {
              return {
                textResultForLlm: `Error: Proposal file not found: ${args.proposalFile}`,
                resultType: 'failure' as const,
                error: 'Proposal file not found',
              };
            }

            let content = fs.readFileSync(filepath, 'utf-8');

            // Update the status field in the metadata table
            content = content.replace(
              /(\|\s*\*\*Status\*\*\s*\|\s*)\w+(\s*\|)/,
              `$1${args.newStatus}$2`,
            );

            // Append review section
            const reviewTimestamp = new Date().toISOString();
            const reviewSection = [
              '',
              `## Review`,
              '',
              `| Field | Value |`,
              `|-------|-------|`,
              `| **Decision** | ${args.newStatus} |`,
              `| **Reviewed** | ${reviewTimestamp} |`,
              args.reviewComment ? `| **Comment** | ${args.reviewComment} |` : '',
              '',
            ].filter(Boolean).join('\n');

            content += reviewSection;
            fs.writeFileSync(filepath, content, 'utf-8');

            return {
              textResultForLlm: `Proposal ${args.newStatus}: ${args.proposalFile}${args.reviewComment ? ` — "${args.reviewComment}"` : ''}`,
              resultType: 'success' as const,
              toolTelemetry: { proposalFile: args.proposalFile, newStatus: args.newStatus },
            };
          }

          default:
            return {
              textResultForLlm: `Error: Unknown operation "${args.operation}". Use "create", "list", or "update".`,
              resultType: 'failure' as const,
              error: `Unknown operation: ${args.operation}`,
            };
        }
      },
    });
    this.tools.set('squad_proposals', squadProposals);

    // --- squad_mcp_call: Proxy MCP tool calls through VS Code's auth context ---
    const squadMcpCall = defineTool<{ server: string; tool: string; args?: Record<string, unknown> }>({
      name: 'squad_mcp_call',
      description: 'Call an MCP tool through the VS Code MCP proxy. Use for auth-protected MCP servers like ibizafxmcp that require VS Code auth context. Example: squad_mcp_call({ server: "ibizafxmcp", tool: "search_samples", args: { search_term: "DataGrid" } })',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name (e.g., "ibizafxmcp")' },
          tool: { type: 'string', description: 'Tool name without server prefix (e.g., "search_samples")' },
          args: { type: 'object', description: 'Tool arguments as key-value pairs' },
        },
        required: ['server', 'tool'],
      },
      handler: async (input) => {
        const proxyPort = this.findMcpProxyPort();
        if (!proxyPort) {
          return {
            textResultForLlm: 'MCP proxy not available. The Squad MCP Proxy VS Code extension is not running. Install and activate it to enable auth-protected MCP calls.',
            resultType: 'failure' as const,
            error: 'MCP proxy not found',
          };
        }

        try {
          const response = await fetch(`http://127.0.0.1:${proxyPort}/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server: input.server, tool: input.tool, args: input.args ?? {} }),
            signal: AbortSignal.timeout(120_000),
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
            return {
              textResultForLlm: `MCP proxy error (${response.status}): ${err.error ?? 'unknown'}`,
              resultType: 'failure' as const,
              error: err.error ?? response.statusText,
            };
          }

          const data = await response.json() as { tool?: string; result?: string; error?: string };
          return {
            textResultForLlm: data.result ?? JSON.stringify(data),
            resultType: 'success' as const,
          };
        } catch (err) {
          return {
            textResultForLlm: `MCP proxy call failed: ${err instanceof Error ? err.message : err}`,
            resultType: 'failure' as const,
            error: String(err),
          };
        }
      },
    });
    this.tools.set('squad_mcp_call', squadMcpCall);
  }

  /** Find the MCP proxy port from workspace or env */
  private findMcpProxyPort(): number | null {
    const envPort = process.env['SQUAD_MCP_PROXY_PORT'];
    if (envPort) return parseInt(envPort, 10);

    const portFile = path.join(this.squadRoot, '.squad', '.mcp-proxy-port');
    try {
      const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
      if (port > 0) return port;
    } catch { /* not found */ }

    return null;
  }

  /** Get all registered tools for session config */
  getTools(): SquadTool<any>[] {
    return Array.from(this.tools.values());
  }

  /** Get tools filtered by agent's allowed tool list */
  getToolsForAgent(allowedTools?: string[]): SquadTool<any>[] {
    if (!allowedTools) return this.getTools();
    return allowedTools
      .map(name => this.tools.get(name))
      .filter((t): t is NonNullable<typeof t> => t != null);
  }

  /** Get a specific tool by name */
  getTool(name: string): SquadTool<any> | undefined {
    return this.tools.get(name);
  }

  /** Register an external tool (e.g., from MCP bridge) */
  registerTool(tool: SquadTool<any>): void {
    this.tools.set(tool.name, tool);
  }
}
