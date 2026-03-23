/**
 * Proposal Pipeline — Risk classification, auto-apply, and effectiveness tracking.
 *
 * Transforms raw ImprovementProposal objects from the analysis engine into
 * actionable outcomes:
 *   1. Classify risk → auto-apply | surface-to-user | needs-review
 *   2. Auto-apply low-risk proposals (skill/charter tweaks)
 *   3. Surface medium-risk proposals to the user via pulse questions
 *   4. Track effectiveness by comparing detector signals before/after
 *
 * Pure classification logic — I/O operations are injected via ProposalPipelineDeps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProposalCategory = 'charter' | 'routing' | 'sdk-config' | 'skill' | 'workflow';
export type ProposalPriority = 'low' | 'medium' | 'high';

/**
 * Risk classification determines how a proposal is handled.
 *
 * - `auto-apply`: Safe to apply without human review (skills, low-priority charter tweaks)
 * - `surface-to-user`: Needs human awareness — surfaced via pulse questions
 * - `needs-review`: Requires explicit human approval before any action
 */
export type ProposalRiskLevel = 'auto-apply' | 'surface-to-user' | 'needs-review';

export interface ImprovementProposal {
  category: ProposalCategory;
  targetFile: string;
  title: string;
  description: string;
  expectedImpact: string;
  priority: ProposalPriority;
  evidence: string[];
}

export interface ClassifiedProposal {
  /** Original proposal data. */
  proposal: ImprovementProposal;
  /** Computed risk level. */
  riskLevel: ProposalRiskLevel;
  /** Why this risk level was assigned. */
  riskReason: string;
}

/** Status of a proposal through the pipeline. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

export interface ProposalRecord {
  id: string;
  createdAt: string;
  status: ProposalStatus;
  proposal: ImprovementProposal;
  riskLevel?: ProposalRiskLevel;
  riskReason?: string;
  appliedAt?: string;
  /** Before-state snapshot (first 500 chars of target file, or null if new). */
  beforeSnapshot?: string | null;
  /** After-state description. */
  afterSnapshot?: string | null;
  reviewComment?: string;
}

export interface EffectivenessRecord {
  proposalId: string;
  appliedAt: string;
  detectorSignals: {
    /** Which detector category generated this proposal. */
    category: ProposalCategory;
    /** Target file the proposal modified. */
    targetFile: string;
  };
  /** Set on the next auto-sage run: did the same detector fire again? */
  sameDetectorFiredAgain?: boolean;
  /** Timestamp of the follow-up check. */
  checkedAt?: string;
}

export interface EffectivenessLog {
  records: EffectivenessRecord[];
}

// ─── File sensitivity classification ────────────────────────────────────────

/**
 * Paths considered safe for auto-apply (modifications unlikely to break anything).
 * Matched as prefix — e.g., `.squad/skills/` matches `.squad/skills/foo/SKILL.md`.
 */
const SAFE_PATH_PREFIXES: readonly string[] = [
  '.squad/skills/',
  '.squad/agents/',
  '.copilot/skills/',
];

/**
 * Paths considered dangerous — require explicit human review.
 * Matched as prefix or exact match.
 */
const DANGEROUS_PATH_PREFIXES: readonly string[] = [
  'squad.config.ts',
  'squad.config.js',
  '.github/workflows/',
  'package.json',
  'tsconfig',
];

/**
 * Classify a target file path as safe, moderate, or dangerous.
 */
export function classifyPathSensitivity(targetFile: string): 'safe' | 'moderate' | 'dangerous' {
  const normalized = targetFile.replace(/\\/g, '/');

  for (const prefix of DANGEROUS_PATH_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized === prefix) {
      return 'dangerous';
    }
  }

  for (const prefix of SAFE_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return 'safe';
    }
  }

  return 'moderate';
}

// ─── Risk Classifier ────────────────────────────────────────────────────────

/**
 * Classify a proposal's risk level based on category, priority, and target file.
 *
 * Classification matrix:
 *
 * | Category    | Priority | Path Safety | → Risk Level      |
 * |-------------|----------|-------------|-------------------|
 * | skill       | low      | safe        | auto-apply        |
 * | charter     | low      | safe        | auto-apply        |
 * | skill       | medium   | safe        | surface-to-user   |
 * | charter     | medium   | safe        | surface-to-user   |
 * | routing     | low      | safe        | surface-to-user   |
 * | routing     | *        | moderate    | surface-to-user   |
 * | *           | high     | *           | needs-review      |
 * | sdk-config  | *        | *           | needs-review      |
 * | workflow    | *        | *           | needs-review      |
 * | *           | *        | dangerous   | needs-review      |
 *
 * Pure function — no I/O.
 */
