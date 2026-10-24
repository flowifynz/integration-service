// Web service entry point (Render "flowify-web").

import { Sentry } from './instrument.ts';
import Fastify from 'fastify';
import { config } from './config.ts';
import { closeDb, db } from './db.ts';
import { getBoss, stopBoss } from './queue.ts';
import { elevenLabsPostCallRoutes, elevenLabsToolRoutes } from './routes/elevenlabs.ts';
import { jobberOAuthRoutes } from './routes/jobberOAuth.ts';
import { jobberWebhookRoutes } from './routes/jobberWebhook.ts';
import { tnzInboundRoutes } from './routes/tnzInbound.ts';
import { internalToolRoutes } from './internal/routes.ts';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Never log secrets or tokens.
    redact: ['req.headers.authorization', 'req.headers["x-flowify-secret"]', 'req.query.t', 'req.query.code', 'req.query.key'],
  },
  trustProxy: true, // behind Render's load balancer
  bodyLimit: 1024 * 1024,
});

Sentry.setupFastifyErrorHandler(app);

// Render calls this every few seconds; keep it out of the logs.
app.get('/healthz', { logLevel: 'silent' }, async () => {
  await db().query('SELECT 1');
  return { ok: true };
});

await app.register(jobberOAuthRoutes);
await app.register(jobberWebhookRoutes);
await app.register(elevenLabsToolRoutes, { prefix: '/elevenlabs' });
await app.register(elevenLabsPostCallRoutes, { prefix: '/elevenlabs' });
await app.register(tnzInboundRoutes);
// Flowify's own automations (website agent). Own prefix, own secret: see src/internal/.
await app.register(internalToolRoutes, { prefix: '/internal' });

// Start pg-boss before taking traffic, so the first webhook doesn't pay the startup cost.
await getBoss();
await app.listen({ host: '0.0.0.0', port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await stopBoss();
    await closeDb();
    process.exit(0);
  });
}
