import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  runCoFounderAnalysis,
  delegateGeneratedTasks,
  logActivity,
} from '@/lib/agents/co-founder'
import { runAutoWorker, coFounderReview } from '@/lib/agents/worker'

/**
 * Scheduled AI Employee pipeline — the autonomous operating system.
 *
 * For every account with an enabled Co-Founder agent, this runs the
 * full loop in one tick:
 *
 *   1. Co-Founder monitoring loop  — analyze the business, delegate any
 *      generated tasks to its AI employees (runCoFounderAnalysis +
 *      delegateGeneratedTasks).
 *   2. Employee task sweep          — hand every open task to its active
 *      assignee. Each task is executed via the existing LLM
 *      tool-selection + deterministic executor, saving results + activity
 *      logs (runAutoWorker, claim-guarded against double-runs).
 *   3. Escalation                   — blocked/failed tasks are flagged
 *      (escalated=true) by the executor and picked up by the Co-Founder
 *      review pass below.
 *   4. Owner report                 — coFounderReview summarizes done /
 *      blocked / escalated / open work and prepares an owner report.
 *
 * Meant to be hit on a schedule (Vercel Cron / external pinger) and
 * requires the secret to match `AUTOMATION_CRON_SECRET` (shared with the
 * automation cron for a single secret to configure). The secret is
 * accepted from either the `x-cron-secret` header or a standard
 * `Authorization: Bearer <secret>` header (Vercel Cron sends the
 * latter automatically, so no custom header plumbing is needed).
 *
 * The active-monitor timestamps are bumped on each successful run so a
 * per-account "analyzed N minutes ago" can be surfaced in the Agent Org UI.
 *
 * For manual testing, use POST /api/agents/run (authed) — its no-taskId
 * sweep runs the same runAutoWorker path, and POST /api/agents/analyze +
 * POST /api/agents/review expose the monitor + report steps individually.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied =
    request.headers.get('x-cron-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // Accounts with a co-founder AI agent that is enabled. Careful: do
  // NOT select the encrypted key blob — the AI config layer
  // (= loadAiConfig) resolves the account's own keys from the key store.
  const { data: coFounders, error } = await admin
    .from('ai_agents')
    .select('id, account_id')
    .eq('role', 'co_founder')
    .eq('is_enabled', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!coFounders || coFounders.length === 0) {
    return NextResponse.json({ processed: 0, accounts: [] })
  }

  const accounts = []
  let processed = 0
  for (const c of coFounders) {
    const accountId = c.account_id as string
    const account: Record<string, unknown> = { accountId, coFounderId: c.id }
    try {
      // 1. Co-Founder monitoring loop: fresh business analysis + delegate.
      const outcome = await runCoFounderAnalysis(
        admin,
        accountId,
        '', // autonomous mode: no user directive, let the model set agenda
      )
      const delegation = await delegateGeneratedTasks(
        admin,
        accountId,
        c.id as string,
        outcome.tasks,
      )
      await logActivity(
        admin,
        accountId,
        c.id as string,
        'autonomous_analysis',
        'Autonomous business analysis (scheduled)',
        {
          recommendationCount: outcome.recommendations.length,
          delegatedTasks: delegation.created,
        },
      )
      account.monitor = { recommendationCount: outcome.recommendations.length, delegatedTasks: delegation.created }

      // 2. AI Employee sweep: execute every open task with LLM
      // tool-selection + deterministic executor (claim-guarded so a task
      // never runs twice concurrently).
      const runs = await runAutoWorker(admin, accountId, { useAi: true })
      account.runs = runs.map((r) => ({
        taskId: r.taskId,
        status: r.status,
        summary: r.summary,
      }))

      // 3 & 4. Escalation surfaces + owner report: the Co-Founder reviews
      // recent task outcomes (done / blocked / escalated / open) and
      // prepares an owner-facing report.
      const review = await coFounderReview(admin, accountId, c.id as string)
      account.review = review.summary

      // Bump the monitor timestamp so the UI can show recency.
      await admin
        .from('ai_agents')
        .update({ last_monitor_run_at: new Date().toISOString() })
        .eq('id', c.id)
      accounts.push(account)
      processed++
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error'
      account.error = message
      accounts.push(account)
      await admin
        .from('ai_agents')
        .update({ last_monitor_error: message })
        .eq('id', c.id)
    }
  }

  return NextResponse.json({ processed, accounts })
}
