/**
 * Tests for Proposal Pipeline — Risk classifier, auto-apply, effectiveness tracking.
 *
 * Covers:
 * - Risk classification logic (classifyProposalRisk, classifyPathSensitivity)
 * - Batch classification (classifyProposals)
 * - Proposal persistence (generateProposalId, formatProposalMarkdown)
 * - Auto-apply engine (autoApplyProposal)
 * - Effectiveness tracking (loadEffectivenessLog, checkEffectiveness)
 * - Full pipeline orchestration (runProposalPipeline)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
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
  type ImprovementProposal,
  type ProposalRecord,
  type ClassifiedProposal,
} from '@bradygaster/squad-sdk/mcp/proposal-pipeline';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<ImprovementProposal> = {}): ImprovementProposal {
  return {
    category: 'charter',
    targetFile: '.squad/agents/test/charter.md',
    title: 'Test Proposal',
    description: 'Test description',
    expectedImpact: 'Better test coverage',
    priority: 'low',
    evidence: ['Evidence 1'],
    ...overrides,
  };
}

let tempDir: string;

function setupTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-pipeline-test-'));
  // Create .squad directory structure
  fs.mkdirSync(path.join(dir, '.squad', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.squad', 'skills', 'test-skill'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.squad', 'agents', 'test'), { recursive: true });
  // Create a test skill file
  fs.writeFileSync(
    path.join(dir, '.squad', 'skills', 'test-skill', 'SKILL.md'),
    '# Test Skill\n\nOriginal content.\n',
  );
  // Create a test charter file
  fs.writeFileSync(
    path.join(dir, '.squad', 'agents', 'test', 'charter.md'),
    '# Test Agent Charter\n\nOriginal charter content.\n',
  );
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Path Sensitivity Tests ─────────────────────────────────────────────────

describe('classifyPathSensitivity', () => {
  it('should classify .squad/skills/ paths as safe', () => {
    expect(classifyPathSensitivity('.squad/skills/test/SKILL.md')).toBe('safe');
  });

  it('should classify .squad/agents/ paths as safe', () => {
    expect(classifyPathSensitivity('.squad/agents/test/charter.md')).toBe('safe');
  });

  it('should classify .copilot/skills/ paths as safe', () => {
    expect(classifyPathSensitivity('.copilot/skills/test/SKILL.md')).toBe('safe');
  });

  it('should classify squad.config.ts as dangerous', () => {
    expect(classifyPathSensitivity('squad.config.ts')).toBe('dangerous');
  });

  it('should classify squad.config.js as dangerous', () => {
    expect(classifyPathSensitivity('squad.config.js')).toBe('dangerous');
  });

  it('should classify .github/workflows/ as dangerous', () => {
    expect(classifyPathSensitivity('.github/workflows/ci.yml')).toBe('dangerous');
  });

  it('should classify package.json as dangerous', () => {
    expect(classifyPathSensitivity('package.json')).toBe('dangerous');
  });

  it('should classify tsconfig files as dangerous', () => {
    expect(classifyPathSensitivity('tsconfig.json')).toBe('dangerous');
  });

  it('should classify other paths as moderate', () => {
    expect(classifyPathSensitivity('src/index.ts')).toBe('moderate');
    expect(classifyPathSensitivity('.squad/routing.md')).toBe('moderate');
    expect(classifyPathSensitivity('docs/guide.md')).toBe('moderate');
  });

  it('should normalize backslashes to forward slashes', () => {
    expect(classifyPathSensitivity('.squad\\skills\\test\\SKILL.md')).toBe('safe');
  });
});

// ─── Risk Classifier Tests ──────────────────────────────────────────────────

describe('classifyProposalRisk', () => {
  describe('auto-apply candidates', () => {
    it('should auto-apply low-priority skill changes to safe paths', () => {
      const proposal = makeProposal({
        category: 'skill',
        priority: 'low',
        targetFile: '.squad/skills/test/SKILL.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('auto-apply');
    });

    it('should auto-apply low-priority charter changes to safe paths', () => {
      const proposal = makeProposal({
        category: 'charter',
        priority: 'low',
        targetFile: '.squad/agents/test/charter.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('auto-apply');
    });
  });

  describe('surface-to-user candidates', () => {
    it('should surface medium-priority skill changes', () => {
      const proposal = makeProposal({
        category: 'skill',
        priority: 'medium',
        targetFile: '.squad/skills/test/SKILL.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('surface-to-user');
    });

    it('should surface low-priority routing changes', () => {
      const proposal = makeProposal({
        category: 'routing',
        priority: 'low',
        targetFile: '.squad/routing.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('surface-to-user');
    });

    it('should surface medium-priority charter changes to safe paths', () => {
      const proposal = makeProposal({
        category: 'charter',
        priority: 'medium',
        targetFile: '.squad/agents/test/charter.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('surface-to-user');
    });
  });

  describe('needs-review candidates', () => {
    it('should require review for high-priority proposals regardless of category', () => {
      const proposal = makeProposal({
        category: 'skill',
        priority: 'high',
        targetFile: '.squad/skills/test/SKILL.md',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('needs-review');
    });

    it('should require review for sdk-config category', () => {
      const proposal = makeProposal({
        category: 'sdk-config',
        priority: 'low',
        targetFile: '.squad/config.json',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('needs-review');
    });

    it('should require review for workflow category', () => {
      const proposal = makeProposal({
        category: 'workflow',
        priority: 'low',
        targetFile: '.squad/workflows/build.yml',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('needs-review');
    });

    it('should require review for dangerous file paths', () => {
      const proposal = makeProposal({
        category: 'skill',
        priority: 'low',
        targetFile: 'squad.config.ts',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('needs-review');
    });

    it('should require review for workflow file paths', () => {
      const proposal = makeProposal({
        category: 'charter',
        priority: 'low',
        targetFile: '.github/workflows/ci.yml',
      });
      const result = classifyProposalRisk(proposal);
      expect(result.riskLevel).toBe('needs-review');
    });
  });

  it('should include a risk reason', () => {
    const result = classifyProposalRisk(makeProposal());
    expect(result.riskReason).toBeTruthy();
    expect(typeof result.riskReason).toBe('string');
  });

  it('should preserve the original proposal in the classified result', () => {
    const proposal = makeProposal({ title: 'Unique Title 123' });
    const result = classifyProposalRisk(proposal);
    expect(result.proposal).toBe(proposal);
    expect(result.proposal.title).toBe('Unique Title 123');
  });
});

// ─── Batch Classification Tests ─────────────────────────────────────────────

describe('classifyProposals', () => {
  it('should group proposals by risk level', () => {
    const proposals = [
      makeProposal({ category: 'skill', priority: 'low', targetFile: '.squad/skills/a/SKILL.md' }),
      makeProposal({ category: 'routing', priority: 'medium', targetFile: '.squad/routing.md' }),
      makeProposal({ category: 'sdk-config', priority: 'high', targetFile: 'squad.config.ts' }),
    ];

    const result = classifyProposals(proposals);
    expect(result.autoApply).toHaveLength(1);
    expect(result.surfaceToUser).toHaveLength(1);
    expect(result.needsReview).toHaveLength(1);
  });

  it('should return empty arrays for no proposals', () => {
    const result = classifyProposals([]);
    expect(result.autoApply).toHaveLength(0);
    expect(result.surfaceToUser).toHaveLength(0);
    expect(result.needsReview).toHaveLength(0);
  });
});

// ─── Proposal ID and Markdown Tests ─────────────────────────────────────────

describe('generateProposalId', () => {
  it('should create a slug from title and timestamp', () => {
    const id = generateProposalId('Fix Routing Issues', '2026-03-23T05:00:00.000Z');
    expect(id).toBe('2026-03-23T05-00-00-fix-routing-issues');
  });

  it('should truncate long titles', () => {
    const longTitle = 'A'.repeat(100);
    const id = generateProposalId(longTitle, '2026-03-23T05:00:00.000Z');
    expect(id.length).toBeLessThan(100);
  });

  it('should handle special characters in title', () => {
    const id = generateProposalId('Fix @#$ Special!', '2026-03-23T05:00:00.000Z');
    expect(id).toMatch(/^[\w-]+$/);
  });
});

describe('formatProposalMarkdown', () => {
  it('should format a proposal record as markdown', () => {
    const classified = classifyProposalRisk(makeProposal());
    const record = createProposalRecord(classified, 'test-id');
    const md = formatProposalMarkdown(record);

    expect(md).toContain('# Test Proposal');
    expect(md).toContain('**Status:** pending');
    expect(md).toContain('**Category:** charter');
    expect(md).toContain('**Priority:** low');
    expect(md).toContain('## Description');
    expect(md).toContain('## Evidence');
  });

  it('should include risk assessment section', () => {
    const classified = classifyProposalRisk(makeProposal());
    const record = createProposalRecord(classified);
    const md = formatProposalMarkdown(record);

    expect(md).toContain('## Risk Assessment');
    expect(md).toContain(classified.riskReason);
  });

  it('should include applied section when appliedAt is set', () => {
    const classified = classifyProposalRisk(makeProposal());
    const record = createProposalRecord(classified);
    record.appliedAt = '2026-03-23T05:00:00.000Z';
    record.beforeSnapshot = 'old content';
    record.afterSnapshot = 'new content';
    const md = formatProposalMarkdown(record);

    expect(md).toContain('## Applied');
    expect(md).toContain('### Before');
    expect(md).toContain('old content');
    expect(md).toContain('### After');
    expect(md).toContain('new content');
  });
});

// ─── Auto-Apply Tests ───────────────────────────────────────────────────────

describe('autoApplyProposal', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should apply to existing safe-path files', () => {
    const proposal = makeProposal({
      category: 'skill',
      priority: 'low',
      targetFile: '.squad/skills/test-skill/SKILL.md',
    });
    const classified = classifyProposalRisk(proposal);
    const record = createProposalRecord(classified);

    const result = autoApplyProposal(record, tempDir);
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('Auto-applied successfully');
    expect(result.beforeSnapshot).toContain('Test Skill');
    expect(result.afterSnapshot).toBeTruthy();

    // Verify file was modified
    const content = fs.readFileSync(
      path.join(tempDir, '.squad', 'skills', 'test-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('Auto-Applied:');
  });

  it('should refuse to apply to non-safe paths', () => {
    const proposal = makeProposal({
      category: 'routing',
      priority: 'low',
      targetFile: '.squad/routing.md',
    });
    const classified = classifyProposalRisk(proposal);
    const record = createProposalRecord(classified);

    const result = autoApplyProposal(record, tempDir);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('not in a safe path');
  });

  it('should refuse to create new files', () => {
    const proposal = makeProposal({
      category: 'skill',
      priority: 'low',
      targetFile: '.squad/skills/nonexistent/SKILL.md',
    });
    const classified = classifyProposalRisk(proposal);
    const record = createProposalRecord(classified);

    const result = autoApplyProposal(record, tempDir);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('does not exist');
  });
});

describe('saveAppliedRecord', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should save applied record to applied/ subdirectory', () => {
    const classified = classifyProposalRisk(makeProposal());
    const record = createProposalRecord(classified, 'test-applied');
    const result = { proposalId: 'test-applied', applied: true, reason: 'ok', beforeSnapshot: 'before', afterSnapshot: 'after' };

    saveAppliedRecord(record, result, tempDir);

    const appliedDir = path.join(tempDir, '.squad', 'proposals', 'applied');
    const files = fs.readdirSync(appliedDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('test-applied.md');

    const content = fs.readFileSync(path.join(appliedDir, 'test-applied.md'), 'utf-8');
    expect(content).toContain('**Status:** applied');
  });
});

// ─── Surface-to-User Tests ──────────────────────────────────────────────────

describe('formatProposalsForUser', () => {
  it('should format proposals as user-readable questions', () => {
    const classified: ClassifiedProposal = {
      proposal: makeProposal({ title: 'Fix Routing', category: 'routing', priority: 'medium' }),
      riskLevel: 'surface-to-user',
      riskReason: 'Medium-priority routing change',
    };

    const questions = formatProposalsForUser([classified]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('[Proposal] Fix Routing');
    expect(questions[0]).toContain('routing');
    expect(questions[0]).toContain('medium');
    expect(questions[0]).toContain('Action needed');
  });

  it('should return empty array for no proposals', () => {
    expect(formatProposalsForUser([])).toHaveLength(0);
  });
});

// ─── Effectiveness Tracking Tests ───────────────────────────────────────────

describe('Effectiveness Tracking', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('loadEffectivenessLog', () => {
    it('should return empty log when file does not exist', () => {
      const log = loadEffectivenessLog(tempDir);
      expect(log.records).toHaveLength(0);
    });

    it('should load existing log', () => {
      const logData = {
        records: [{
          proposalId: 'test-1',
          appliedAt: '2026-03-23T05:00:00.000Z',
          detectorSignals: { category: 'charter', targetFile: 'test.md' },
        }],
      };
      const filePath = path.join(tempDir, '.squad', 'proposals', 'effectiveness.json');
      fs.writeFileSync(filePath, JSON.stringify(logData), 'utf-8');

      const log = loadEffectivenessLog(tempDir);
      expect(log.records).toHaveLength(1);
      expect(log.records[0]!.proposalId).toBe('test-1');
    });
  });

  describe('recordApplicationForTracking', () => {
    it('should append a record to the effectiveness log', () => {
      const classified = classifyProposalRisk(makeProposal());
      const record = createProposalRecord(classified, 'track-test');

      recordApplicationForTracking(tempDir, record);

      const log = loadEffectivenessLog(tempDir);
      expect(log.records).toHaveLength(1);
      expect(log.records[0]!.proposalId).toBe('track-test');
      expect(log.records[0]!.detectorSignals.category).toBe('charter');
    });
  });

  describe('checkEffectiveness', () => {
    it('should mark proposals as effective when same detector does not fire', () => {
      // Set up a previously applied proposal
      const classified = classifyProposalRisk(makeProposal({
        category: 'charter',
        targetFile: '.squad/agents/test/charter.md',
      }));
      const record = createProposalRecord(classified, 'eff-test');
      recordApplicationForTracking(tempDir, record);

      // Current analysis has NO proposals for the same category+target → effective
      const log = checkEffectiveness(tempDir, []);
      expect(log.records[0]!.sameDetectorFiredAgain).toBe(false);
      expect(log.records[0]!.checkedAt).toBeTruthy();
    });

    it('should mark proposals as ineffective when same detector fires again', () => {
      const classified = classifyProposalRisk(makeProposal({
        category: 'charter',
        targetFile: '.squad/agents/test/charter.md',
      }));
      const record = createProposalRecord(classified, 'eff-test-2');
      recordApplicationForTracking(tempDir, record);

      // Current analysis HAS proposals for the same category+target → not effective
      const currentProposals = [makeProposal({
        category: 'charter',
        targetFile: '.squad/agents/test/charter.md',
      })];
      const log = checkEffectiveness(tempDir, currentProposals);
      expect(log.records[0]!.sameDetectorFiredAgain).toBe(true);
    });

    it('should skip already-checked records', () => {
      const classified = classifyProposalRisk(makeProposal());
      const record = createProposalRecord(classified, 'eff-test-3');
      recordApplicationForTracking(tempDir, record);

      // First check
      checkEffectiveness(tempDir, []);

      // Second check — should not modify already-checked
      const log = checkEffectiveness(tempDir, [makeProposal()]);
      expect(log.records[0]!.sameDetectorFiredAgain).toBe(false); // Still false from first check
    });
  });
});

// ─── Full Pipeline Tests ────────────────────────────────────────────────────

describe('runProposalPipeline', () => {
  beforeEach(() => {
    tempDir = setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should return empty result for no proposals', () => {
    const result = runProposalPipeline([], tempDir);
    expect(result.totalProcessed).toBe(0);
    expect(result.applied).toHaveLength(0);
    expect(result.userQuestions).toHaveLength(0);
    expect(result.pendingReview).toHaveLength(0);
  });

  it('should auto-apply safe proposals', () => {
    const proposals = [
      makeProposal({
        category: 'skill',
        priority: 'low',
        targetFile: '.squad/skills/test-skill/SKILL.md',
      }),
    ];

    const result = runProposalPipeline(proposals, tempDir);
    expect(result.totalProcessed).toBe(1);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.applied).toBe(true);
  });

  it('should surface medium-risk proposals and store them', () => {
    const proposals = [
      makeProposal({
        category: 'routing',
        priority: 'medium',
        targetFile: '.squad/routing.md',
      }),
    ];

    const result = runProposalPipeline(proposals, tempDir);
    expect(result.totalProcessed).toBe(1);
    expect(result.userQuestions).toHaveLength(1);
    expect(result.pendingReview).toHaveLength(1);
  });

  it('should store high-risk proposals as pending', () => {
    const proposals = [
      makeProposal({
        category: 'sdk-config',
        priority: 'high',
        targetFile: 'squad.config.ts',
      }),
    ];

    const result = runProposalPipeline(proposals, tempDir);
    expect(result.totalProcessed).toBe(1);
    expect(result.applied).toHaveLength(0);
    expect(result.pendingReview).toHaveLength(1);

    // Verify file was written
    const files = fs.readdirSync(path.join(tempDir, '.squad', 'proposals'))
      .filter(f => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('should handle mixed risk levels', () => {
    const proposals = [
      makeProposal({ category: 'skill', priority: 'low', targetFile: '.squad/skills/test-skill/SKILL.md' }),
      makeProposal({ category: 'routing', priority: 'medium', targetFile: '.squad/routing.md', title: 'Route Fix' }),
      makeProposal({ category: 'workflow', priority: 'high', targetFile: '.github/workflows/ci.yml', title: 'CI Fix' }),
    ];

    const result = runProposalPipeline(proposals, tempDir);
    expect(result.totalProcessed).toBe(3);
    expect(result.applied).toHaveLength(1); // skill auto-applied
    expect(result.userQuestions).toHaveLength(1); // routing surfaced
    expect(result.pendingReview.length).toBeGreaterThanOrEqual(2); // routing + workflow stored
  });
});
