// ============================================================
// Email channel — inbound IMAP polling.
//
// Each configured email channel (one per account/mailbox) has its own
// IMAP server + credentials in `channel_configs.config` (encrypted).
// On a schedule, the poller connects to each mailbox, reads unseen
// messages, ingests them into the unified inbox, and marks them seen.
//
// Idempotency: each message carries its Message-ID (`envelope.messageId`
// / mailparser's `messageId`), which feeds the (conversation_id,
// message_id) unique index — a message already ingested on a prior run
// (or a retry) is simply skipped.
// ============================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { ingestInboundMessage } from './ingest';
import { markChannelError, markChannelConnected, type ManagedChannel } from './channel-config';

interface RawConfigRow {
  account_id: string;
  config?: string | null;
}

/** Normalise a sender email to a stable lowercased address. */
function normalizeEmail(address?: string | null): string {
  if (!address) throw new Error('missing sender email');
  return address.trim().toLowerCase();
}

/**
 * Poll one configured email mailbox and ingest any new messages.
 * Returns the number of messages ingested. Never throws — returns 0 and
 * records the error on the channel config for visibility on failure.
 */
export async function pollEmailMailbox(row: RawConfigRow): Promise<number> {
  const accountId = row.account_id;
  const channel: ManagedChannel = 'email';
  if (!row.config) return 0;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(decrypt(row.config as string));
  } catch {
    return 0;
  }

  const host = (config.imapHost as string) ?? '';
  const user = (config.imapUser as string) ?? '';
  const pass = (config.imapPass as string) ?? '';
  if (!host || !user || !pass) {
    await markChannelError(supabaseAdmin(), accountId, channel, 'IMAP not fully configured');
    return 0;
  }

  const client = new ImapFlow({
    host,
    port: Number(config.imapPort ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let ingested = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const searched = await client.search({ seen: false });
      const unseenUids = searched === false ? [] : searched;
      if (unseenUids.length === 0) {
        // Nothing unseen — still mark connected (reachable mailbox).
        await markChannelConnected(supabaseAdmin(), accountId, channel);
        return 0;
      }

      for await (const message of client.fetch(unseenUids, { source: true }, { uid: true })) {
        try {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          const raw = parsed.text ?? parsed.textAsHtml ?? '';
          const text = cleanEmailText(raw);
          if (!text) continue;

          let senderEmail: string;
          try {
            senderEmail = normalizeEmail(parsed.from?.value?.[0]?.address);
          } catch {
            continue; // no sender — skip
          }

          // Skip mail we sent to ourselves (a copy of our own outbound
          // can loop back via IMAP and would have no external sender).
          if (normalizeEmail(user) === senderEmail) continue;

          const messageId =
            parsed.messageId || `poll-${accountId}-${message.uid}`;

          const result = await ingestInboundMessage(supabaseAdmin(), accountId, {
            channel,
            externalId: senderEmail,
            name: parsed.from?.value?.[0]?.name || null,
            messageId,
            contentText: text,
            contentType: 'text',
            timestamp: parsed.date ? parsed.date.toISOString() : undefined,
          });
          if (result.inserted) ingested += 1;

          // Mark the message as read (Seen) so the next poll skips it.
          // Best-effort — failure just means a possible re-fetch, which
          // the dedupe handles.
          await client.messageFlagsSet([message.uid], ['\\Seen'], { uid: true });
        } catch (e) {
          console.error('[email-poll] message parse/ingest error:', e);
        }
      }
      await markChannelConnected(supabaseAdmin(), accountId, channel);
    } finally {
      lock.release();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'IMAP poll failed';
    console.error('[email-poll] mailbox poll failed:', message);
    await markChannelError(supabaseAdmin(), accountId, channel, message);
  } finally {
    await client.logout().catch(() => undefined);
  }

  return ingested;
}

/** Crude but effective: collapse whitespace to keep stored text tidy. */
function cleanEmailText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}