export function classifyProposalRisk(proposal: ImprovementProposal): ClassifiedProposal {
  const pathSensitivity = classifyPathSensitivity(proposal.targetFile);

  // Rule 1: Dangerous paths always need review
  if (pathSensitivity === 'dangerous') {
    return {
      proposal,
      riskLevel: 'needs-review',
      riskReason: `Target file "${proposal.targetFile}" is in a sensitive location (config/workflow)`,
    };
  }

  // Rule 2: High priority always needs review regardless of category
  if (proposal.priority === 'high') {
    return {
      proposal,
      riskLevel: 'needs-review',
      riskReason: `High-priority proposal requires human review`,
    };
  }

  // Rule 3: sdk-config and workflow categories always need review
  if (proposal.category === 'sdk-config' || proposal.category === 'workflow') {
    return {
      proposal,
      riskLevel: 'needs-review',
      riskReason: `Category "${proposal.category}" requires human review`,
    };
  }

  // Rule 4: skill/charter + low priority + safe path → auto-apply
  if (
    (proposal.category === 'skill' || proposal.category === 'charter') &&
    proposal.priority === 'low' &&
    pathSensitivity === 'safe'
  ) {
    return {
      proposal,
      riskLevel: 'auto-apply',
      riskReason: `Low-priority ${proposal.category} change to safe path — auto-applicable`,
    };
  }

  // Rule 5: Everything else → surface-to-user
  return {
    proposal,
    riskLevel: 'surface-to-user',
    riskReason: `${proposal.priority}-priority ${proposal.category} change — surfacing for user awareness`,
  };
}

/**
 * Classify a batch of proposals. Returns them grouped by risk level.
 */
export function classifyProposals(proposals: readonly ImprovementProposal[]): {
  autoApply: ClassifiedProposal[];
  surfaceToUser: ClassifiedProposal[];
  needsReview: ClassifiedProposal[];
} {
  const autoApply: ClassifiedProposal[] = [];
  const surfaceToUser: ClassifiedProposal[] = [];
  const needsReview: ClassifiedProposal[] = [];

  for (const proposal of proposals) {
    const classified = classifyProposalRisk(proposal);
    switch (classified.riskLevel) {
      case 'auto-apply':
        autoApply.push(classified);
        break;
      case 'surface-to-user':
        surfaceToUser.push(classified);
        break;
      case 'needs-review':
        needsReview.push(classified);
        break;
    }
  }

  return { autoApply, surfaceToUser, needsReview };
}

// ─── Proposal Persistence ───────────────────────────────────────────────────

/**
 * Generate a filesystem-safe proposal ID from title and timestamp.
 */
export function generateProposalId(title: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${safeTimestamp}-${slug}`;
}

/**
 * Create a ProposalRecord from a classified proposal.
 */
export function createProposalRecord(
  classified: ClassifiedProposal,
  id?: string,
): ProposalRecord {
  const now = new Date().toISOString();
  return {
    id: id ?? generateProposalId(classified.proposal.title, now),
    createdAt: now,
    status: 'pending',
    proposal: classified.proposal,
    riskLevel: classified.riskLevel,
    riskReason: classified.riskReason,
  };
}

/**
 * Format a ProposalRecord as a markdown file for `.squad/proposals/`.
 */
export function formatProposalMarkdown(record: ProposalRecord): string {
  const lines: string[] = [
    `# ${record.proposal.title}`,
    '',
    `**ID:** ${record.id}`,
    `**Status:** ${record.status}`,
    `**Category:** ${record.proposal.category}`,
    `**Priority:** ${record.proposal.priority}`,
    `**Target:** ${record.proposal.targetFile}`,
    `**Risk Level:** ${record.riskLevel ?? 'unclassified'}`,
    `**Created:** ${record.createdAt}`,
    '',
    '## Description',
    '',
    record.proposal.description,
    '',
    '## Expected Impact',
    '',
    record.proposal.expectedImpact,
    '',
    '## Evidence',
    '',
    ...record.proposal.evidence.map(e => `- ${e}`),
  ];

  if (record.riskReason) {
    lines.push('', '## Risk Assessment', '', record.riskReason);
  }

  if (record.appliedAt) {
    lines.push('', '## Applied', '', `Applied at: ${record.appliedAt}`);
    if (record.beforeSnapshot != null) {
      lines.push('', '### Before', '', '```', record.beforeSnapshot, '```');
    }
    if (record.afterSnapshot != null) {
      lines.push('', '### After', '', '```', record.afterSnapshot, '```');
    }
  }

  if (record.reviewComment) {
    lines.push('', '## Review', '', record.reviewComment);
  }

  return lines.join('\n') + '\n';
}

