// Post-call processing (backlog D3): read ElevenLabs' post_call_transcription payload and
// decide what to do. Pure functions — unit tested. The worker (calls/processCall.ts) acts.
//
// The payload is read defensively: ElevenLabs documents data.metadata.start_time_unix_secs,
// call_duration_secs, termination_reason and data.analysis.*, but not where the phone numbers
// live, so those are taken from metadata.phone_call (Twilio calls) or the system__ dynamic
// variables, whichever is present.

import { normaliseUrgency, type Urgency } from '../jobber/callerText.ts';

export interface RequestToolCall {
  /** The agent called create_request at least once. */
  called: boolean;
  /** Arguments of the last create_request call. */
  args: { name?: string; phone?: string; address?: string; description?: string; urgency?: string } | null;
  /** Our response said the request was saved in Jobber (logged: true). null = unknown. */
  logged: boolean | null;
}

export interface PostCallInfo {
  type: string | null;
  conversationId: string | null;
  agentId: string | null;
  callerNumber: string | null;
  calledNumber: string | null;
  startedAt: Date | null;
  durationSecs: number | null;
  terminationReason: string | null;
  callSuccessful: string | null;
  summary: string | null;
  /** analysis.data_collection_results flattened to { field: value }. */
  collected: Record<string, string | number | boolean | null>;
  requestTool: RequestToolCall;
  /** The caller said something (any non-empty user turn). */
  userSpoke: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

function parseJson(v: unknown): Obj | null {
  if (v && typeof v === 'object') return v as Obj;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? (parsed as Obj) : null;
  } catch {
    return null;
  }
}

export function extractPostCall(payload: unknown): PostCallInfo {
  const root = obj(payload);
  const data = obj(root.data);
  const meta = obj(data.metadata);
  const phone = obj(meta.phone_call);
  const vars = obj(obj(data.conversation_initiation_client_data).dynamic_variables);
  const analysis = obj(data.analysis);

  const collected: PostCallInfo['collected'] = {};
  for (const [key, entry] of Object.entries(obj(analysis.data_collection_results))) {
    const value = obj(entry).value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') collected[key] = value;
    else if (value === null) collected[key] = null;
  }

  // create_request calls and our responses, from the transcript.
  const requestTool: RequestToolCall = { called: false, args: null, logged: null };
  let userSpoke = false;
  for (const turn of Array.isArray(data.transcript) ? data.transcript : []) {
    const t = obj(turn);
    if (t.role === 'user' && text(t.message)) userSpoke = true;
    for (const call of Array.isArray(t.tool_calls) ? t.tool_calls : []) {
      const c = obj(call);
      if (c.tool_name !== 'create_request') continue;
      requestTool.called = true;
      const args = parseJson(c.params_as_json) ?? obj(c.params);
      requestTool.args = {
        name: text(args.name) ?? undefined,
        phone: text(args.phone) ?? undefined,
        address: text(args.address) ?? undefined,
        description: text(args.description) ?? undefined,
        urgency: text(args.urgency) ?? undefined,
      };
    }
    for (const result of Array.isArray(t.tool_results) ? t.tool_results : []) {
      const r = obj(result);
      if (r.tool_name !== 'create_request') continue;
      const value = parseJson(r.result_value);
      if (value && typeof value.logged === 'boolean') requestTool.logged = value.logged;
    }
  }

  const start = num(meta.start_time_unix_secs);
  return {
    type: text(root.type),
    conversationId: text(data.conversation_id),
    agentId: text(data.agent_id),
    callerNumber: text(phone.external_number) ?? text(vars.system__caller_id),
    calledNumber: text(phone.agent_number) ?? text(vars.system__called_number),
    startedAt: start ? new Date(start * 1000) : null,
    durationSecs: num(meta.call_duration_secs),
    terminationReason: text(meta.termination_reason),
    callSuccessful: text(analysis.call_successful),
    summary: text(analysis.transcript_summary),
    collected,
    requestTool,
    userSpoke,
  };
}

// ---- What the call was about, and the caller's details ------------------------------

