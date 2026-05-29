import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { SERVER_PORT } from './config.js';
import projectsRouter from './routes/projects.js';
import runsRouter from './routes/runs.js';
import beadsRouter from './routes/beads.js';
import specsRouter from './routes/specs.js';
import sessionsRouter from './routes/sessions.js';
import { markInterruptedRuns } from './db.js';

const app = new Hono();

markInterruptedRuns();

app.use('*', cors({ origin: '*' }));
app.use('*', logger());

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/', projectsRouter);
app.route('/', runsRouter);
app.route('/', beadsRouter);
app.route('/', specsRouter);
app.route('/', sessionsRouter);

serve({ fetch: app.fetch, port: SERVER_PORT }, () => {
  console.log(`boss-man server listening on http://localhost:${SERVER_PORT}`);
});
