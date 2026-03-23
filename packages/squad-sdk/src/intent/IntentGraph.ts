/**
 * Intent Graph - tracks goals, constraints, acceptance criteria, and task assignments
 */
import { IntentNode, IntentEdge, IntentGraphData } from './types.js';

export class IntentGraph {
  private nodes: Map<string, IntentNode> = new Map();
  private edges: IntentEdge[] = [];
  private metadata: IntentGraphData['metadata'];

  constructor(data?: IntentGraphData) {
    if (data) {
      data.nodes.forEach((node) => this.nodes.set(node.id, node));
      this.edges = [...data.edges];
      this.metadata = data.metadata;
    } else {
      this.metadata = {
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
    }
  }

  addNode(node: IntentNode): void {
    this.nodes.set(node.id, node);
    this.touch();
  }

  getNode(id: string): IntentNode | undefined {
    return this.nodes.get(id);
  }

  getNodesByType(type: IntentNode['type']): IntentNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.type === type);
  }

  getNodesByAgent(agentName: string): IntentNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.assignedTo === agentName
    );
  }

  updateNode(id: string, updates: Partial<IntentNode>): void {
    const node = this.nodes.get(id);
    if (node) {
      this.nodes.set(id, { ...node, ...updates });
      this.touch();
    }
  }

  addEdge(edge: IntentEdge): void {
    this.edges.push(edge);
    this.touch();
  }

  getEdges(nodeId: string, direction: 'incoming' | 'outgoing' | 'both' = 'both'): IntentEdge[] {
    if (direction === 'incoming') {
      return this.edges.filter((e) => e.to === nodeId);
    } else if (direction === 'outgoing') {
      return this.edges.filter((e) => e.from === nodeId);
    }
    return this.edges.filter((e) => e.from === nodeId || e.to === nodeId);
  }

  getRootGoal(): IntentNode | undefined {
    const rootId = this.metadata?.rootGoal;
    if (rootId) {
      return this.getNode(rootId);
    }
    // Fallback: find a goal node with no parent
    const goals = this.getNodesByType('goal');
    return goals.find((g) => !g.parentId);
  }

  setRootGoal(nodeId: string): void {
    if (!this.metadata) {
      this.metadata = {
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
    }
    this.metadata.rootGoal = nodeId;
    this.touch();
  }

  serialize(): IntentGraphData {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      metadata: this.metadata,
    };
  }

  private touch(): void {
    if (this.metadata) {
      this.metadata.updated = new Date().toISOString();
    }
  }
}
