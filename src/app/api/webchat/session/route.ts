import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  resolveChannelContact,
  resolveChannelConversation,
} from '@/lib/omnichannel/identity'
import { getChannelConnection } from '@/lib/omnichannel/channel-config'

export const maxDuration = 30

// POST /api/webchat/session?account=<accountId>
// Public (no auth — the widget runs on a customer's site). Creates (or
// returns) the visitor's webchat session: a high-entropy token that
// becomes the contact's `channel_external_id`. A returning visitor with
// an existing token gets their same conversation back (token is passed
// as `token` and reused if valid).
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const accountId = searchParams.get('account')

  let token: string | null = null
  try {
    const body = await req.json().catch(() => ({}))
    token = typeof body.token === 'string' && body.token ? body.token : null
  } catch {
    // no body — new session
  }

  if (!accountId) {
    return NextResponse.json({ error: 'account is required' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // Webchat must be enabled for this account.
  const conn = await getChannelConnection(admin, accountId, 'webchat')
  if (!conn || !conn.isEnabled) {
    return NextResponse.json(
      { error: 'webchat is disabled for this account' },
      { status: 403 },
    )
  }

  try {
    // Reuse an existing token if it maps to a real webchat contact here.
    if (token) {
      const existing = await resolveChannelContact(admin, accountId, {
        channel: 'webchat',
        externalId: token,
      })
      if (existing) {
        const conv = await resolveChannelConversation(
          admin,
          accountId,
          existing.contact.id,
          existing.auditUserId,
          'webchat',
        )
        return NextResponse.json({
          token,
          conversationId: conv.conversation.id,
        })
      }
    }

    // New visitor session.
    token = randomBytes(24).toString('hex')
    const contact = await resolveChannelContact(admin, accountId, {
      channel: 'webchat',
      externalId: token,
      name: 'Website visitor',
    })
    const conv = await resolveChannelConversation(
      admin,
      accountId,
      contact.contact.id,
      contact.auditUserId,
      'webchat',
    )

    return NextResponse.json({ token, conversationId: conv.conversation.id })
  } catch (e) {
    console.error('[webchat] session error:', e)
    return NextResponse.json({ error: 'Failed to start chat' }, { status: 500 })
  }
}
