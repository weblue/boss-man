/**
 * MCP (Model Context Protocol) server — Streamable HTTP transport.
 * Implements JSON-RPC 2.0 over POST /mcp.
 * No SDK dependency; protocol is implemented directly.
 *
 * Beads tools (beads_prime, beads_create_task, etc.) are backed by SQLite
 * (runs.db) — no external Dolt container required.
 *
 * URL params:
 *   ?sessionId=<uuid>   — orchestrator session for session_set_status / session_compact
 *   ?projectId=<id>     — project scope for all beads_* tools
 */
import { Hono } from 'hono';
import { SERVER_PORT } from '../config.js';
import {
  addTaskDep,
  closeTask,
  generatePrimeContext,
  insertMemory,
  insertTask,
  listUnblockedTasks,
  randomTaskId,
  updateTask,
} from '../db.js';

const router = new Hono();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'beads_prime',
    description: 'Load task state and memories for this project. Call this at session startup.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'beads_create_task',
    description: 'Create a new task. Returns the task ID (bd-XXXX).',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        details: { type: 'string' },
      },
      required: ['description'],
    },
  },
  {
    name: 'beads_add_dependency',
    description: 'Add a dependency between tasks. child is blocked by parent.',
    inputSchema: {
      type: 'object',
      properties: {
        child_id: { type: 'string' },
        parent_id: { type: 'string' },
      },
      required: ['child_id', 'parent_id'],
    },
  },
  {
    name: 'beads_complete_task',
    description: 'Mark a task as complete (closed).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'beads_list_unblocked',
    description: 'List all tasks that have no unresolved blockers and are ready to work on.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'beads_remember',
    description: 'Store a persistent memory note for this project.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
      },
      required: ['note'],
    },
  },
  {
    name: 'beads_update_task',
    description: 'Update a task status or claim it for work.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string' },
        claim: { type: 'boolean' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'session_set_status',
    description: 'Update the orchestrator session status (discovery | planning | executing | complete).',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['discovery', 'planning', 'executing', 'complete'],
        },
      },
      required: ['status'],
    },
  },
  {
    name: 'session_compact',
    description:
      'Trigger context compaction: starts a fresh orchestrator run seeded from checkpoint.md. ' +
      'Call this after writing checkpoint.md when context is too large, then exit.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type ToolResult =
  | { content: [{ type: 'text'; text: string }] }
  | { content: [{ type: 'text'; text: string }]; isError: true };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

async function callTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  sessionId: string | undefined,
  projectId: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'beads_prime': {
        if (!projectId) return ok('No project context available (projectId missing).');
        return ok(generatePrimeContext(projectId));
      }

      case 'beads_create_task': {
        if (!projectId) return err('projectId missing from MCP URL');
        const { description, details } = args as { description: string; details?: string };
        const id = randomTaskId();
        insertTask({
          id,
          project_id: projectId,
          title: description,
          description: details ?? null,
          status: 'open',
          created_at: Date.now(),
        });
        return ok(`task_id: ${id}\nCreated task ${id}: ${description}`);
      }

      case 'beads_add_dependency': {
        const { child_id, parent_id } = args as { child_id: string; parent_id: string };
        addTaskDep(child_id, parent_id);
        return ok(`Dependency added: ${child_id} blocked by ${parent_id}`);
      }

      case 'beads_complete_task': {
        const { task_id } = args as { task_id: string };
        closeTask(task_id);
        return ok(`Closed task ${task_id}`);
      }

      case 'beads_list_unblocked': {
        if (!projectId) return err('projectId missing from MCP URL');
        const tasks = listUnblockedTasks(projectId);
        return ok(JSON.stringify(tasks, null, 2));
      }

      case 'beads_remember': {
        if (!projectId) return err('projectId missing from MCP URL');
        const { note } = args as { note: string };
        insertMemory(projectId, note);
        return ok(`Memory stored: ${note}`);
      }

      case 'beads_update_task': {
        const { task_id, status, claim } = args as {
          task_id: string;
          status?: string;
          claim?: boolean;
        };
        updateTask(task_id, { status, claim });
        return ok(`Updated task ${task_id}`);
      }

      case 'session_set_status': {
        if (!sessionId) return err('no sessionId in URL');
        if (!/^[0-9a-f-]{36}$/.test(sessionId)) return err('invalid sessionId format');
        const { status } = args as { status: string };
        const res = await fetch(`http://localhost:${SERVER_PORT}/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return ok(`status updated to ${status}`);
        const text = await res.text();
        return err(text || `HTTP ${res.status}`);
      }

      case 'session_compact': {
        if (!sessionId) return err('no sessionId in URL');
        if (!/^[0-9a-f-]{36}$/.test(sessionId)) return err('invalid sessionId format');
        const res = await fetch(
          `http://localhost:${SERVER_PORT}/api/sessions/${sessionId}/compact`,
          { method: 'POST', signal: AbortSignal.timeout(10_000) },
        );
        if (res.ok) return ok('compaction triggered, exit now');
        const text = await res.text();
        return err(text || `HTTP ${res.status}`);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

function jsonRpcOk(id: string | number | null | undefined, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): Response {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /mcp → 405 Method Not Allowed
router.get('/mcp', (c) => {
  return c.text(
    'MCP endpoint only accepts POST requests (Streamable HTTP transport). ' +
      'Send JSON-RPC 2.0 requests to POST /mcp.',
    405,
  );
});

// POST /mcp — main JSON-RPC handler
router.post('/mcp', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  // JSON-RPC 2.0 requires the request to be an object (not array, null, primitive).
  // Arrays would be batch requests — not supported; null/primitives are invalid.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  const { id, method, params } = body as JsonRpcRequest;

  // Notifications have no `id` — respond with HTTP 202 and no body
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case 'initialize':
      return jsonRpcOk(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'boss-man', version: '1.0.0' },
      });

    case 'notifications/initialized':
      // Belt-and-suspenders: if someone sends this with an id, treat as notification
      return new Response(null, { status: 202 });

    case 'tools/list':
      return jsonRpcOk(id, { tools: TOOLS });

    case 'ping':
      return jsonRpcOk(id, {});

    case 'tools/call': {
      const toolName: string = params?.name;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolArgs: Record<string, any> = params?.arguments ?? {};
      if (!toolName) {
        return jsonRpcError(id, -32602, 'Invalid params: missing name');
      }
      const url = new URL(c.req.url);
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const projectId = url.searchParams.get('projectId') ?? '';
      const result = await callTool(toolName, toolArgs, sessionId, projectId);
      return jsonRpcOk(id, result);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
});

export default router;
