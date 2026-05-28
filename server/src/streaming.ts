import { insertEvent } from './db.js';

type Subscriber = (event: AgentEvent) => void;

export interface AgentEvent {
  type: 'text' | 'toolCall' | 'toolResult' | 'iteration' | 'usage' | 'error' | 'done';
  text?: string;
  toolName?: string;
  iteration?: number;
  data?: unknown;
  timestamp: string;
}

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(runId: string, fn: Subscriber): () => void {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set());
  subscribers.get(runId)!.add(fn);
  return () => subscribers.get(runId)?.delete(fn);
}

export function pushEvent(runId: string, event: AgentEvent) {
  insertEvent({
    run_id: runId,
    type: event.type,
    data: JSON.stringify(event),
    timestamp: event.timestamp,
  });
  subscribers.get(runId)?.forEach((fn) => fn(event));
}

export function cleanupRunStream(runId: string) {
  subscribers.delete(runId);
}
