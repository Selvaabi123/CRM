import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { pollEmailMailbox } from '@/lib/omnichannel/email-poll'

export const maxDuration = 120

/**
 * Scheduled IMAP poll. Hits every configured email channel, fetches
 * unseen messages, and ingests them into the unified inbox.
 *
 * Meant to be hit on a schedule (Vercel Cron / external pinger) and
 * requires `x-cron-secret` to match `AUTOMATION_CRON_SECRET` (shared
 * with the automation/flow/agent cron endpoints).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('channel_configs')
    .select('account_id, config')
    .eq('channel', 'email')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ processed: 0 })
  }

  let total = 0
  for (const row of data) {
    try {
      total += await pollEmailMailbox(row)
    } catch (e) {
      console.error('[email-poll] row poll threw:', e)
    }
  }

  return NextResponse.json({ processed: total })
}
