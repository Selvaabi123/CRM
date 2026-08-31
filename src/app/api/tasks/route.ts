import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

const VALID_STATUS = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const
const VALID_PRIORITY = ['low', 'medium', 'high', 'critical'] as const

// GET /api/tasks — list the account's tasks (optionally by agent).
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireRole('viewer')
    const url = new URL(req.url)
    const agentId = url.searchParams.get('agent')
    const status = url.searchParams.get('status')

    let q = ctx.supabase
      .from('ai_tasks')
      .select('*, assignee:assignee_agent_id(id, name, role, title)')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })

    if (agentId) q = q.eq('assignee_agent_id', agentId)
    if (status && (VALID_STATUS as readonly string[]).includes(status)) q = q.eq('status', status)

    const { data, error } = await q
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data: data ?? [], error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST /api/tasks — create a task (owner or co-founder assigns to an agent).
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    const assigneeAgentId = String(body.assignee_agent_id ?? '')
    const title = String(body.title ?? '').trim()
    if (!assigneeAgentId || !title) {
      return NextResponse.json(
        { error: 'assignee_agent_id and title are required', code: 'bad_request' },
        { status: 400 },
      )
    }

    // Verify the assignee belongs to this account.
    const { data: assignee } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('id', assigneeAgentId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!assignee) {
      return NextResponse.json(
        { error: 'Assignee agent not found in your account', code: 'not_found' },
        { status: 404 },
      )
    }

    const insert: Record<string, unknown> = {
      account_id: ctx.accountId,
      assignee_agent_id: assigneeAgentId,
      title,
      description: body.description ? String(body.description) : null,
      priority: (VALID_PRIORITY as readonly string[]).includes(String(body.priority))
        ? String(body.priority)
        : 'medium',
      status: 'todo',
      created_by_user_id: ctx.userId,
    }
    if (body.due_at) insert.due_at = String(body.due_at)

    const { data, error } = await ctx.supabase
      .from('ai_tasks')
      .insert(insert)
      .select('*')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data, error: null }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
