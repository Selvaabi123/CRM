// ============================================================
// Meta-based channel sends (Instagram Direct & Facebook Messenger).
//
// Both channels use the Meta Graph API with a page/user access token
// and the recipient's channel id (IGSID for Instagram, PSID for
// Messenger). Credentials come from `channel_configs` (migration 040),
// decrypted via the shared encryption helper.
//
// Instagram:  POST /{ig-id}/messages   { recipient: {id}, message: {text} }
// Messenger:  POST /me/messages        { recipient: {id: psid}, message: {text}, messaging_type }
// ============================================================

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaErrorResponse {
  error?: { message?: string; code?: number };
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // non-JSON body — keep fallback
  }
  throw new Error(message);
}

export interface MetaDirectSendArgs {
  /** Page access token, or user token for Instagram. */
  accessToken: string;
  /** IGSID (instagram) or PSID (messenger). */
  recipientId: string;
  text: string;
  /** The Messenger-specific id (the business's page identifier). For
   *  Instagram this is the IG business account id. */
  senderAccountId: string;
  channel: 'instagram' | 'messenger';
}

export interface MetaDirectSendResult {
  messageId: string;
}

/**
 * Send a plain-text direct message via the Meta Graph API.
 * Returns the provider message id, or throws with a human-readable
 * Meta error on failure (surfaced to the agent via the API).
 */
export async function sendMetaDirectMessage(
  args: MetaDirectSendArgs,
): Promise<MetaDirectSendResult> {
  const { accessToken, recipientId, text, senderAccountId, channel } = args;
  const isMessenger = channel === 'messenger';

  // Messenger uses the page's id scope (`/me/messages` on the page token);
  // Instagram uses the business account id (`/{ig-id}/messages`).
  const endpoint = isMessenger
    ? `${META_API_BASE}/me/messages`
    : `${META_API_BASE}/${senderAccountId}/messages`;

  const body: Record<string, unknown> = isMessenger
    ? {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
      }
    : {
        recipient: { id: recipientId },
        message: { text },
      };

  const response = await fetch(`${endpoint}?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }

  const data = (await response.json()) as { message_id?: string };
  if (!data.message_id) {
    throw new Error('Meta did not return a message id');
  }
  return { messageId: data.message_id };
}

/**
 * Verify the webhook subscription is live by calling the Graph API
 * debug URL for a token. Returns true on a 200. Used by the connection
 * status check in Settings.
 */
export async function verifyMetaToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${META_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}
