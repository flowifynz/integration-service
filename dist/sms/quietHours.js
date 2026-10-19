// Quiet hours: no texts to customers between 8pm and 8am NZ time.
// Pure functions, no dependencies — unit tested.
export const QUIET_START_HOUR = 20; // 8pm
export const QUIET_END_HOUR = 8; // 8am
function localHourMinute(now, timeZone) {
    const parts = new Intl.DateTimeFormat('en-NZ', {
        timeZone,
        hour: 'numeric',
        minute: 'numeric',
        hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return { hour: get('hour'), minute: get('minute') };
}
/**
 * Returns null if a text can go now, otherwise the time to try again.
 *
 * The retry time is "now + minutes until 8am local", plus one minute of slack. On the
 * two nights a year that NZ daylight saving changes this can be an hour off; that's fine,
 * because the worker re-checks when the job runs and simply defers again if it's early.
 */
export function quietHoursDeferral(now = new Date(), timeZone = 'Pacific/Auckland') {
    const { hour, minute } = localHourMinute(now, timeZone);
    if (hour >= QUIET_END_HOUR && hour < QUIET_START_HOUR)
        return null;
    const minutesNow = hour * 60 + minute;
    const minutesUntilEnd = hour >= QUIET_START_HOUR
        ? 24 * 60 - minutesNow + QUIET_END_HOUR * 60 // evening: through midnight to 8am
        : QUIET_END_HOUR * 60 - minutesNow; // early morning: until 8am
    return new Date(now.getTime() + (minutesUntilEnd + 1) * 60_000);
}
//# sourceMappingURL=quietHours.js.map