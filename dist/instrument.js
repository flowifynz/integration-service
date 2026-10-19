// Sentry setup. Import this first in every entry point (server, worker, cron).
// No-op if SENTRY_DSN isn't set (local dev).
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV ?? 'development',
        tracesSampleRate: 0, // errors only; turn on tracing later if latency needs investigating
        sendDefaultPii: false, // callers' phone numbers and names stay out of Sentry
    });
}
export { Sentry };
//# sourceMappingURL=instrument.js.map