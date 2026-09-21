// "Ask <AI tool>" prompt templates (one copy — was duplicated per view).
//
//   const prompt = buildAiPrompt('logs', { kindLabel: 'Pod', name, namespace });
//   window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt } }));

const CTX = 'Your kubeconfig context is already set to this cluster — use kubectl directly.';

/** Resource kinds that have per-pod logs and live CPU/memory metrics worth analysing. */
export const HAS_LOGS_METRICS = new Set(['pod', 'deployment', 'statefulSet', 'daemonSet', 'replicaSet', 'replicationController', 'job', 'cronJob']);

export const AI_ACTIONS = [
  { key: 'summarize', icon: 'sparkles', label: 'Summarize' },
  { key: 'events', icon: 'events', label: 'Analyze events' },
  { key: 'metrics', icon: 'cpu', label: 'Analyze metrics', needsLogsMetrics: true },
  { key: 'logs', icon: 'logs', label: 'Analyze logs', needsLogsMetrics: true },
  { key: 'related', icon: 'topology', label: 'Analyze related resources' },
];

const TEMPLATES = {
  summarize: (where) => `Summarize ${where}: its purpose, current status and health, and anything notable. ${CTX}`,
  events: (where) => `Analyze the recent events for ${where}. Inspect kubectl events / describe, surface any warnings or errors, and explain the likely cause and how to fix them. ${CTX}`,
  metrics: (where) => `Analyze resource usage (CPU and memory) for ${where}. Use kubectl top plus the configured requests/limits; flag saturation, throttling or waste and recommend right-sizing. ${CTX}`,
  logs: (where) => `Analyze the logs of ${where}. Fetch recent logs with kubectl logs, surface errors and warnings with their likely root cause, and suggest next steps. ${CTX}`,
  related: (where) => `Find and analyze the resources related to ${where} — owner references, selectors, Services, Endpoints, ConfigMaps/Secrets and PVCs. Explain how they connect and whether any are unhealthy. ${CTX}`,
};

/** Describe the target: `the Kubernetes Pod "web-1" in namespace default`. */
export function describeTarget({ kindLabel, name, namespace }) {
  return `the Kubernetes ${kindLabel || 'resource'} "${name}"${namespace ? ` in namespace ${namespace}` : ''}`;
}

/** Full prompt for an action; falls back to `summarize` for unknown actions. */
export function buildAiPrompt(action, target) {
  const where = describeTarget(target);
  return (TEMPLATES[action] || TEMPLATES.summarize)(where);
}

/** Actions available for a resource type (metrics/logs only for workloads). */
export function aiActionsFor(resourceType) {
  const has = HAS_LOGS_METRICS.has(resourceType);
  return AI_ACTIONS.filter((a) => !a.needsLogsMetrics || has);
}

/** Dispatch the prompt to the assistant (agent terminal or built-in chat). */
export function askAssistant(prompt) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('assistant:ask', { detail: { prompt } }));
}
