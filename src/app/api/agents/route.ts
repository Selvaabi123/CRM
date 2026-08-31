import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { AI_EMPLOYEE_ROLES } from '@/types/ai-agents'

// GET /api/agents — list the account's AI org tree (co-founder first).
// POST /api/agents — create an AI employee (or seed the co-founder).
export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .select('*, manager:manager_id(id, name, role)')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Co-founder is the root (manager_id null); children under it.
    const tree = (data ?? []).map((a) => ({ ...a, manager: a.manager ?? null }))
    return NextResponse.json({ data: tree, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    const role = String(body.role ?? '')
    const name = String(body.name ?? '').trim()

    if (role === 'co_founder') {
      // Ensure exactly one co-founder, seeded with defaults.
      const { data: existing } = await ctx.supabase
        .from('ai_agents')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('role', 'co_founder')
        .maybeSingle()
      if (existing) {
        return NextResponse.json({ data: existing, error: null })
      }
      const { data, error } = await ctx.supabase
        .from('ai_agents')
        .insert({
          account_id: ctx.accountId,
          name: name || 'AI Co-Founder',
          role: 'co_founder',
          title: 'AI Co-Founder',
          created_by: ctx.userId,
        })
        .select('*')
        .single()
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ data, error: null }, { status: 201 })
    }

    // Create an AI employee.
    const preset = AI_EMPLOYEE_ROLES.find((r) => r.role === role) ?? null
    const isKnownRole = Boolean(preset)

    if (!isKnownRole && role !== 'custom') {
      return NextResponse.json(
        { error: `Unknown agent role: ${role}`, code: 'bad_request' },
        { status: 400 },
      )
    }

    const instructions =
      String(body.instructions ?? '').trim() || preset?.instructions || ''
    const responsibilities = Array.isArray(body.responsibilities)
      ? (body.responsibilities as string[]).map(String)
      : preset?.responsibilities ?? []
    const tools = Array.isArray(body.tools)
      ? (body.tools as string[]).map(String)
      : preset?.tools ?? []
    const managerId =
      body.manager_id && typeof body.manager_id === 'string'
        ? (body.manager_id as string)
        : null

    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .insert({
        account_id: ctx.accountId,
        name: name || preset?.title || 'AI Employee',
        role: role === 'custom' ? 'custom' : (role as never),
        title: String(body.title ?? '').trim() || preset?.title || null,
        instructions,
        responsibilities,
        tools,
        manager_id: managerId,
        reports_to: managerId,
        job_description: body.job_description ? String(body.job_description) : null,
        created_by: ctx.userId,
      })
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
