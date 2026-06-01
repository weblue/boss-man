/**
 * MCP (Model Context Protocol) server — Streamable HTTP transport.
 * Implements JSON-RPC 2.0 over POST /mcp.
 * No SDK dependency; protocol is implemented directly.
 */
import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_PORT, BEADS_STORE_PASSWORD } from '../config.js';

const execFileAsync = promisify(execFile);
const router = new Hono();
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// bd CLI env — same pattern as beads.ts
const BD_ENV: Record<string, string> = {
  BD_NON_INTERACTIVE: '1',
  ...(BEADS_STORE_PASSWORD ? { BEADS_DOLT_PASSWORD: BEADS_STORE_PASSWORD } : {}),
};

async function bd(...args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('bd', args, {
    cwd: REPO_ROOT,
    timeout: 15_000,
    env: { ...process.env, ...BD_ENV },
  });
  return (stdout || stderr).trim();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'beads_prime',
    description: 'Load Beads task state and memories. Call this at session startup.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'beads_create_task',
    description: 'Create a new Beads task. Returns the task ID (bd-XXXX).',
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
    description: 'Mark a Beads task as complete (closed).',
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
    description: 'Store a persistent memory note in Beads.',
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
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'beads_prime': {
        const output = await bd('prime');
        return ok(output);
      }

      case 'beads_create_task': {
        const { description, details } = args as { description: string; details?: string };
        const bdArgs = ['create', description, ...(details ? ['--description', details] : [])];
        const output = await bd(...bdArgs);
        const match = output.match(/bd-[a-f0-9]+/);
        const taskId = match?.[0] ?? '(unknown)';
        return ok(`task_id: ${taskId}\n${output}`);
      }

      case 'beads_add_dependency': {
        const { child_id, parent_id } = args as { child_id: string; parent_id: string };
        const output = await bd('dep', 'add', child_id, parent_id);
        return ok(output);
      }

      case 'beads_complete_task': {
        const { task_id } = args as { task_id: string };
        const output = await bd('close', task_id);
        return ok(output);
      }

      case 'beads_list_unblocked': {
        const output = await bd('ready', '--json');
        return ok(output);
      }

      case 'beads_remember': {
        const { note } = args as { note: string };
        const output = await bd('remember', note);
        return ok(output);
      }

      case 'beads_update_task': {
        const { task_id, status, claim } = args as {
          task_id: string;
          status?: string;
          claim?: boolean;
        };
        const bdArgs = [
          'update',
          task_id,
          ...(claim ? ['--claim'] : []),
          ...(status ? ['--status', status] : []),
        ];
        const output = await bd(...bdArgs);
        return ok(output);
      }

      case 'session_set_status': {
        if (!sessionId) {
          return { content: [{ type: 'text', text: 'Error: no sessionId in URL' }], isError: true };
        }
        const { status } = args as { status: string };
        const res = await fetch(`http://localhost:${SERVER_PORT}/api/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (res.ok) return ok(`status updated to ${status}`);
        const text = await res.text();
        return err(text || `HTTP ${res.status}`);
      }

      case 'session_compact': {
        if (!sessionId) {
          return { content: [{ type: 'text', text: 'Error: no sessionId in URL' }], isError: true };
        }
        const res = await fetch(
          `http://localhost:${SERVER_PORT}/api/sessions/${sessionId}/compact`,
          { method: 'POST' },
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
  let body: JsonRpcRequest;
  try {
    body = await c.req.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  const { id, method, params } = body;

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

    case 'tools/call': {
      const toolName: string = params?.name;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolArgs: Record<string, any> = params?.arguments ?? {};
      if (!toolName) {
        return jsonRpcError(id, -32602, 'Invalid params: missing name');
      }
      const sessionId = new URL(c.req.url).searchParams.get('sessionId') ?? undefined;
      const result = await callTool(toolName, toolArgs, sessionId);
      return jsonRpcOk(id, result);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
});

export default router;
