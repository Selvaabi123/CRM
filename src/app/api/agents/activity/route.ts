import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// GET /api/agents/activity?agent=<id> — recent activity across the AI org.
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole('viewer')
    const url = new URL(req.url)
    const agentId = url.searchParams.get('agent')
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)

    let q = ctx.supabase
      .from('agent_activity_log')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (agentId) q = q.eq('agent_id', agentId)

    const { data, error } = await q
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data: data ?? [], error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
