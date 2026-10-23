// Alerts to Jaron (backlog D4).
//
// Channels, each used when configured:
//  - Google Chat: a post in the support alerts space (GOOGLE_CHAT_WEBHOOK_URL). Main channel.
//  - Text: to ALERT_MOBILE through TNZ. Optional backup.
//  - Sentry: always, as an event (Sentry's alert rules can email too).
//
// raiseAlert() is safe to call from anywhere (web or worker): it records the alert,
// de-duplicated by key, and queues the sending. It never throws — an alert failing must
// not break the request or job that noticed the problem.

import { config } from '../config.ts';
import { db, getClientById } from '../db.ts';
import { Sentry } from '../instrument.ts';
import { toE164 } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import { makeConnectLink } from '../routes/jobberOAuth.ts';
import { sendTnzSms, TnzError } from '../sms/tnz.ts';
import { GoogleChatError, postToGoogleChat } from './googleChat.ts';
import { type AlertKind, alertChatText, alertText, alertThreadKey, alertTnzMessageId, dailyAlertKey } from './text.ts';

/** TNZ SubAccount for alert texts, so they never show on a client's SMS bill. */
export const ALERT_SUBACCOUNT = 'flowify';
const ALERT_DEPARTMENT = 'flowify-alerts';

export interface RaiseAlertInput {
  kind: AlertKind;
  clientId?: string | null;
  /** Count or short error shown in the alert. */
  detail?: string | number | null;
  /** Default: one per kind per client per NZ day. */
  dedupeKey?: string;
}

/** Records and queues an alert. Returns true if it's new, false if already raised (or on error). */
export async function raiseAlert(input: RaiseAlertInput): Promise<boolean> {
  const clientId = input.clientId ?? null;
  try {
    const client = clientId ? await getClientById(clientId) : null;
    // A cancelled client removing the app is expected, not a problem.
    if (client?.status === 'cancelled' && input.kind.startsWith('jobber_')) return false;
    const detail = input.detail == null ? null : String(input.detail);
    const body = alertText(input.kind, { businessName: client?.business_name, slug: client?.slug, detail });
    const dedupeKey = input.dedupeKey ?? dailyAlertKey(input.kind, clientId);

    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO admin_alerts (client_id, kind, dedupe_key, body, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [clientId, input.kind, dedupeKey, body, detail],
    );
    const alertId = rows[0]?.id;
    if (!alertId) return false;

    console.warn(`[alert ${input.kind}] ${body}`);
    Sentry.withScope((scope) => {
      scope.setTag('alert_kind', input.kind);
      if (client) scope.setTag('client', client.slug);
      // One Sentry issue per kind + client, so "new issue" rules notify once per problem.
      scope.setFingerprint(['admin-alert', input.kind, client?.slug ?? 'all']);
      Sentry.captureMessage(body, input.kind === 'jobber_reconnected' || input.kind === 'test' ? 'info' : 'warning');
    });

    try {
      await (await getBoss()).send(Queues.SEND_ADMIN_ALERT, { alertId });
    } catch (err) {
      // The hourly health check re-queues alerts left in 'queued'.
      console.error('Could not queue alert', err);
    }
    return true;
  } catch (err) {
    console.error(`raiseAlert(${input.kind}) failed`, err);
    Sentry.captureException(err);
    return false;
  }
}

export type SendAlertResult = 'sent' | 'skipped' | 'already_done' | 'failed_permanent';

interface AlertRow {
  id: string;
  kind: AlertKind;
  client_id: string | null;
  body: string;
  detail: string | null;
  attempts: number;
  chat_sent_at: Date | null;
  tnz_message_id: string | null;
}

/**
 * Worker: deliver one admin_alerts row to every configured channel. A channel that already
 * succeeded is skipped on retry. Throws on retryable failures (pg-boss retries).
 */
export async function sendAdminAlert(alertId: string): Promise<SendAlertResult> {
  const claimed = await db().query<AlertRow>(
    `UPDATE admin_alerts SET status = 'sending', attempts = attempts + 1
      WHERE id = $1 AND status IN ('queued', 'failed')
      RETURNING id, kind, client_id, body, detail, attempts, chat_sent_at, tnz_message_id`,
    [alertId],
  );
  const alert = claimed.rows[0];
  if (!alert) return 'already_done';

  const chatUrl = config.alerts.googleChatWebhookUrl;
  const mobile = toE164(config.alerts.mobile);
  if (!chatUrl && !mobile) {
    await db().query(`UPDATE admin_alerts SET status = 'skipped', error = $2 WHERE id = $1`, [
      alert.id,
      'No alert channel set (GOOGLE_CHAT_WEBHOOK_URL or ALERT_MOBILE)',
    ]);
    return 'skipped';
  }

  const errors: Error[] = [];

  // 1. Google Chat
  if (chatUrl && !alert.chat_sent_at) {
    try {
      const client = alert.client_id ? await getClientById(alert.client_id) : null;
      const wantsLink = alert.kind === 'jobber_needs_reconnect' || alert.kind === 'jobber_disconnected';
      const text = alertChatText(alert.kind, {
        businessName: client?.business_name,
        slug: client?.slug,
        detail: alert.detail,
        connectLink: wantsLink && client ? makeConnectLink(client.id) : null,
      });
      const { name } = await postToGoogleChat(chatUrl, text, alertThreadKey(alert.kind, alert.client_id));
      await db().query(`UPDATE admin_alerts SET chat_sent_at = now(), chat_message_name = $2 WHERE id = $1`, [alert.id, name]);
    } catch (err) {
      errors.push(err as Error);
    }
  }

  // 2. Text (optional backup)
  if (mobile && !alert.tnz_message_id) {
    try {
      const { messageId } = await sendTnzSms({
        to: mobile,
        message: alert.body,
        subAccount: ALERT_SUBACCOUNT,
        department: ALERT_DEPARTMENT,
        messageId: alertTnzMessageId(alert.id, alert.attempts),
        reference: `alert ${alert.kind}`,
        mode: config.alerts.smsMode,
      });
      await db().query(`UPDATE admin_alerts SET tnz_message_id = $2 WHERE id = $1`, [alert.id, messageId]);
    } catch (err) {
      errors.push(err as Error);
    }
  }

  if (!errors.length) {
    await db().query(`UPDATE admin_alerts SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [alert.id]);
    return 'sent';
  }

  await db().query(`UPDATE admin_alerts SET status = 'failed', error = $2 WHERE id = $1`, [
    alert.id,
    errors.map((e) => e.message).join(' | '),
  ]);
  const retryable = errors.some((e) => (e instanceof GoogleChatError || e instanceof TnzError ? e.retryable : true));
  if (retryable) throw errors[0];
  for (const e of errors) Sentry.captureException(e);
  return 'failed_permanent';
}
