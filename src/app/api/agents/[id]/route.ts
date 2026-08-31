import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// PATCH /api/agents/[id] — update an agent (instructions, name, status,
// tools, responsibilities, manager).
// DELETE /api/agents/[id] — remove an agent (only employees; co-founder
// must survive unless the owner explicitly deletes the whole org).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string') patch.name = body.name.trim()
    if (typeof body.title === 'string') patch.title = body.title.trim() || null
    if (typeof body.instructions === 'string') patch.instructions = body.instructions
    if (typeof body.job_description === 'string') patch.job_description = body.job_description
    if (Array.isArray(body.responsibilities)) patch.responsibilities = body.responsibilities
    if (Array.isArray(body.tools)) patch.tools = body.tools
    if (body.status === 'active' || body.status === 'paused') patch.status = body.status
    if (!body.patchOnly) {
      if (typeof body.manager_id === 'string') {
        patch.manager_id = body.manager_id
        patch.reports_to = body.manager_id
      } else if (body.manager_id === null) {
        patch.manager_id = null
        patch.reports_to = null
      }
    }

    const { data, error } = await ctx.supabase
      .from('ai_agents')
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

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    // Refuse to delete the co-founder via this generic endpoint; the
    // org should always have its root unless the owner removes it
    // explicitly through a dedicated flow (future).
    const { data: target } = await ctx.supabase
      .from('ai_agents')
      .select('role')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (target?.role === 'co_founder') {
      return NextResponse.json(
        { error: 'Cannot delete the AI Co-Founder through this endpoint', code: 'bad_request' },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase
      .from('ai_agents')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ data: { ok: true }, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
