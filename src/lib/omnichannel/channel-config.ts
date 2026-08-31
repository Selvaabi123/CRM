// ============================================================
// Channel config access for the omnichannel integrations.
//
// New channels (instagram / messenger / email / webchat) store their
// credentials + connection metadata in `channel_configs` (migration
// 040) as an app-side AES-256-GCM encrypted blob. WhatsApp keeps its
// own `whatsapp_config` table; this module never touches it.
//
// The GET /api/channels route intentionally does NOT return the
// encrypted blob — callers that need the secret decrypt it here via
// the service-role client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import type { Channel } from '@/types';

export type ManagedChannel = Exclude<Channel, 'whatsapp'>;

export const MANAGED_CHANNELS: ManagedChannel[] = [
  'instagram',
  'messenger',
  'email',
  'webchat',
];

/**
 * The decrypted connection config for a channel, plus the booleans that
 * gate behaviour. `config` is undefined when the account hasn't saved
 * any credentials yet.
 */
export interface ChannelConnection {
  channel: ManagedChannel;
  isEnabled: boolean;
  connectedAt: string | null;
  lastError: string | null;
  /** The decrypted credential blob the account saved. */
  config: Record<string, unknown> | null;
  /** True only when a config row exists (i.e. credentials were saved). */
  configured: boolean;
}

/**
 * Load + decrypt a channel's config for an account.
 * Returns null when no row exists / the row is disabled / decryption
 * fails — in every case the integration should treat the channel as
 * "not usable".
 */
export async function getChannelConnection(
  db: SupabaseClient,
  accountId: string,
  channel: ManagedChannel,
): Promise<ChannelConnection | null> {
  const { data, error } = await db
    .from('channel_configs')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .maybeSingle();

  if (error) {
    console.error('[omnichannel] channel_config lookup error:', error);
    return null;
  }
  if (!data) {
    return {
      channel,
      isEnabled: false,
      connectedAt: null,
      lastError: null,
      config: null,
      configured: false,
    };
  }

  let config: Record<string, unknown> | null = null;
  if (data.config) {
    try {
      config = JSON.parse(decrypt(data.config as string));
    } catch (e) {
      console.error(`[omnichannel] failed to decrypt ${channel} config:`, e);
      return null;
    }
  }

  return {
    channel,
    isEnabled: data.is_enabled !== false,
    connectedAt: data.connected_at as string | null,
    lastError: data.last_error as string | null,
    config,
    configured: true,
  };
}

/**
 * Record a channel error / connection-state change. Errors are surfaced
 * in the Settings → Channels UI (the `last_error` column) so a broken
 * credential is visible, not silent.
 */
export async function markChannelError(
  db: SupabaseClient,
  accountId: string,
  channel: ManagedChannel,
  message: string,
): Promise<void> {
  await db
    .from('channel_configs')
    .update({ last_error: message, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('channel', channel);
}

/**
 * Mark a channel as connected (clear the error + stamp connected_at if
 * it was never set). Called when a message round-trips successfully so
 * the Settings UI reflects live health.
 */
export async function markChannelConnected(
  db: SupabaseClient,
  accountId: string,
  channel: ManagedChannel,
): Promise<void> {
  await db
    .from('channel_configs')
    .update({
      last_error: null,
      is_enabled: true,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
    .eq('channel', channel);
}
