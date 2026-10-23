// Posts a message to a Google Chat space through an incoming webhook.
// https://developers.google.com/workspace/chat/quickstart/webhooks
//
// The webhook URL carries its own key and token, so no other credentials are needed.
// threadKey groups related alerts (e.g. everything about one client's Jobber connection)
// into one thread; a new key starts a new thread.

export class GoogleChatError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Google Chat post failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function googleChatPostUrl(webhookUrl: string, threadKey: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set('threadKey', threadKey);
  url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  return url.toString();
}

export async function postToGoogleChat(webhookUrl: string, text: string, threadKey: string): Promise<{ name: string | null }> {
  let res: Response;
  try {
    res = await fetch(googleChatPostUrl(webhookUrl, threadKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new GoogleChatError(0, `Network error: ${(err as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new GoogleChatError(res.status, body);
  try {
    return { name: (JSON.parse(body) as { name?: string }).name ?? null };
  } catch {
    return { name: null };
  }
}
