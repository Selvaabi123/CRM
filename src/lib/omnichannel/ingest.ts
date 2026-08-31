// ============================================================
// Unified omnichannel inbound ingest.
//
// One pipeline for ALL non-WhatsApp channels (instagram, messenger,
// email, webchat). It mirrors the WhatsApp webhook's `processMessage`
// orchestration — resolve contact → conversation → idempotent message
// insert → unread bump → reopen → flows/automation/AI/webhook fan-out —
// but is channel-agnostic, so every channel lands in the SAME unified
// `messages` / `conversations` tables the inbox renders. No separate
// inbox systems.
//
// Idempotency: every inbound message must carry a `messageId` that is
// stable across retries (Meta message id, Message-ID header, or a
// widget-generated client id). The unique index (conversation_id,
// message_id) — migration 037, the same one WhatsApp uses — makes a
// replay a no-op and gates all downstream fan-out.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { resolveChannelThread } from './identity';
import {
  getChannelConnection,
  markChannelConnected,
  type ManagedChannel,
} from './channel-config';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import type { Channel } from '@/types';

export interface InboundMessageInput {
  channel: ManagedChannel;
  /** Provider remote user id: IGSID / PSID / email / webchat token. */
  externalId: string;
  /** Remote display name, when known. */
  name?: string | null;
  /** Stable provider message id (nullable on some channels → caller
   *  must synthesise a stable one or pass null to skip dedupe). */
  messageId: string | null;
  contentText: string | null;
  contentType?: 'text' | 'image' | 'document' | 'audio' | 'video';
  mediaUrl?: string | null;
  mediaType?: string | null;
  /** ISO timestamp of the message (defaults to now). */
  timestamp?: string;
  /** Set true to run flows/automations/AI fan-out (default true). The
   *  webchat visitor path can disable it for its own lightweight case. */
  runFanout?: boolean;
}

export interface InboundMessageResult {
  /** True when the message was newly inserted; false on a dedupe replay. */
  inserted: boolean;
  conversationId: string | null;
  contactId: string | null;
  messageId: string | null;
  contactCreated: boolean;
  conversationCreated: boolean;
}

/**
 * Ingest one inbound message from a non-WhatsApp channel into the
 * unified inbox. Never throws for provider/dupe conditions — returns a
 * result the caller maps to "ack the webhook". Throws only on a hard
 * DB failure that the caller should NOT acknowledge and retry.
 */
export async function ingestInboundMessage(
  db: SupabaseClient,
  accountId: string,
  input: InboundMessageInput,
): Promise<InboundMessageResult> {
  const admin = supabaseAdmin();

  // Resolve the channel-scoped contact + conversation.
  const thread = await resolveChannelThread(db, accountId, {
    channel: input.channel,
    externalId: input.externalId,
    name: input.name ?? null,
    email: input.channel === 'email' ? input.externalId : null,
  });

  if (thread.conversationCreated) {
    await dispatchWebhookEvent(admin, accountId, 'conversation.created', {
      conversation_id: thread.conversation.id,
      contact_id: thread.contact.id,
      channel: input.channel,
    });
  }

  // Idempotent insert. Replays deliver the same messageId → conflict →
  // DO NOTHING → zero rows → treat as acknowledged no-op.
  const contentType = input.contentType ?? 'text';
  const { data: insertedRows, error: msgError } = await admin
    .from('messages')
    .upsert(
      {
        conversation_id: thread.conversation.id,
        channel: input.channel,
        sender_type: 'customer',
        content_type: contentType,
        content_text: input.contentText,
        media_url: input.mediaUrl ?? null,
        media_type: input.mediaType ?? null,
        message_id: input.messageId,
        status: 'delivered',
        created_at: input.timestamp
          ? new Date(input.timestamp).toISOString()
          : new Date().toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id');

  if (msgError) {
    console.error('[omnichannel] message insert error:', msgError);
    throw new Error('message_insert_failed');
  }

  if (!insertedRows || insertedRows.length === 0) {
    // Deduped replay — ack and return before any fan-out.
    return {
      inserted: false,
      conversationId: thread.conversation.id,
      contactId: thread.contact.id,
      messageId: null,
      contactCreated: thread.contactCreated,
      conversationCreated: thread.conversationCreated,
    };
  }

  // Update conversation summary + unread (DB-side atomic bump).
  const { error: convError } = await admin.rpc('bump_conversation_on_inbound', {
    p_conversation_id: thread.conversation.id,
    p_last_message_text: input.contentText ?? `[${contentType}]`,
  });
  if (convError) console.error('[omnichannel] bump error:', convError);

  // Customer writing again re-opens a closed thread.
  await reopenClosedConversation(admin, thread.conversation);

  const runFanout = input.runFanout !== false;
  if (runFanout) {
    // Flows consume-or-advance; content triggers suppressed if consumed.
    const flowResult = await dispatchInboundToFlows({
      accountId,
      userId: thread.auditUserId,
      contactId: thread.contact.id,
      conversationId: thread.conversation.id,
      message: { kind: 'text', text: input.contentText ?? '', meta_message_id: input.messageId ?? '' },
      isFirstInboundMessage: false,
    });
    const flowConsumed = flowResult.consumed;

    const automationTriggers: string[] = [];
    if (!flowConsumed) automationTriggers.push('new_message_received', 'keyword_match');
    if (thread.contactCreated) automationTriggers.unshift('new_contact_created');
    for (const triggerType of automationTriggers) {
      await runAutomationsForTrigger({
        accountId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        triggerType: triggerType as any,
        contactId: thread.contact.id,
        context: {
          message_text: input.contentText ?? '',
          conversation_id: thread.conversation.id,
        },
      }).catch((err) =>
        console.error('[omnichannel] automation dispatch failed:', err),
      );
    }

    // AI auto-reply for plain text not consumed by a flow.
    if (!flowConsumed && (input.contentText ?? '').trim()) {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: thread.conversation.id,
        contactId: thread.contact.id,
        configOwnerUserId: thread.auditUserId,
      });
    }

    await dispatchWebhookEvent(admin, accountId, 'message.received', {
      conversation_id: thread.conversation.id,
      contact_id: thread.contact.id,
      channel: input.channel,
      content_type: contentType,
      text: input.contentText,
    });
  }

  // A successful round-trip means the channel is reachable — refresh the
  // live connection state so the Settings UI drops stale errors.
  const conn = await getChannelConnection(admin, accountId, input.channel);
  if (conn && conn.lastError) {
    await markChannelConnected(admin, accountId, input.channel);
  }

  return {
    inserted: true,
    conversationId: thread.conversation.id,
    contactId: thread.contact.id,
    messageId: insertedRows[0].id,
    contactCreated: thread.contactCreated,
    conversationCreated: thread.conversationCreated,
  };
}

export type { Channel };