export type CallCategory = 'new_job' | 'other' | 'no_conversation' | 'unknown';

export interface CallerDetails {
  name: string | null;
  /** Number the caller said (or 'none'), from create_request or data collection. */
  spokenPhone: string | null;
  address: string | null;
  description: string | null;
  urgency: Urgency;
}

function truthy(v: unknown): boolean {
  return v === true || (typeof v === 'string' && /^(yes|true|y|urgent|emergency)$/i.test(v.trim()));
}

/** Details from create_request's arguments first (what the agent actually logged), then data collection. */
export function callerDetails(info: PostCallInfo): CallerDetails {
  const a = info.requestTool.args ?? {};
  const c = info.collected;
  const s = (v: unknown) => text(v);
  return {
    name: a.name ?? s(c.caller_name),
    spokenPhone: a.phone ?? s(c.caller_phone),
    address: a.address ?? s(c.property_address) ?? s(c.suburb),
    description: a.description ?? s(c.job_description),
    urgency: a.urgency ? normaliseUrgency(a.urgency) : truthy(c.is_emergency) ? 'emergency' : 'soon',
  };
}

/** Seconds of a call below which, with no caller speech, we treat it as "nobody really spoke". */
export const MIN_REAL_CALL_SECS = 10;

export function callCategory(info: PostCallInfo): CallCategory {
  const declared = text(info.collected.call_category)?.toLowerCase();
  if (declared) return declared === 'new_job' ? 'new_job' : 'other';
  if (info.requestTool.called) return 'new_job';
  if (!info.userSpoke || (info.durationSecs ?? 0) < MIN_REAL_CALL_SECS) return 'no_conversation';
  // Without a call_category data collection field we can't tell a job from a sales call.
  return 'unknown';
}

// ---- The plan ---------------------------------------------------------------------------

export interface PostCallPlan {
  category: CallCategory;
  /** Core: create the Jobber request now (the tool didn't). */
  createRequest: boolean;
  /** Send the owner a summary text (Base always for a new job; Core when the tool never ran). */
  ownerText: 'new_request' | 'saved_after_call' | null;
  /** Thank-you text to the caller (T1). */
  callerText: boolean;
  /** Flag for Jaron: the call needs a human look (shown by the weekly check). */
  needsReview: string | null;
}

export function planPostCall(
  info: PostCallInfo,
  ctx: { tier: 'base' | 'core'; jobberRequestId: string | null; callerTextsOn: boolean },
): PostCallPlan {
  const category = callCategory(info);
  const d = callerDetails(info);
  const plan: PostCallPlan = { category, createRequest: false, ownerText: null, callerText: false, needsReview: null };

  if (category === 'unknown') {
    plan.needsReview = 'Could not tell what the call was about (no call_category and create_request not used)';
    return plan;
  }
  if (category !== 'new_job') return plan;

  const enough = Boolean(d.name && (d.description || info.summary));
  plan.callerText = ctx.callerTextsOn;

  if (ctx.tier === 'base') {
    // Base has no mid-call tool: the owner hears about every new job from here.
    plan.ownerText = 'new_request';
    return plan;
  }

  // Core
  // Logged during the call (owner already texted). Also trust the tool's own "logged: true"
  // in case the call row never got the request ID, so we never create a duplicate.
  if (ctx.jobberRequestId || info.requestTool.logged === true) return plan;
  if (!enough) {
    plan.needsReview = 'New job but no name or job details to log';
    if (!info.requestTool.called) plan.ownerText = 'new_request';
    return plan;
  }
  plan.createRequest = true;
  // Tool ran (owner got "NOT saved in Jobber") → short follow-up once saved.
  // Tool never ran → owner hasn't heard anything yet.
  plan.ownerText = info.requestTool.called ? 'saved_after_call' : 'new_request';
  return plan;
}

/** T1: the caller's thank-you text (composeSms adds "Questions? Call us on ..." and the signature). */
export function callerConfirmationText(ownerName: string | null): string {
  return `Thanks for calling. We've passed your details to ${ownerName?.trim() || 'the team'} and they'll be in touch soon.`;
}
