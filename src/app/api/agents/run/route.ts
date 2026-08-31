import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  runAgentTask,
  runAutoWorker,
  aiSelectToolPlan,
} from '@/lib/agents/worker'

// POST /api/agents/run
// Executes AI Employee work. Either:
//   - `{ taskId }`           → run a single task assigned to an AI employee
//   - `{}` / no taskId       → sweep every open task to its active assignee
//   - `{ ai: true }`         → have the account's LLM CHOOSE the tool plan
//                              (for tasks with no explicit plan) instead of
//                              falling back to "no plan". Deterministic
//                              without an AI key.
//
// The plan (whether owner-written or LLM-chosen) is executed as
// `{ tool, args }` steps, each gated by the assignee's `tools`
// allow-list, and every write is scoped to the caller's account.
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole('agent')
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const taskId = typeof body.taskId === 'string' && body.taskId ? (body.taskId as string) : null
    const useAi = body.ai === true

    if (taskId) {
      const { data: task, error } = await ctx.supabase
        .from('ai_tasks')
        .select('*, assignee:assignee_agent_id(id, name, role, title, instructions, tools, status)')
        .eq('id', taskId)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      if (!task) {
        return NextResponse.json(
          { error: 'Task not found in your account', code: 'not_found' },
          { status: 404 },
        )
      }
      const assignee = (task as {
        assignee?: {
          name?: string
          role?: string
          title?: string
          instructions?: string | null
          tools?: string[]
          status?: string
        } | null
      }).assignee
      if (!assignee) {
        return NextResponse.json(
          { error: 'Task has no assignee agent', code: 'bad_request' },
          { status: 400 },
        )
      }
      if (assignee.status !== 'active') {
        return NextResponse.json(
          { error: `Assignee "${assignee.name}" is paused`, code: 'agent_paused' },
          { status: 400 },
        )
      }

      // Optionally have the LLM choose the tool plan for tasks without
      // an explicit one.
      let aiPlan = null
      const explicitHasPlan = Array.isArray(
        (task.result_metadata as { plan?: unknown } | null)?.plan,
      )
      if (useAi && !explicitHasPlan) {
        aiPlan = await aiSelectToolPlan(ctx.supabase, ctx.accountId, {
          agentName: assignee.name ?? 'AI Employee',
          agentRole: assignee.title ?? assignee.role ?? 'employee',
          agentInstructions: assignee.instructions ?? null,
          allowedTools: assignee.tools ?? [],
          taskTitle: task.title,
          taskDescription: task.description ?? null,
        })
      }

      const run = await runAgentTask(
        ctx.supabase,
        ctx.accountId,
        ctx.userId,
        {
          id: task.id,
          assignee_agent_id: task.assignee_agent_id,
          status: task.status,
          progress: task.progress,
          title: task.title,
          result_metadata: task.result_metadata,
        },
        assignee.tools ?? [],
        assignee.name ?? 'AI Employee',
        { aiPlan: useAi ? aiPlan : null },
      )
      return NextResponse.json({ data: { ...run, aiPlan }, error: null })
    }

    // Sweep all open tasks.
    const runs = await runAutoWorker(ctx.supabase, ctx.accountId, { useAi })
    return NextResponse.json({ data: runs, error: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
