import { insertEvent, listEvents } from './db.js';

type Subscriber = (event: AgentEvent) => void;

export interface AgentEvent {
  /** Stable autoincrement sequence number from the terminal_events DB row.
   *  Present on persisted events and on live events after pushEvent embeds it.
   *  Clients use this for deduplication when replaying + live streams overlap. */
  seq?: number;
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

/** Persist an event and broadcast it to all live subscribers.
 *  Returns the DB row id (= seq) so callers can track the sequence number. */
export function pushEvent(runId: string, event: AgentEvent): number {
  const seq = insertEvent({
    run_id: runId,
    type: event.type,
    data: JSON.stringify(event),
    timestamp: event.timestamp,
  });
  const withSeq: AgentEvent = { ...event, seq };
  subscribers.get(runId)?.forEach((fn) => fn(withSeq));
  return seq;
}

export function getPersistedEvents(runId: string): AgentEvent[] {
  return listEvents(runId).flatMap((event) => {
    try {
      const parsed = JSON.parse(event.data) as AgentEvent;
      // Attach the stable DB row id so clients can deduplicate against live events.
      return [{ ...parsed, seq: event.id }];
    } catch {
      // Malformed JSON in the DB — surface the raw data rather than dropping the event.
      return [{
        seq: event.id,
        type: event.type as AgentEvent['type'],
        text: event.data,
        timestamp: event.timestamp,
      }];
    }
  });
}

export function cleanupRunStream(runId: string) {
  subscribers.delete(runId);
}
