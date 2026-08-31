import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const VALID_STATUS = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const

// PATCH /api/tasks/[id] — update a task: status, progress, result, or
// escalation. Handles the timestamp bookkeeping for status transitions.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    // Load current row to compute transition side-effects.
    const { data: current } = await ctx.supabase
      .from('ai_tasks')
      .select('*')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!current) {
      return NextResponse.json(
        { error: 'Task not found', code: 'not_found' },
        { status: 404 },
      )
    }

    const patch: Record<string, unknown> = {}

    if (typeof body.progress === 'number') {
      const progress = Math.max(0, Math.min(100, body.progress))
      patch.progress = progress
      if (progress === 100 && current.status !== 'done') {
        patch.status = 'done'
        patch.completed_at = new Date().toISOString()
      }
    }

    if (typeof body.status === 'string') {
      const status = body.status
      if (!(VALID_STATUS as readonly string[]).includes(status)) {
        return NextResponse.json(
          { error: `Invalid status: ${status}`, code: 'bad_request' },
          { status: 400 },
        )
      }
      patch.status = status
      if (status === 'in_progress' && !current.started_at) {
        patch.started_at = new Date().toISOString()
      }
      if (status === 'done') {
        patch.completed_at = new Date().toISOString()
        patch.progress = 100
      }
      if (status === 'todo') {
        patch.progress = 0
        patch.completed_at = null
      }
    }

    if (typeof body.result === 'string') patch.result = body.result
    if (body.result_metadata && typeof body.result_metadata === 'object') {
      patch.result_metadata = body.result_metadata
    }
    if (typeof body.escalated === 'boolean') {
      patch.escalated = body.escalated
      if (body.escalated && typeof body.escalation_note === 'string') {
        patch.escalation_note = body.escalation_note
      }
      if (!body.escalated) patch.escalation_note = null
    }

    const { data, error } = await ctx.supabase
      .from('ai_tasks')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('*')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
