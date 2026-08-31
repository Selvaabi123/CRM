import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  runCoFounderAnalysis,
  delegateGeneratedTasks,
  logActivity,
} from '@/lib/agents/co-founder'

// POST /api/agents/analyze
// Runs the AI Co-Founder: analyzes the business, returns recommendations
// and, when `delegate: true` (default), creates tasks for AI employees.
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const directive = typeof body.directive === 'string' ? (body.directive as string) : ''
    const shouldDelegate = body.delegate !== false

    const outcome = await runCoFounderAnalysis(ctx.supabase, ctx.accountId, directive)

    // Locate the co-founder for task attribution.
    const { data: coFounder } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('role', 'co_founder')
      .maybeSingle()

    let delegation = { created: 0, skipped: 0 }
    if (shouldDelegate && coFounder) {
      delegation = await delegateGeneratedTasks(
        ctx.supabase,
        ctx.accountId,
        coFounder.id,
        outcome.tasks,
      )
    }

    if (coFounder) {
      await logActivity(ctx.supabase, ctx.accountId, coFounder.id, 'analysis_run', 'Ran a business analysis', {
        recommendationCount: outcome.recommendations.length,
        taskCount: outcome.tasks.length,
      })
    }

    return NextResponse.json({ data: { ...outcome, delegation }, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
