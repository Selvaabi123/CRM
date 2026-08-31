import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendViaChannel } from '@/lib/omnichannel/send'
import { SendMessageError } from '@/lib/whatsapp/send-message'

export const maxDuration = 60

// POST /api/channels/send
// Generic reply sender for non-WhatsApp channels. The inbox routes
// replies here when the active conversation's channel is instagram,
// messenger, email, or webchat (WhatsApp keeps /api/whatsapp/send).
// Body: { conversation_id, content_text, media_url?, media_type? }
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const conversationId = String(body.conversation_id ?? '')
    const text = String(body.content_text ?? '')
    const mediaUrl = body.media_url ? String(body.media_url) : null
    const mediaType = body.media_type ? String(body.media_type) : null

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required', code: 'bad_request' },
        { status: 400 },
      )
    }

    const result = await sendViaChannel(ctx.supabase, ctx.accountId, {
      conversationId,
      text,
      mediaUrl,
      mediaType,
    })

    return NextResponse.json({ data: result, error: null })
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
