import { insertEvent, listEvents, getRun } from './db.js';

type Subscriber = (event: AgentEvent) => void;

export interface AgentEvent {
  /** Stable sequence number (terminal_events row id). Set on persisted events and
   *  on live events after pushEvent. Clients dedupe replay/live overlap by it. */
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

/** Persist + broadcast an event. Returns the row id (= seq). */
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
      return [{ ...parsed, seq: event.id }]; // seq = row id for client dedup
    } catch {
      // Malformed JSON — surface raw data rather than drop the event.
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

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Build and return an SSE Response that streams events for the given run. */
export function createRunEventStream(runId: string, signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        let unsub: (() => void) | undefined;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeatTimer);
          unsub?.();
          try { controller.close(); } catch { /* already closed */ }
        };

        const send = (event: AgentEvent) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            close();
            return;
          }
          if (event.type === 'done' || event.type === 'error') close();
        };

        // Subscribe before replay to avoid missing a live event in the gap; client dedupes by seq.
        unsub = subscribe(runId, send);

        // Replay persisted events so late joiners see full history.
        for (const event of getPersistedEvents(runId)) {
          send(event);
          if (closed) return;
        }

        // Terminal status with no done/error persisted (cancelled, server restart) → synthesize + close.
        if (!closed) {
          const currentRun = getRun(runId);
          if (!currentRun || TERMINAL_RUN_STATUSES.has(currentRun.status)) {
            const termType = currentRun?.status === 'failed' ? 'error' : 'done';
            send({
              type: termType,
              text: currentRun?.error ?? undefined,
              timestamp: new Date().toISOString(),
            });
            return;
          }
        }

        // 15s heartbeat — keeps the connection past idle-closing proxies/LBs.
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(': heartbeat\n\n'));
          } catch {
            close();
          }
        }, 15_000);

        signal.addEventListener('abort', close);
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
}
