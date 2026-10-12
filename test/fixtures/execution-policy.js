export function managedPolicy() {
  return {
    version: 1, mode: 'managed',
    limits: { activeTasks: 4, agentExecutions: 4, workersPerTask: 2, heavyVerification: 1, dependencyInstalls: 1 },
    profiles: {
      implementation: { harness: 'codex', model: 'configured-model', effort: 'high', capabilities: ['read', 'edit', 'commands'] },
      review: { harness: 'claude', model: 'sonnet', effort: 'low', capabilities: ['read'] },
    },
    routing: { 'bounded-fix': 'implementation', implementation: 'implementation', 'independent-review': 'review', coordination: 'review' },
    sessions: { maxReplacements: 3, maxActions: 100, maxMinutes: 30, contextThresholdPercent: 80 },
  };
}

