// ============================================================
// Unified OUTBOUND channel dispatch — replying from the inbox routes
// through here based on the conversation's channel.
//
// The agent composes a reply in the unified inbox; this module finds
// the conversation's channel and delivers through the correct transport:
//   instagram / messenger -> Meta Graph API
//   email                  -> SMTP (see email-send.ts)
//   webchat                -> a `messages` row the widget polls (no
//                             transport — the visitor reads it live)
// WhatsApp keeps its own /api/whatsapp/send path and never comes here.
//
// Every send persists the outbound row (sender_type='agent', status
// 'sent', channel = conversation.channel) and updates the conversation
// summary — the same pattern the WhatsApp send core uses.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { getChannelConnection, type ManagedChannel } from './channel-config';
import { sendMetaDirectMessage } from './meta';
import { sendEmailViaSMTP } from './email-send';
import type { Channel } from '@/types';

export interface OmnidirectionalSendInput {
  conversationId: string;
  text: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

export interface OmnidirectionalSendResult {
  messageId: string;
  providerMessageId: string | null;
}

// Conversation row with its channel + contact embedded.
interface ConvRow {
  id: string;
  channel: Channel;
  contact_id: string;
  contact?: { channel?: Channel; channel_external_id?: string | null; email?: string | null } | null;
}

/**
 * Send an outbound reply in a conversation, routing by channel.
 * Throws `SendMessageError` (same family the WhatsApp send route maps)
 * so callers get consistent error shapes.
 */
export async function sendViaChannel(
  db: SupabaseClient,
  accountId: string,
  input: OmnidirectionalSendInput,
): Promise<OmnidirectionalSendResult> {
  if (!input.text && !input.mediaUrl) {
    throw new SendMessageError('bad_request', 'content_text is required', 400);
  }

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', input.conversationId)
    .eq('account_id', accountId)
    .single();

  if (convErr || !conv) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }
  const conversation = conv as ConvRow;
  const channel = conversation.channel ?? 'whatsapp';

  if (channel === 'whatsapp') {
    throw new SendMessageError(
      'wrong_channel',
      'WhatsApp replies use the WhatsApp send path',
      400,
    );
  }

  const recipientId = conversation.contact?.channel_external_id ?? null;
  if (!recipientId) {
    throw new SendMessageError(
      'bad_request',
      `This ${channel} conversation has no remote user id`,
      400,
    );
  }

  const conn = await getChannelConnection(db, accountId, channel as ManagedChannel);
  if (!conn || !conn.isEnabled || !conn.config) {
    throw new SendMessageError(
      `${channel}_not_configured`,
      `This ${channel} channel is not configured or is disabled`,
      400,
    );
  }

  // Deliver through the transport for THIS channel.
  let providerMessageId: string | null = null;
  switch (channel) {
    case 'instagram':
    case 'messenger': {
      const accessToken =
        channel === 'instagram'
          ? (conn.config.accessToken as string)
          : (conn.config.pageAccessToken as string);
      const senderAccountId =
        channel === 'instagram'
          ? (conn.config.instagramBusinessAccountId as string)
          : (conn.config.pageId as string);
      if (!accessToken || !senderAccountId) {
        throw new SendMessageError('bad_request', 'Channel credentials incomplete', 400);
      }
      try {
        const sent = await sendMetaDirectMessage({
          accessToken,
          recipientId,
          text: input.text,
          senderAccountId,
          channel,
        });
        providerMessageId = sent.messageId;
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        throw new SendMessageError(
          'channel_send_failed',
          `${channel} send failed: ${reason}`,
          502,
        );
      }
      break;
    }
    case 'email': {
      const fromEmail =
        (conn.config.mailboxEmail as string) ?? (conn.config.imapUser as string) ?? '';
      try {
        const provider = await sendEmailViaSMTP(conn.config, {
          from: fromEmail,
          to: recipientId, // email address
          subject: (conn.config.subjectPrefix as string) || 'New message',
          text: input.text,
        });
        providerMessageId = provider.messageId;
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        throw new SendMessageError(
          'channel_send_failed',
          `email send failed: ${reason}`,
          502,
        );
      }
      break;
    }
    case 'webchat': {
      // No external transport — the visitor's widget polls the shared
      // `messages` table. providerMessageId stays null.
      break;
    }
    default:
      throw new SendMessageError('bad_request', `Unsupported channel: ${channel}`, 400);
  }

  // Persist the outbound row (unified inbox).
  const { data: msgRow, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      channel,
      sender_type: 'agent',
      content_type: input.mediaUrl ? 'image' : 'text',
      content_text: input.text ?? null,
      media_url: input.mediaUrl ?? null,
      media_type: input.mediaType ?? null,
      message_id: providerMessageId,
      status: 'sent',
    })
    .select('id')
    .single();

  if (msgErr || !msgRow) {
    console.error('[omnichannel-send] message persist error:', msgErr);
    throw new SendMessageError('db_error', 'Failed to persist message', 500);
  }

  // Update the conversation summary.
  await db
    .from('conversations')
    .update({
      last_message_text: input.text ?? `[${input.mediaUrl ? 'image' : 'message'}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  return { messageId: msgRow.id, providerMessageId };
}
