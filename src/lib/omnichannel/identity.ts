// ============================================================
// Omnichannel identity resolution — find (or create) the unified
// contact + conversation for a non-WhatsApp channel participant.
//
// WhatsApp resolves contacts by phone (migration 022). The other
// channels identify a remote user by a channel-specific external id:
//   instagram  -> the IG-scoped user id (IGSID)
//   messenger  -> the PSID
//   email      -> the sender's email address (lowercased)
//   webchat    -> a randomly generated session token
//
// A contact row is channel-scoped (migration 045): it carries
// `channel` + `channel_external_id` and is uniquely guarded by
// `(account_id, channel, channel_external_id)`. A non-phone contact
// still needs a `phone` value (the column is NOT NULL) — we use a
// stable, DIGIT-FREE synthetic string so its generated
// `phone_normalized` is '' and it can never collide with a real
// phone or with the (account_id, phone_normalized) WhatsApp index.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import type { Channel } from '@/types';

/** A provider remote-user id (IGSID / PSID / email / webchat token). */
export type ChannelExternalId = string;

export interface ChannelIdentity {
  /** The channel the message arrived on. */
  channel: Exclude<Channel, 'whatsapp'>;
  /** The remote user's identifier on that channel. */
  externalId: ChannelExternalId;
  /** Display name, when the provider supplies it. */
  name?: string | null;
  /** Email address, when known (only relevant to the email channel). */
  email?: string | null;
}

export interface ResolvedChannelContact {
  contact: { id: string; phone: string; channel: Channel };
  wasCreated: boolean;
  auditUserId: string;
}

/**
 * Produce a stable, digit-free synthetic `phone` for a non-phone
 * channel. Guaranteed to contain no digits so `phone_normalized`
 * (generated: strip non-digits) is '' and the row is excluded from
 * the WhatsApp `(account_id, phone_normalized)` unique index.
 */
export function syntheticPhoneForChannel(
  channel: Exclude<Channel, 'whatsapp'>,
  externalId: string,
): string {
  // Letters only (strip any digits the external id may carry) so the
  // normalized form is always ''. Prefix keeps the source identifiable.
  const letters = externalId.replace(/[^a-zA-Z]/g, '');
  const fallback = 'anon';
  return `${channel}-${(letters || fallback)}`;
}

/**
 * The audit `user_id` for rows created with no human actor (webhook /
 * poller). Returns the account owner. Mirrors `resolveAuditUserId`
 * (src/lib/api/v1/contacts.ts) — the account owner is the stable,
 * always-present audit default for every account.
 */
export async function resolveChannelAuditUserId(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = (account as { owner_user_id?: string | null } | null)
    ?.owner_user_id;
  if (!owner) {
    throw new Error(`Account owner could not be resolved for ${accountId}`);
  }
  return owner;
}

/**
 * Find-or-create the channel-scoped contact. Returns the contact row
 * plus whether it was just created. Throws on a DB failure (so the
 * caller can decide whether to acknowledge the webhook).
 */
export async function resolveChannelContact(
  db: SupabaseClient,
  accountId: string,
  identity: ChannelIdentity,
): Promise<ResolvedChannelContact> {
  const { channel, externalId, name, email } = identity;

  // Look up by the channel identity (unique index 045).
  const { data: existing, error: findErr } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .eq('channel_external_id', externalId)
    .maybeSingle();

  if (findErr) {
    console.error('[omnichannel] contact lookup error:', findErr);
    throw new Error('contact_lookup_failed');
  }

  if (existing) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name && name !== existing.name) patch.name = name;
    if (email && email !== existing.email) patch.email = email;
    if (Object.keys(patch).length > 1) {
      await db.from('contacts').update(patch).eq('id', existing.id);
    }
    return {
      contact: existing,
      wasCreated: false,
      auditUserId: existing.user_id,
    };
  }

  const auditUserId = await resolveChannelAuditUserId(db, accountId);
  const phone = syntheticPhoneForChannel(channel, externalId);

  const { data: created, error: createErr } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      channel,
      channel_external_id: externalId,
      phone,
      name: name ?? externalId,
      email: email ?? null,
    })
    .select('*')
    .single();

  if (createErr || !created) {
    if (isUniqueViolation(createErr)) {
      // Raced another delivery creating the same identity — re-resolve.
      const { data: raced } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('channel', channel)
        .eq('channel_external_id', externalId)
        .maybeSingle();
      if (raced) {
        return {
          contact: raced,
          wasCreated: false,
          auditUserId: raced.user_id,
        };
      }
    }
    console.error('[omnichannel] contact create error:', createErr);
    throw new Error('contact_create_failed');
  }

  return { contact: created, wasCreated: true, auditUserId };
}

/**
 * Find-or-create the conversation for a channel contact. One
 * conversation per (account, contact) — the same convention WhatsApp
 * uses (migration 036). Because contacts are channel-scoped, this is
 * naturally one conversation per (account, contact, channel).
 */
export async function resolveChannelConversation(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  auditUserId: string,
  channel: Exclude<Channel, 'whatsapp'>,
): Promise<{ conversation: { id: string; status?: string | null; channel: Channel }; created: boolean }> {
  const { data: existingRows, error: findErr } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[omnichannel] conversation lookup error:', findErr);
    throw new Error('conversation_lookup_failed');
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: contactId,
      channel,
    })
    .select('*')
    .single();

  if (createErr || !newConv) {
    if (isUniqueViolation(createErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('[omnichannel] conversation create error:', createErr);
    throw new Error('conversation_create_failed');
  }

  return { conversation: newConv, created: true };
}

/**
 * Resolve both the contact and its conversation for a channel identity
 * in one call — the usual entry point for an inbound message.
 */
export async function resolveChannelThread(
  db: SupabaseClient,
  accountId: string,
  identity: ChannelIdentity,
): Promise<{
  contact: { id: string; phone: string; channel: Channel };
  conversation: { id: string; status?: string | null; channel: Channel };
  contactCreated: boolean;
  conversationCreated: boolean;
  auditUserId: string;
}> {
  const { contact, wasCreated, auditUserId } = await resolveChannelContact(
    db,
    accountId,
    identity,
  );
  const { conversation, created } = await resolveChannelConversation(
    db,
    accountId,
    contact.id,
    auditUserId,
    identity.channel,
  );
  return {
    contact,
    conversation,
    contactCreated: wasCreated,
    conversationCreated: created,
    auditUserId,
  };
}
