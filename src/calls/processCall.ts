// Worker: act on one finished call (backlog D3). Queued by the post-call webhook.
//
//  - Fills in the call record (who, how long, what about) — D6 minutes and D7's weekly check read it.
//  - Core safety net: a new-job call with no Jobber request gets one created now.
//  - Base: the owner gets the summary text (Base has no mid-call tool).
//  - Caller gets the thank-you text (T1), to a mobile only, respecting quiet hours.
// Safe to run twice: texts are de-duplicated per conversation, and a 'done' call is skipped.

import { automationSettings } from '../automation/settings.ts';
import { type ClientRow, db, getClientById } from '../db.ts';
import { Sentry } from '../instrument.ts';
import { ownerAlertText, type PhoneSource } from '../jobber/callerText.ts';
import { formatNational, isMobile, toE164 } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import type { SendSmsJob } from '../sms/outbound.ts';
import { logJobberRequest, resolveClient } from './logRequest.ts';
import { callerConfirmationText, callerDetails, extractPostCall, planPostCall } from './postCall.ts';

interface CallRow {
  id: string;
  conversation_id: string;
  client_id: string | null;
  jobber_request_id: string | null;
  request_source: string | null;
  outcome: string | null;
  processing_status: string;
  payload: unknown;
}

async function queueSms(job: SendSmsJob) {
  await (await getBoss()).send(Queues.SEND_SMS, job);
}

export async function processCall(conversationId: string): Promise<string> {
  const row = (await db().query<CallRow>('SELECT * FROM calls WHERE conversation_id = $1', [conversationId])).rows[0];
  if (!row) return 'no such call';
  if (row.processing_status === 'done') return 'already done';
  if (!row.payload) return 'no payload yet';

  const info = extractPostCall(row.payload);
  const client: ClientRow | null = row.client_id
    ? await getClientById(row.client_id)
    : await resolveClient({ called_number: info.calledNumber, agent_id: info.agentId });
  if (!client) {
    await db().query(`UPDATE calls SET processing_status = 'no_client', processed_at = now() WHERE id = $1`, [row.id]);
    return `no client for ${info.calledNumber ?? info.agentId ?? 'unknown number'}`;
  }

  const settings = automationSettings(client.automation);
  const plan = planPostCall(info, { tier: client.tier, jobberRequestId: row.jobber_request_id, callerTextsOn: settings.callerConfirmations });
  const d = callerDetails(info);

  const callerId = toE164(info.callerNumber);
  const spoken = d.spokenPhone && d.spokenPhone.toLowerCase() !== 'none' ? toE164(d.spokenPhone) : null;
  const callbackPhone = spoken ?? callerId;
  const callbackDisplay = callbackPhone ? formatNational(callbackPhone) : null;
  const phoneSource: PhoneSource = spoken ? (callerId ? 'spoken' : 'spoken_no_caller_id') : callerId ? 'caller_id' : 'none';
  const name = d.name ?? 'Unknown caller';
  const description = d.description ?? info.summary ?? 'No job details captured - check the call in ElevenLabs.';

  let requestId = row.jobber_request_id;
  let requestSource = row.request_source;
  let needsReview = plan.needsReview;
  const did: string[] = [plan.category];

  // 1. Core safety net: create the Jobber request the tool didn't.
  if (plan.createRequest) {
    try {
      requestId = await logJobberRequest(client, {
        name,
        matchPhone: callerId ?? spoken,
        callbackDisplay,
        phoneSource,
        address: d.address,
        description,
        urgency: d.urgency,
        afterCall: true,
        lookupTimeoutMs: 15_000,
      });
      requestSource = 'after_call';
      did.push('request created after call');
    } catch (err) {
      // Don't retry the whole job: the owner still gets every detail by text below.
      needsReview = `Jobber request could not be created after the call: ${(err as Error).message.slice(0, 200)}`;
      did.push('after-call request FAILED');
      Sentry.captureException(err);
    }
  }

  // 2. Owner text.
  if (plan.ownerText && client.owner_mobile) {
    const text =
      plan.ownerText === 'saved_after_call'
        ? requestId
          ? `Now saved in Jobber: request from ${name}${callbackDisplay ? ` (${callbackDisplay})` : ''}, logged after the call.`
          : null // creation failed again; the owner already has "NOT saved in Jobber" from the call
        : ownerAlertText({
            callerName: name,
            callbackPhone: callbackDisplay,
            phoneSource,
            address: d.address,
            description,
            urgency: d.urgency,
            loggedInJobber: client.tier === 'base' ? null : Boolean(requestId),
          });
    if (text) {
      await queueSms({
        clientId: client.id,
        kind: 'owner_alert',
        toPhone: client.owner_mobile,
        text,
        idempotencyKey: `${client.id}:${conversationId}:owner_alert_after_call`,
      });
      did.push('owner texted');
    }
  }

  // 3. Thank-you text to the caller (T1): mobiles only.
  const callerMobile = [callbackPhone, callerId].find((p): p is string => Boolean(p && isMobile(p)));
  if (plan.callerText && callerMobile) {
    await queueSms({
      clientId: client.id,
      kind: 'call_confirmation',
      toPhone: callerMobile,
      text: callerConfirmationText(client.owner_name),
      idempotencyKey: `${client.id}:${conversationId}:call_confirmation`,
    });
    did.push('caller texted');
  }

  // 4. Record everything.
  const outcome =
    row.outcome ??
    (plan.category === 'new_job' ? (requestId ? 'request_logged' : client.tier === 'base' ? 'details_taken' : 'request_failed') : plan.category);
  await db().query(
    `UPDATE calls SET
        client_id = $2, caller_phone = COALESCE(caller_phone, $3), caller_name = $4, callback_phone = $5,
        category = $6, jobber_request_id = $7, request_source = $8, needs_review = $9, outcome = $10,
        details = $11, processing_status = 'done', processed_at = now(), processing_error = NULL
      WHERE id = $1`,
    [
      row.id,
      client.id,
      callerId,
      d.name,
      spoken && spoken !== callerId ? spoken : null,
      plan.category,
      requestId,
      requestSource,
      needsReview,
      outcome,
      JSON.stringify({ collected: info.collected, create_request: info.requestTool.args, create_request_logged: info.requestTool.logged }),
    ],
  );
  if (needsReview) did.push(`needs review: ${needsReview}`);
  return did.join(', ');
}
