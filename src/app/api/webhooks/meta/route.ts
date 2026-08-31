import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  buildMetaRecipientIndex,
  type MetaRecipientMatch,
} from '@/lib/omnichannel/meta-webhook'
import { ingestInboundMessage } from '@/lib/omnichannel/ingest'
import { markChannelError } from '@/lib/omnichannel/channel-config'

export const maxDuration = 60

let _adminClient: ReturnType<typeof createClient> | null = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface MetaMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp?: number
  message?: {
    mid: string
    text?: string
    attachments?: Array<{
      type?: string
      payload?: { url?: string; mime_type?: string }
    }>
  }
  postback?: { title?: string; payload?: string }
}

// GET — webhook subscription verification. Matches `hub.verify_token`
// against any configured Instagram / Messenger channel for any account.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const index = await buildMetaRecipientIndex(supabaseAdmin())
    for (const match of index.values()) {
      if (match.verifyToken && match.verifyToken === verifyToken) {
        return new Response(challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('Error in Meta webhook GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST — inbound Instagram / Messenger deliveries.
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[meta-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: Array<{ messaging?: MetaMessagingEvent[] }> }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  after(async () => {
    try {
      await processMetaWebhook(body)
    } catch (error) {
      console.error('Error processing Meta webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processMetaWebhook(
  body: { entry?: Array<{ messaging?: MetaMessagingEvent[] }> }
): Promise<void> {
  const entries = body.entry ?? []
  if (entries.length === 0) return

  // Match each delivery to an account + channel by the recipient id.
  const index = await buildMetaRecipientIndex(supabaseAdmin())

  for (const entry of entries) {
    for (const event of entry.messaging ?? []) {
      const recipientId = event.recipient?.id
      if (!recipientId) continue
      const match = index.get(recipientId)
      if (!match) {
        // Unknown recipient — not one of this deployment's configured
        // pages/accounts. Nothing to do.
        console.warn('[meta-webhook] no channel config for recipient', recipientId)
        continue
      }
      await handleMetaMessaging(match, event)
    }
  }
}

async function handleMetaMessaging(
  match: MetaRecipientMatch,
  event: MetaMessagingEvent,
): Promise<void> {
  const channel = match.channel
  const senderId = event.sender?.id

  // Only handle actual messages (webhook also delivers delivery/read
  // receipts and echo events; those have no `message.mid`).
  const msg = event.message
  if (!senderId || !msg || !msg.mid) return

  // Meta echoes back messages the business sent to its own sender id
  // (for Messenger, the business is `recipient.id` itself). Guard: only
  // treat as inbound if the sender is NOT the configured business id.
  if (senderId === match.recipientId) return

  // Extract text + optional first image attachment.
  const contentText: string | null = msg.text ?? null
  let mediaUrl: string | null = null
  let mediaType: string | null = null
  let contentType: 'text' | 'image' | 'document' | 'audio' | 'video' = 'text'
  if (msg.attachments && msg.attachments.length > 0 && !contentText) {
    const att = msg.attachments[0]
    if (att.payload?.url) mediaUrl = att.payload.url
    mediaType = att.payload?.mime_type ?? null
    const t = (att.type ?? '').toLowerCase()
    if (t.includes('image')) contentType = 'image'
    else if (t.includes('audio')) contentType = 'audio'
    else if (t.includes('video')) contentType = 'video'
    else contentType = 'document'
  }

  try {
    await ingestInboundMessage(supabaseAdmin(), match.accountId, {
      channel,
      externalId: senderId,
      name: null,
      messageId: msg.mid,
      contentText: contentText ?? '[Media]',
      contentType,
      mediaUrl,
      mediaType,
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
    })
  } catch (e) {
    // Hard ingest failure — record it against the channel so Settings
    // surfaces it, then swallow so the webhook 200s (Meta will retry if
    // we error, but a misconfigured business shouldn't flood).
    console.error('[meta-webhook] ingest failed:', e)
    await markChannelError(
      supabaseAdmin(),
      match.accountId,
      channel,
      `Message ingest failed: ${e instanceof Error ? e.message : 'unknown error'}`
    )
  }
}
