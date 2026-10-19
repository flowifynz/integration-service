// Job queue on Postgres via pg-boss (no Redis). The web service only sends jobs;
// the worker processes them. pg-boss retries failed jobs with backoff.
import PgBoss from 'pg-boss';
import { config } from "./config.js";
export const Queues = {
    /** Send one SMS through TNZ (see sms/outbound.ts). */
    SEND_SMS: 'send-sms',
    /** Process one stored Jobber webhook event (see worker.ts). */
    JOBBER_EVENT: 'jobber-event',
    /** Nightly: text every client's customers about tomorrow's visits. */
    DAY_BEFORE_REMINDERS: 'day-before-reminders',
};
let boss;
export async function getBoss() {
    if (boss)
        return boss;
    const instance = new PgBoss({ connectionString: config.databaseUrl });
    instance.on('error', (err) => console.error('pg-boss error', err));
    await instance.start();
    // pg-boss v10 requires queues to exist before send/work.
    for (const name of Object.values(Queues)) {
        if (!(await instance.getQueue(name))) {
            // pg-boss v10's Queue type requires `name` inside the options too.
            await instance.createQueue(name, {
                name,
                retryLimit: 5,
                retryDelay: 30, // seconds; doubles each attempt with retryBackoff
                retryBackoff: true,
                expireInSeconds: 120,
            });
        }
    }
    boss = instance;
    return boss;
}
export async function stopBoss() {
    await boss?.stop({ graceful: true });
    boss = undefined;
}
//# sourceMappingURL=queue.js.map