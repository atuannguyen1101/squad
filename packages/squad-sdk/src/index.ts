/**
 * Squad SDK — Public API barrel export.
 * This module has ZERO side effects. Safe to import as a library.
 * CLI entry point lives in src/cli-entry.ts.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
export const VERSION: string = pkg.version;

// Export public API
export { resolveSquad, resolveGlobalSquadPath, resolvePersonalSquadDir, ensureSquadPath, ensureSquadPathTriple, loadDirConfig, isConsultMode } from './resolution.js';
export type { SquadDirConfig, ResolvedSquadPaths } from './resolution.js';
export * from './config/index.js';
export * from './agents/onboarding.js';
export { resolvePersonalAgents, mergeSessionCast } from './agents/personal.js';
export type { PersonalAgentMeta, PersonalAgentManifest } from './agents/personal.js';
export * from './casting/index.js';
export * from './skills/index.js';
export { selectResponseTier, getTier } from './coordinator/response-tiers.js';
export type { ResponseTier, TierName, TierContext, ModelTierSuggestion } from './coordinator/response-tiers.js';
export { HandoffManager } from './coordinator/handoff.js';
export type { HandoffRequest, HandoffResult, HandoffChainNode, HandoffConfig } from './coordinator/handoff.js';
export { MetricsTracker } from './coordinator/metrics.js';
export type { AgentMetrics, TaskOutcome, MetricsSnapshot } from './coordinator/metrics.js';
export { RouteScorer } from './coordinator/route-scorer.js';
export type { ScoredRoute, RouteScoreConfig } from './coordinator/route-scorer.js';
export { EscalationManager } from './coordinator/escalation.js';
export type { EscalationLevel, EscalationConfig, EscalationContext, EscalationState, EscalationEvent } from './coordinator/escalation.js';
export { createMetricsTool } from './tools/metrics-tool.js';
export type { MetricsQuery } from './tools/metrics-tool.js';
export { loadConfig, loadConfigSync } from './runtime/config.js';
export type { ConfigLoadResult, ConfigValidationError } from './runtime/config.js';
export { MODELS, TIMEOUTS, AGENT_ROLES } from './runtime/constants.js';
export type { AgentRole } from './runtime/constants.js';
export * from './runtime/streaming.js';
export * from './runtime/cost-tracker.js';
export * from './runtime/telemetry.js';
export * from './runtime/offline.js';
export * from './runtime/i18n.js';
export * from './runtime/benchmarks.js';
export * from './runtime/otel-init.js';
export * from './runtime/otel-metrics.js';
export * from './runtime/rework.js';
export { getMeter, getTracer } from './runtime/otel.js';
export { safeTimestamp } from './utils/safe-timestamp.js';
export { EventBus as RuntimeEventBus } from './runtime/event-bus.js';
export {
  type SquadManifest,
  type SquadContact,
  type AcceptedWorkType,
  type DiscoveredSquad,
  type CrossSquadIssueOptions,
  type CrossSquadIssueResult,
  type CrossSquadWorkStatus,
  validateManifest,
  readManifest,
  discoverSquads,
  discoverFromUpstreams,
  discoverFromRegistry,
  buildDelegationArgs,
  buildStatusCheckArgs,
  parseIssueStatus,
  formatDiscoveryTable,
  findSquadByName,
} from './runtime/cross-squad.js';

export * from './marketplace/index.js';
export * from './build/index.js';
export * from './sharing/index.js';
export * from './upstream/index.js';
export * from './remote/index.js';
export * from './streams/index.js';

// Builder functions (SDK-First Squad Mode)
export {
  defineTeam,
  defineAgent,
  defineBudget,
  defineRouting,
  defineCeremony,
  defineHooks,
  defineCasting,
  defineTelemetry,
  defineDefaults,
  defineSkill,
  defineSquad,
  BuilderValidationError,
} from './builders/index.js';
export type {
  AgentRef,
  ScheduleExpression,
  BuilderModelId,
  BudgetDefinition,
  ModelPreference,
  DefaultsDefinition,
  TeamDefinition,
  AgentCapability,
  AgentDefinition,
  RoutingRule as BuilderRoutingRule,
  RoutingDefinition,
  CeremonyDefinition,
  HooksDefinition,
  CastingDefinition,
  TelemetryDefinition,
  SkillDefinition as BuilderSkillDefinition,
  SkillTool as BuilderSkillTool,
  SquadSDKConfig,
} from './builders/index.js';
// Base Roles (built-in role catalog)
export * from './roles/index.js';
export * from './platform/index.js';

// Proposal Pipeline (self-improvement system)
export {
  classifyProposalRisk,
  classifyProposals,
  classifyPathSensitivity,
  generateProposalId,
  createProposalRecord,
  formatProposalMarkdown,
  autoApplyProposal,
  saveAppliedRecord,
  formatProposalsForUser,
  loadEffectivenessLog,
  saveEffectivenessLog,
  recordApplicationForTracking,
  checkEffectiveness,
  runProposalPipeline,
} from './mcp/proposal-pipeline.js';
export type {
  ProposalCategory,
  ProposalPriority,
  ProposalRiskLevel,
  ImprovementProposal,
  ClassifiedProposal,
  ProposalStatus,
  ProposalRecord,
  AutoApplyResult,
  EffectivenessRecord,
  EffectivenessLog,
  PipelineResult,
} from './mcp/proposal-pipeline.js';

// Ceremony Runner (ceremony execution engine)
export {
  CeremonyRunner,
  buildRetrospectivePrompt,
  buildCeremonyContext,
  formatCeremonyReport,
  saveCeremonyReport,
  triggerCeremonyManually,
} from './server/ceremony-runner.js';
export type {
  CeremonyType,
  CeremonyConfigExtended,
  CeremonyPulse,
  AppliedProposalSummary,
  CeremonyContext,
  CeremonyResult,
  CeremonyDispatchFn,
} from './server/ceremony-runner.js';

// Built-in ceremony types
export {
  createDefaultRetrospective,
  createIdleRetrospective,
  validateCeremonyConfig,
} from './server/ceremonies/retrospective.js';

// Intent Graph (Sprint 3, Item #14)
export {
  IntentGraph,
  IntentSummarizer,
  type IntentNode,
  type IntentEdge,
  type IntentGraphData,
  type IntentSummary,
} from './intent/index.js';

export {
  buildSystemPrompt,
  createSystemPromptWithConfig,
  type SystemPromptOptions,
  type SquadConfig,
} from './agents/agent-lifecycle.js';

// Server (Orchestration Server)
export * from './server/index.js';

// MCP (Model Context Protocol bridge)
export * from './mcp/index.js';
>>>>>>> f0fba37 (feat: add MCP bridge for Copilot integration (Phase 2))
