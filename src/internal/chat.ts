// Google Chat posts for Flowify's own business (INTERNAL_CHAT_WEBHOOK_URL), e.g. "new
// discovery call booked". A different space from the client support alerts.
//
// Jobs carry only a booking ID; the text is built from the database at send time, so no
// names or numbers sit in the job queue.

import { postToGoogleChat, GoogleChatError } from '../alerts/googleChat.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { formatNational } from '../phone.ts';
import { getBoss, Queues } from '../queue.ts';
import { type BookingForChat, type InternalChatKind, bookingChatText } from './discoveryCall.ts';

export type { InternalChatKind };

export interface InternalChatJob {
  kind: InternalChatKind;
  bookingId: string;
  /** Short reason, for failures. No personal details. */
  detail?: string;
}
export async function queueInternalChat(job: InternalChatJob): Promise<void> {
  if (!config.internal.chatWebhookUrl) return; // optional channel
  await (await getBoss()).send(Queues.INTERNAL_CHAT, job);
}

/** Worker: post one notice. Throws on retryable failures. */
export async function sendInternalChat(job: InternalChatJob): Promise<'sent' | 'skipped'> {
  const url = config.internal.chatWebhookUrl;
  if (!url) return 'skipped';
  const { rows } = await db().query<BookingForChat & { phone: string | null }>(
    `SELECT caller_name, business_name, phone, email, summary, slot_start, error FROM internal.bookings WHERE id = $1`,
    [job.bookingId],
  );
  const row = rows[0];
  if (!row) return 'skipped';
  const booking: BookingForChat = { ...row, phone: row.phone?.startsWith('+') ? formatNational(row.phone) : row.phone };
  try {
    // One thread per booking, so a later "text not sent" lands under the booking.
    await postToGoogleChat(url, bookingChatText(job.kind, booking, job.detail), `website-booking-${job.bookingId}`);
    return 'sent';
  } catch (err) {
    if (err instanceof GoogleChatError && !err.retryable) {
      console.error(`[internal chat] permanent failure: ${err.message}`);
      return 'skipped';
    }
    throw err;
  }
}
