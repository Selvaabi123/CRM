import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { coFounderReview } from '@/lib/agents/worker'

// POST /api/agents/review
// Runs the AI Co-Founder's review pass: reads the account's recent
// task outcomes (done / blocked / escalated) and produces an
// owner-facing report, logging the review to the activity feed.
export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const { data: coFounder } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('role', 'co_founder')
      .maybeSingle()

    if (!coFounder) {
      return NextResponse.json(
        { error: 'No AI Co-Founder configured', code: 'not_found' },
        { status: 404 },
      )
    }

    const review = await coFounderReview(ctx.supabase, ctx.accountId, coFounder.id)
    return NextResponse.json({ data: review, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
