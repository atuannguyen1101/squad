/**
 * Agent lifecycle management - system prompt building with intent context
 */
import { IntentGraph } from '../intent/IntentGraph.js';
import { IntentSummarizer } from '../intent/IntentSummarizer.js';

export interface SystemPromptOptions {
  agentName: string;
  role: string;
  charter?: string;
  history?: string[];
  intentGraph?: IntentGraph;
  includeIntentContext?: boolean;
}

export interface SquadConfig {
  includeIntentContext?: boolean;
  // ... other config options
}

/**
 * Build a system prompt for an agent
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [];

  // Agent identity
  sections.push(`# ${options.agentName} — ${options.role}\n`);

  // Charter if provided
  if (options.charter) {
    sections.push('## Charter\n');
    sections.push(options.charter);
    sections.push('');
  }

  // Intent context if enabled and available
  if (
    options.includeIntentContext &&
    options.intentGraph
  ) {
    const summary = IntentSummarizer.summarizeForAgent(
      options.intentGraph,
      options.agentName
    );
    sections.push(IntentSummarizer.toMarkdown(summary));
  }

  // History if provided
  if (options.history && options.history.length > 0) {
    sections.push('## Recent Context\n');
    options.history.forEach((entry) => {
      sections.push(entry);
    });
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Create system prompt with squad config
 */
export function createSystemPromptWithConfig(
  options: Omit<SystemPromptOptions, 'includeIntentContext'>,
  config: SquadConfig
): string {
  return buildSystemPrompt({
    ...options,
    includeIntentContext: config.includeIntentContext ?? false,
  });
}
