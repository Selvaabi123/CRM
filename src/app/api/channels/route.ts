import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

// WhatsApp is configured via the existing whatsapp_config table, so this
// route manages the OTHER channels: instagram, messenger, email, webchat.
// The `config` blob is app-side encrypted (AES-256-GCM with ENCRYPTION_KEY)
// before storage — see src/lib/whatsapp/encryption.ts.
const MANAGED_CHANNELS = ['instagram', 'messenger', 'email', 'webchat'] as const

// GET /api/channels — list the account's non-WhatsApp channel configs
// (never returns the encrypted blob — only which are enabled/connected).
// Each row carries an `endpoint` describing where traffic for that channel
// arrives plus the `account_id` (needed to build the webchat embed snippet).
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole('viewer')
    const origin = req.headers.get('origin') ?? req.nextUrl.origin
    const { data, error } = await ctx.supabase
      .from('channel_configs')
      .select('id, channel, is_enabled, connected_at, last_error, created_at, updated_at')
      .eq('account_id', ctx.accountId)
      .order('channel')
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const rows = (data ?? []).map((c) => {
      let endpoint: string | null = null
      if (c.channel === 'instagram' || c.channel === 'messenger') {
        endpoint = `${origin}/api/webhooks/meta`
      } else if (c.channel === 'email') {
        endpoint = `${origin}/api/email/poll`
      } else if (c.channel === 'webchat') {
        endpoint = `${origin}/api/webchat/widget.js?account=${ctx.accountId}`
      }
      return { ...c, endpoint, account_id: ctx.accountId }
    })
    return NextResponse.json({ data: rows, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST /api/channels — upsert a channel config. Body: { channel, config }.
// config is encrypted at rest. Setting config = null stores an empty row
// (e.g. webchat, which needs no secret).
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const channel = String(body.channel ?? '')
    if (!(MANAGED_CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json(
        { error: `Unsupported channel: ${channel}`, code: 'bad_request' },
        { status: 400 },
      )
    }

    const rawConfig = body.config ? body.config : {}
    // Stringify + encrypt so connection secrets never sit plaintext in the DB.
    let stored: string | null = null
    if (body.config) {
      stored = encrypt(JSON.stringify(rawConfig))
    }

    const { data, error } = await ctx.supabase
      .from('channel_configs')
      .upsert(
        {
          account_id: ctx.accountId,
          channel,
          config: stored,
          is_enabled: body.is_enabled !== false,
          connected_at: body.config ? new Date().toISOString() : null,
          last_error: null,
        },
        { onConflict: 'account_id,channel' },
      )
      .select('id, channel, is_enabled, connected_at, last_error, created_at, updated_at')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data, error: null }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// PATCH /api/channels — toggle enable/disable without touching the stored
// encrypted config (unlike POST, which overwrites it).
export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const channel = String(body.channel ?? '')
    if (!(MANAGED_CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json(
        { error: `Unsupported channel: ${channel}`, code: 'bad_request' },
        { status: 400 },
      )
    }
    const enabled = body.is_enabled !== false

    const { data, error } = await ctx.supabase
      .from('channel_configs')
      .update({
        is_enabled: enabled,
        last_error: null,
      })
      .eq('account_id', ctx.accountId)
      .eq('channel', channel)
      .select('id, channel, is_enabled, connected_at, last_error, created_at, updated_at')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// DELETE /api/channels?channel=<name> — remove a channel config and disable
// the channel (useful when a page/app connection is revoked).
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    const channel = req.nextUrl.searchParams.get('channel')
    if (!channel || !(MANAGED_CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json(
        { error: `Unsupported channel: ${channel}`, code: 'bad_request' },
        { status: 400 },
      )
    }
    const { error } = await ctx.supabase
      .from('channel_configs')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('channel', channel)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data: { channel }, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
