import { Hono } from 'hono';
import { LITELLM_HOST, LITELLM_PORT, LITELLM_MASTER_KEY } from '../config.js';

const router = new Hono();

// GET /api/models — proxy LiteLLM model list for the UI model selector
router.get('/api/models', async (c) => {
  try {
    const res = await fetch(`http://${LITELLM_HOST}:${LITELLM_PORT}/v1/models`, {
      headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    });
    if (!res.ok) return c.json({ models: [] });
    const data = await res.json() as { data?: { id: string }[] };
    const models = (data.data ?? []).map((m) => m.id).sort();
    return c.json({ models });
  } catch {
    return c.json({ models: [] });
  }
});

export default router;
