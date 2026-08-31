// ============================================================
// Meta webhook handling for Instagram Direct & Messenger.
//
// Meta uses ONE app-level webhook URL; which channel a delivery belongs
// to is determined by the recipient id in the payload:
//   - Messenger: `recipient.id` = the page id
//   - Instagram: `recipient.id` = the IG business account id
//
// The saved `channel_configs` credentials identify the page / IG
// business account (they're what the agent pastes into Settings). We
// scan those (encrypted at rest → decrypt in-memory), build a map of
// recipient-id → (account, config), then route each delivery to the
// matching channel's ingest.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import type { ManagedChannel } from './channel-config';

/** The credential keys we store in channel_configs.config that identify
 *  the business recipient so we can match webhook deliveries. */
const RECIPIENT_ID_KEYS: Record<Exclude<ManagedChannel, 'email' | 'webchat'>, string> = {
  instagram: 'instagramBusinessAccountId',
  messenger: 'pageId',
};
const ACCESS_TOKEN_KEYS: Record<Exclude<ManagedChannel, 'email' | 'webchat'>, string> = {
  instagram: 'accessToken',
  messenger: 'pageAccessToken',
};

export interface MetaRecipientMatch {
  accountId: string;
  channel: 'instagram' | 'messenger';
  recipientId: string;
  accessToken: string;
  verifyToken: string;
}

interface RawConfigRow {
  account_id: string;
  channel: string;
  config?: string | null;
}

/**
 * Build the recipient-id → account map for Meta channels by scanning the
 * account's channel_configs. Returns a function that looks up a
 * recipient id and returns the matching (account, channel, token).
 */
export async function buildMetaRecipientIndex(
  db: SupabaseClient,
): Promise<Map<string, MetaRecipientMatch>> {
  const map = new Map<string, MetaRecipientMatch>();
  const { data, error } = await db
    .from('channel_configs')
    .select('account_id, channel, config')
    .in('channel', ['instagram', 'messenger']);
  if (error) {
    console.error('[meta-webhook] channel_config scan error:', error);
    return map;
  }
  for (const row of (data as RawConfigRow[]) ?? []) {
    if (!row.config) continue;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(decrypt(row.config as string));
    } catch {
      continue;
    }
    const channel = row.channel as 'instagram' | 'messenger';
    const recipientId = config[RECIPIENT_ID_KEYS[channel]] as string | undefined;
    const accessToken = config[ACCESS_TOKEN_KEYS[channel]] as string | undefined;
    const verifyToken = config.verifyToken as string | undefined;
    if (!recipientId || !accessToken) continue;
    map.set(recipientId, {
      accountId: row.account_id,
      channel,
      recipientId,
      accessToken,
      verifyToken: verifyToken ?? '',
    });
  }
  return map;
}
