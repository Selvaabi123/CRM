import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ingestInboundMessage } from '@/lib/omnichannel/ingest'

export const maxDuration = 30

interface WebchatContact {
  id: string
  account_id: string
  user_id: string
}

// Look up the webchat contact + its conversation by session token
// (stored as the contact's channel_external_id).
async function resolveWebchatThread(token: string): Promise<{
  contact: WebchatContact
  conversationId: string
} | null> {
  const admin = supabaseAdmin()
  const { data: contact } = await admin
    .from('contacts')
    .select('id, account_id, user_id')
    .eq('channel', 'webchat')
    .eq('channel_external_id', token)
    .maybeSingle()
  if (!contact) return null

  const { data: conv } = await admin
    .from('conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('channel', 'webchat')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!conv) return null

  return { contact, conversationId: conv.id }
}

// GET /api/webchat/messages?token=...&since=<ISO>
// Public read for the widget: returns messages for the visitor's
// conversation newer than `since`. Both customer and agent messages are
// returned so the visitor sees agent replies live.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const token = searchParams.get('token')
  const since = searchParams.get('since')
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const thread = await resolveWebchatThread(token)
  if (!thread) {
    return NextResponse.json({ error: 'invalid session' }, { status: 404 })
  }

  let query = admin
    .from('messages')
    .select('id, sender_type, content_type, content_text, media_url, created_at, message_id')
    .eq('conversation_id', thread.conversationId)
    .order('created_at', { ascending: true })
    .limit(200)
  if (since && since !== '') {
    query = query.gt('created_at', since)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ messages: data ?? [] })
}

// POST /api/webchat/messages?token=...
// Public write for the visitor. Body: { text, clientId }.
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const token = searchParams.get('token')
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 })
  }
  const body = await req.json().catch(() => ({}))
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const clientId = typeof body.clientId === 'string' ? body.clientId : null
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const thread = await resolveWebchatThread(token)
  if (!thread) {
    return NextResponse.json({ error: 'invalid session' }, { status: 404 })
  }

  try {
    const result = await ingestInboundMessage(admin, thread.contact.account_id, {
      channel: 'webchat',
      externalId: token,
      name: 'Website visitor',
      // Dedupe on the widget-generated client id so a client retry isn't
      // double-stored.
      messageId:
        clientId ?? `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      contentText: text,
      contentType: 'text',
      runFanout: true,
    })
    return NextResponse.json({ ok: true, inserted: result.inserted })
  } catch (e) {
    console.error('[webchat] message error:', e)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
