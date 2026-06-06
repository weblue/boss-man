import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { BOSS_MAN_ALLOWED_ORIGIN, LITELLM_MASTER_KEY, SERVER_PORT } from './config.js';
import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import beadsRouter from './routes/beads.js';
import specsRouter from './routes/specs.js';
import sessionsRouter from './routes/sessions.js';
import modelsRouter from './routes/models.js';
import mcpRouter from './routes/mcp.js';
import { markInterruptedRuns } from './db.js';

const app = new Hono();

markInterruptedRuns();

// Localhost is always allowed. BOSS_MAN_ALLOWED_ORIGIN adds one external origin
// (e.g. https://mediachung.us) for reverse-proxy deployments.
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

// ── Auth gate ────────────────────────────────────────────────────────────────
// All /api/* routes require the LITELLM_MASTER_KEY.
// Two accepted forms:
//   Authorization: Bearer <key>   — standard fetch/XHR (most routes)
//   ?apiKey=<key>                  — query param for EventSource (browser
//                                    EventSource cannot set custom headers)
// Requests from the loopback interface are exempt — covers curl, scripts, and
// agent containers (via host.docker.internal → host loopback) that don't carry
// a browser session.
// /health and /mcp are already outside /api/* so they're also always exempt.
app.use('/api/*', async (c, next) => {
  // Loopback bypass — IPv4, IPv6, and IPv4-mapped IPv6 loopback addresses.
  const remoteAddr = getConnInfo(c).remote.address ?? '';
  const isLoopback =
    remoteAddr === '127.0.0.1' ||
    remoteAddr === '::1' ||
    remoteAddr.startsWith('::ffff:127.');
  if (isLoopback) return next();

  const auth = c.req.header('Authorization') ?? '';
  const headerKey = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const queryKey = c.req.query('apiKey') ?? '';
  if (headerKey !== LITELLM_MASTER_KEY && queryKey !== LITELLM_MASTER_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

app.route('/', projectsRouter);
app.route('/', runsRouter);
app.route('/', beadsRouter);
app.route('/', specsRouter);
app.route('/', sessionsRouter);
app.route('/', modelsRouter);
app.route('/', mcpRouter);

serve({ fetch: app.fetch, port: SERVER_PORT }, () => {
  console.log(`boss-man server listening on http://localhost:${SERVER_PORT}`);
});
