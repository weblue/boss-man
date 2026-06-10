import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { timingSafeEqual } from 'node:crypto';
import { BOSS_MAN_ALLOWED_ORIGIN, LITELLM_MASTER_KEY, SERVER_PORT } from './config.js';
import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import tasksRouter from './routes/tasks.js';
import specsRouter from './routes/specs.js';
import sessionsRouter from './routes/sessions.js';
import modelsRouter from './routes/models.js';
import mcpRouter from './routes/mcp.js';
import { markInterruptedRuns } from './db.js';

if (!LITELLM_MASTER_KEY) {
  console.error('[startup] LITELLM_MASTER_KEY is not set. Add it to .env and restart.');
  process.exit(1);
}

const app = new Hono();

markInterruptedRuns();

// Localhost always allowed; BOSS_MAN_ALLOWED_ORIGIN adds one external origin for reverse proxies.
const LOCALHOST_ORIGIN = /^https?:\/\/localhost(:\d+)?$/;
app.use('*', cors({
  origin: (origin) => {
    const o = origin ?? '';
    if (LOCALHOST_ORIGIN.test(o)) return o;
    if (BOSS_MAN_ALLOWED_ORIGIN && o === BOSS_MAN_ALLOWED_ORIGIN) return o;
    return null;
  },
}));
app.use('*', logger());

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

// Constant-time key compare — avoids leaking length/prefix via timing.
function keyMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(LITELLM_MASTER_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// /api/* and /mcp require LITELLM_MASTER_KEY via `Authorization: Bearer <key>`
// or `?apiKey=<key>` (EventSource can't set headers). Loopback exempt (curl,
// scripts). Agent containers reach /mcp via host.docker.internal (non-loopback)
// and carry the key in the MCP URL. /health stays public.
const authGate: MiddlewareHandler = async (c, next) => {
  const remoteAddr = getConnInfo(c).remote.address ?? '';
  const isLoopback =
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr.startsWith('::ffff:127.');
  if (isLoopback) return next();

  const auth = c.req.header('Authorization') ?? '';
  const headerKey = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryKey = c.req.query('apiKey') ?? '';
  if (!keyMatches(headerKey) && !keyMatches(queryKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
};

app.use('/api/*', authGate);
app.use('/mcp', authGate);

app.route('/', projectsRouter);
app.route('/', runsRouter);
app.route('/', tasksRouter);
app.route('/', specsRouter);
app.route('/', sessionsRouter);
app.route('/', modelsRouter);
app.route('/', mcpRouter);

serve({ fetch: app.fetch, port: SERVER_PORT }, () => {
  console.log(`boss-man server listening on http://localhost:${SERVER_PORT}`);
});
