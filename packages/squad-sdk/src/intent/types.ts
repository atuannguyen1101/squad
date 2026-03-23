/**
 * Core types for intent graph tracking
 */

export interface IntentNode {
  id: string;
  type: 'goal' | 'constraint' | 'acceptance_criterion' | 'task';
  description: string;
  assignedTo?: string; // Agent name
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface IntentEdge {
  from: string;
  to: string;
  type: 'depends_on' | 'blocks' | 'enables' | 'part_of';
}

export interface IntentGraphData {
  nodes: IntentNode[];
  edges: IntentEdge[];
  metadata?: {
    created: string;
    updated: string;
    rootGoal?: string;
  };
}

export interface IntentSummary {
  overallGoal: string;
  agentAssignment?: {
    taskId: string;
    description: string;
    status: string;
  };
  relevantConstraints: string[];
  relevantAcceptanceCriteria: string[];
  contextInPipeline: string;
}

/**
 * Types for intent-graph.ts and parse-phase-output.ts
 */

export interface IntentTask {
  id: string;
  description: string;
  assignedAgent: string;
  status: 'pending' | 'in-progress' | 'completed';
  dependencies?: string[];
}

export interface IntentGraph {
  goal: string;
  constraints: string[];
  preferences: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  currentStatus: 'clarifying' | 'ready' | 'in-progress' | 'completed';
  tasks: IntentTask[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    clarificationRounds: number;
    version: number;
  };
}

export interface IntentGraphUpdate {
  goal?: string;
  constraints?: string[];
  preferences?: string[];
  acceptanceCriteria?: string[];
  openQuestions?: string[];
  currentStatus?: 'clarifying' | 'ready' | 'in-progress' | 'completed';
  tasks?: IntentTask[];
}
