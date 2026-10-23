// Alert wording and timing helpers. Pure functions, no dependencies — unit tested.
//
// Alerts go to Google Chat (alertChatText) and, optionally, by text (alertText).
// The text version deliberately has no links: TNZ holds texts with links for a manual URL
// check, which could delay an alert by hours. It gives the Render Shell command instead.

export type AlertKind =
  | 'jobber_needs_reconnect' // refresh token rejected; client must reconnect
  | 'jobber_disconnected' // client removed the Flowify app in Jobber (APP_DISCONNECT)
  | 'jobber_reconnected' // good news: a broken connection is working again
  | 'jobber_connect_failed' // connect link used but the callback failed
  | 'sms_failures' // several texts for one client failed in 24h
  | 'stuck_webhooks' // Jobber events not processed for over an hour
  | 'queue_backlog' // worker jobs waiting too long
  | 'calls_failed' // post-call processing failed for some calls
  | 'test'; // npm run alerts:test

export interface AlertContext {
  businessName?: string | null;
  slug?: string | null;
  /** Kind-specific detail: a count or a short error. */
  detail?: string | number | null;
}

/** Plain GSM-7 text: strips macrons/accents, swaps curly quotes and dashes, drops anything else. */
export function toGsmSafe(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining accents (ā → a)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function connectCommand(slug: string | null | undefined): string {
  return `node dist/scripts/connectLink.js ${slug ?? '<slug>'}`;
}

export function alertText(kind: AlertKind, ctx: AlertContext = {}): string {
  const who = ctx.businessName ?? ctx.slug ?? 'Unknown client';
  const detail = ctx.detail ?? '';
  let text: string;
  switch (kind) {
    case 'jobber_needs_reconnect':
      text = `FLOWIFY ALERT: ${who} - Jobber connection expired. Calls can't log requests and Jobber texts have stopped. Send a new connect link: ${connectCommand(ctx.slug)}`;
      break;
    case 'jobber_disconnected':
      text = `FLOWIFY ALERT: ${who} removed the Flowify app in Jobber. Calls can't log requests and Jobber texts have stopped. If it was a mistake, send a new link: ${connectCommand(ctx.slug)}`;
      break;
    case 'jobber_reconnected':
      text = `FLOWIFY: ${who} - Jobber reconnected. Requests and texts are running again.`;
      break;
    case 'jobber_connect_failed':
      text = `FLOWIFY ALERT: ${who} tried to connect Jobber and it failed${detail ? ` (${detail})` : ''}. Check flowify-web logs.`;
      break;
    case 'sms_failures':
      text = `FLOWIFY ALERT: ${who} - ${detail} texts failed in the last 24h. Check the messages table and TNZ.`;
      break;
    case 'stuck_webhooks':
      text = `FLOWIFY ALERT: ${detail} Jobber events waiting over an hour. Re-queued them; check flowify-worker is running.`;
      break;
    case 'queue_backlog':
      text = `FLOWIFY ALERT: ${detail} worker jobs waiting over 30 min. Check flowify-worker is running.`;
      break;
    case 'calls_failed':
      text = `FLOWIFY ALERT: ${who} - ${detail} call(s) could not be processed after the call. Check calls.processing_error.`;
      break;
    case 'test':
      text = `FLOWIFY: test alert${detail ? ` - ${detail}` : ''}. Alerts reach this phone.`;
      break;
  }
  return toGsmSafe(text);
}

/**
 * Google Chat version of an alert. Chat has no character or link limits, so reconnect
 * alerts carry a fresh connect link to forward to the client.
 * Chat formatting: *bold*, `code`, <url|label>.
 */
export function alertChatText(kind: AlertKind, ctx: AlertContext & { connectLink?: string | null } = {}): string {
  const who = ctx.businessName ?? ctx.slug ?? 'Unknown client';
  const detail = ctx.detail ?? '';
  const linkLine = ctx.connectLink
    ? `Send the client this connect link (valid 7 days): <${ctx.connectLink}|Connect Jobber to Flowify>`
    : `Get a connect link in Render Shell: \`${connectCommand(ctx.slug)}\``;
  switch (kind) {
    case 'jobber_needs_reconnect':
      return `🔴 *${who}: Jobber connection expired*\nCalls can't log requests and Jobber texts have stopped until they reconnect.\n${linkLine}`;
    case 'jobber_disconnected':
      return `🔴 *${who} removed the Flowify app in Jobber*\nCalls can't log requests and Jobber texts have stopped. If it was a mistake:\n${linkLine}`;
    case 'jobber_reconnected':
      return `✅ *${who}: Jobber reconnected*\nRequests and texts are running again.`;
    case 'jobber_connect_failed':
      return `🟠 *${who}: Jobber connect failed*${detail ? `\n${detail}` : ''}\nCheck the flowify-web logs.`;
    case 'sms_failures':
      return `🟠 *${who}: ${detail} texts failed in the last 24h*\nCheck the messages table (\`status\`, \`error\`, \`delivery_result\`) and TNZ.`;
    case 'stuck_webhooks':
      return `🟠 *${detail} Jobber events waiting over an hour*\nThe health check re-queued them. Check flowify-worker is running.`;
    case 'queue_backlog':
      return `🟠 *${detail} worker jobs waiting over 30 minutes*\nCheck flowify-worker is running.`;
    case 'calls_failed':
      return `🟠 *${who}: ${detail} call(s) not processed after the call*\nNo thank-you text or after-call Jobber request for these. Check \`calls.processing_error\` and the flowify-worker logs.`;
    case 'test':
      return `✅ *Test alert*${detail ? ` (${detail})` : ''}\nFlowify alerts reach this space.`;
  }
}

/**
 * Chat thread for an alert. Everything about one client's Jobber connection (expired,
 * removed, failed, reconnected) shares a thread, so the fix shows under the problem.
 */
export function alertThreadKey(kind: AlertKind, clientId: string | null): string {
  if (kind.startsWith('jobber_')) return `jobber-${clientId ?? 'all'}`;
  return `${kind}-${clientId ?? 'all'}`;
}

/** Today's date in NZ as YYYY-MM-DD. */
export function nzDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(now);
}

/** At most one alert of this kind for this client per NZ day. */
export function dailyAlertKey(kind: AlertKind, clientId: string | null, now = new Date()): string {
  return `${kind}:${clientId ?? 'all'}:${nzDate(now)}`;
}

/** Hours when the hourly health check may text Jaron (7am to 9pm NZ). Event alerts ignore this. */
export const ALERT_DAY_START_HOUR = 7;
export const ALERT_DAY_END_HOUR = 21;

export function isAlertDaytime(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', hourCycle: 'h23' }).format(now),
  );
  return hour >= ALERT_DAY_START_HOUR && hour < ALERT_DAY_END_HOUR;
}

/** TNZ MessageID for an alert row. Different prefix from customer texts so replies/results never match a messages row. */
export function alertTnzMessageId(alertId: string | number, attempt: number): string {
  return `flowifyalert${alertId}a${attempt}`;
}