// ─── Auto-Apply Engine ──────────────────────────────────────────────────────

export interface AutoApplyResult {
  proposalId: string;
  applied: boolean;
  reason: string;
  beforeSnapshot?: string | null;
  afterSnapshot?: string | null;
}

/**
 * Attempt to auto-apply a proposal by appending content to the target file.
 *
 * Auto-apply is intentionally conservative:
 * - Only appends to existing files (never creates new files)
 * - Only modifies files in safe paths
 * - Records before/after state for audit
 *
 * For skill files, appends the proposal description as a new section.
 * For charter files, appends the proposal as a "## Improvement" section.
 */
export function autoApplyProposal(
  record: ProposalRecord,
  squadRoot: string,
): AutoApplyResult {
  const targetFile = path.join(squadRoot, record.proposal.targetFile);

  // Safety check: only apply to files in safe paths
  if (classifyPathSensitivity(record.proposal.targetFile) !== 'safe') {
    return {
      proposalId: record.id,
      applied: false,
      reason: `Target file "${record.proposal.targetFile}" is not in a safe path — refusing auto-apply`,
    };
  }

  // Read existing content (or note that file doesn't exist)
  let beforeContent: string | null = null;
  try {
    beforeContent = fs.readFileSync(targetFile, 'utf-8');
  } catch {
    // File doesn't exist — auto-apply won't create new files
    return {
      proposalId: record.id,
      applied: false,
      reason: `Target file "${record.proposal.targetFile}" does not exist — auto-apply only modifies existing files`,
    };
  }

  // Build the content to append
  const timestamp = new Date().toISOString();
  const appendContent = [
    '',
    `## Auto-Applied: ${record.proposal.title}`,
    '',
    `_Applied: ${timestamp} | Priority: ${record.proposal.priority} | Category: ${record.proposal.category}_`,
    '',
    record.proposal.description,
    '',
  ].join('\n');

  try {
    fs.writeFileSync(targetFile, beforeContent + appendContent, 'utf-8');
  } catch (err) {
    return {
      proposalId: record.id,
      applied: false,
      reason: `Failed to write to "${record.proposal.targetFile}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Snapshot: first 500 chars of before/after
  const beforeSnapshot = beforeContent.slice(0, 500);
  const afterContent = beforeContent + appendContent;
  const afterSnapshot = afterContent.slice(-500);

  return {
    proposalId: record.id,
    applied: true,
    reason: 'Auto-applied successfully',
    beforeSnapshot,
    afterSnapshot,
  };
}

/**
 * Save an applied proposal record to `.squad/proposals/applied/`.
 */
export function saveAppliedRecord(
  record: ProposalRecord,
  result: AutoApplyResult,
  squadRoot: string,
): void {
  const appliedDir = path.join(squadRoot, '.squad', 'proposals', 'applied');
  fs.mkdirSync(appliedDir, { recursive: true });

  const updatedRecord: ProposalRecord = {
    ...record,
    status: 'applied',
    appliedAt: new Date().toISOString(),
    beforeSnapshot: result.beforeSnapshot ?? null,
    afterSnapshot: result.afterSnapshot ?? null,
  };

  const filename = path.join(appliedDir, `${record.id}.md`);
  fs.writeFileSync(filename, formatProposalMarkdown(updatedRecord), 'utf-8');
}

// ─── Surface-to-User ────────────────────────────────────────────────────────

/**
 * Format proposals for surfacing to the user via pulse questions.
 * Returns an array of human-readable question strings.
 */
export function formatProposalsForUser(proposals: readonly ClassifiedProposal[]): string[] {
  return proposals.map(cp => {
    const p = cp.proposal;
    return [
      `[Proposal] ${p.title}`,
      `Category: ${p.category} | Priority: ${p.priority} | Target: ${p.targetFile}`,
      `Description: ${p.description}`,
      `Risk: ${cp.riskReason}`,
      `Action needed: Approve or reject this proposal.`,
    ].join('\n');
  });
}

// ─── Effectiveness Tracking ─────────────────────────────────────────────────

const EFFECTIVENESS_FILENAME = 'effectiveness.json';

/**
 * Load the effectiveness log from `.squad/proposals/effectiveness.json`.
 * Returns an empty log if the file doesn't exist.
 */
export function loadEffectivenessLog(squadRoot: string): EffectivenessLog {
  const filePath = path.join(squadRoot, '.squad', 'proposals', EFFECTIVENESS_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'records' in parsed &&
      Array.isArray((parsed as EffectivenessLog).records)
    ) {
      return parsed as EffectivenessLog;
    }
    return { records: [] };
  } catch {
    return { records: [] };
  }
}

/**
 * Save the effectiveness log to `.squad/proposals/effectiveness.json`.
 */
export function saveEffectivenessLog(squadRoot: string, log: EffectivenessLog): void {
  const dir = path.join(squadRoot, '.squad', 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, EFFECTIVENESS_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2) + '\n', 'utf-8');
}

/**
 * Record that a proposal was applied, for later effectiveness checking.
 */
export function recordApplicationForTracking(
  squadRoot: string,
  record: ProposalRecord,
): void {
  const log = loadEffectivenessLog(squadRoot);
  log.records.push({
    proposalId: record.id,
    appliedAt: new Date().toISOString(),
    detectorSignals: {
      category: record.proposal.category,
      targetFile: record.proposal.targetFile,
    },
  });
  saveEffectivenessLog(squadRoot, log);
}

/**
 * Check effectiveness of previously applied proposals.
 *
 * For each unchecked record in the effectiveness log, determines whether
 * the same detector category fired again for the same target file
 * in the latest analysis. If not, the proposal was effective.
 *
 * @param currentProposals - Proposals from the latest analysis run
 */
export function checkEffectiveness(
  squadRoot: string,
  currentProposals: readonly ImprovementProposal[],
): EffectivenessLog {
  const log = loadEffectivenessLog(squadRoot);
  const now = new Date().toISOString();

  // Build a set of (category, targetFile) tuples from current proposals
  const currentSignals = new Set(
    currentProposals.map(p => `${p.category}::${p.targetFile}`),
  );

  for (const record of log.records) {
    // Skip already-checked records
    if (record.checkedAt != null) continue;

    const signal = `${record.detectorSignals.category}::${record.detectorSignals.targetFile}`;
    record.sameDetectorFiredAgain = currentSignals.has(signal);
    record.checkedAt = now;
  }

  saveEffectivenessLog(squadRoot, log);
  return log;
}

// ─── Pipeline Orchestrator ──────────────────────────────────────────────────

export interface PipelineResult {
  /** Proposals that were auto-applied. */
  applied: AutoApplyResult[];
  /** Questions formatted for user surfacing (via pulse). */
  userQuestions: string[];
  /** Proposals that need explicit review (stored as pending). */
  pendingReview: ProposalRecord[];
  /** Total proposals processed. */
  totalProcessed: number;
}

/**
 * Run the full proposal pipeline:
 *   1. Classify all proposals by risk
 *   2. Auto-apply safe proposals
 *   3. Format medium-risk proposals for user surfacing
 *   4. Store high-risk proposals as pending for review
 *
 * Returns a summary of what was done.
 */
export function runProposalPipeline(
  proposals: readonly ImprovementProposal[],
  squadRoot: string,
): PipelineResult {
  if (proposals.length === 0) {
    return { applied: [], userQuestions: [], pendingReview: [], totalProcessed: 0 };
  }

  const { autoApply, surfaceToUser, needsReview } = classifyProposals(proposals);

  // 1. Auto-apply safe proposals
  const applied: AutoApplyResult[] = [];
  for (const classified of autoApply) {
    const record = createProposalRecord(classified);
    const result = autoApplyProposal(record, squadRoot);
    if (result.applied) {
      saveAppliedRecord(record, result, squadRoot);
      recordApplicationForTracking(squadRoot, record);
    }
    applied.push(result);
  }

  // 2. Format surface-to-user proposals
  const userQuestions = formatProposalsForUser(surfaceToUser);

  // 3. Store needs-review proposals as pending
  const pendingReview: ProposalRecord[] = [];
  const proposalDir = path.join(squadRoot, '.squad', 'proposals');
  fs.mkdirSync(proposalDir, { recursive: true });

  for (const classified of needsReview) {
    const record = createProposalRecord(classified);
    const filename = path.join(proposalDir, `${record.id}.md`);
    fs.writeFileSync(filename, formatProposalMarkdown(record), 'utf-8');
    pendingReview.push(record);
  }

  // Also store surface-to-user proposals as pending (they're surfaced AND stored)
  for (const classified of surfaceToUser) {
    const record = createProposalRecord(classified);
    const filename = path.join(proposalDir, `${record.id}.md`);
    fs.writeFileSync(filename, formatProposalMarkdown(record), 'utf-8');
    pendingReview.push(record);
  }

  return {
    applied,
    userQuestions,
    pendingReview,
    totalProcessed: proposals.length,
  };
}
