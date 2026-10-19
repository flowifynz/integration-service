// Web service entry point (Render "flowify-web").
import { Sentry } from "./instrument.js";
import Fastify from 'fastify';
import { config } from "./config.js";
import { closeDb, db } from "./db.js";
import { getBoss, stopBoss } from "./queue.js";
import { elevenLabsPostCallRoutes, elevenLabsToolRoutes } from "./routes/elevenlabs.js";
import { jobberOAuthRoutes } from "./routes/jobberOAuth.js";
import { jobberWebhookRoutes } from "./routes/jobberWebhook.js";
import { tnzInboundRoutes } from "./routes/tnzInbound.js";
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
app.get('/healthz', async () => {
    await db().query('SELECT 1');
    return { ok: true };
});
await app.register(jobberOAuthRoutes);
await app.register(jobberWebhookRoutes);
await app.register(elevenLabsToolRoutes, { prefix: '/elevenlabs' });
await app.register(elevenLabsPostCallRoutes, { prefix: '/elevenlabs' });
await app.register(tnzInboundRoutes);
// Start pg-boss before taking traffic, so the first webhook doesn't pay the startup cost.
await getBoss();
await app.listen({ host: '0.0.0.0', port: config.port });
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
        app.log.info(`${signal} received, shutting down`);
        await app.close();
        await stopBoss();
        await closeDb();
        process.exit(0);
    });
}
//# sourceMappingURL=server.js.map