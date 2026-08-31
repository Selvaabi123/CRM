// ============================================================
// Business intelligence context — the raw numbers the AI Co-Founder
// reasons over. Every read is account-scoped; call with the service
// role (or RLS) client. Best-effort: one failing aggregate never
// blocks the Co-Founder from seeing the rest.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessSnapshot {
  contacts: { total: number; new30d: number }
  conversations: { open: number; pending: number; closed: number; total: number }
  messages: { total: number; inbound30d: number; outbound30d: number }
  deals: { open: number; won: number; openValue: number; wonValue: number }
  broadcasts: { total: number; failed: number }
  automations: { total: number; active: number }
  flows: { total: number; active: number }
  team: { members: number }
  generatedAt: string
}

async function count(
  db: SupabaseClient,
  table: string,
  accountId: string,
  extra?: { column: string; value: unknown },
): Promise<number> {
  let q = db.from(table).select('id', { count: 'exact', head: true }).eq('account_id', accountId)
  if (extra) q = q.eq(extra.column, extra.value)
  const { count, error } = await q
  return error ? 0 : (count ?? 0)
}

async function sumValue(db: SupabaseClient, accountId: string, status: string): Promise<number> {
  const { data, error } = await db
    .from('deals')
    .select('value')
    .eq('account_id', accountId)
    .eq('status', status)
  if (error) return 0
  return (data ?? []).reduce((acc, d) => acc + Number(d.value || 0), 0)
}

async function countWhereTimestamp(
  db: SupabaseClient,
  table: string,
  accountId: string,
  column: string,
  since: string,
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte(column, since)
  return error ? 0 : (count ?? 0)
}

/**
 * Compose a compact, business-level snapshot for the Co-Founder to
 * reason over. Failures degrade to zeroes rather than throwing.
 */
export async function buildBusinessSnapshot(
  db: SupabaseClient,
  accountId: string,
): Promise<BusinessSnapshot> {
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

  // `messages` is not account-keyed — it scopes through its parent
  // conversation. Resolve the account's conversation ids up front, then
  // count messages against them.
  const convRes = await db.from('conversations').select('id').eq('account_id', accountId)
  const convIds = (convRes.data ?? []).map((c) => c.id)

  let msgTotal = 0
  let inbound30 = 0
  let outbound30 = 0
  if (convIds.length) {
    const t = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', convIds)
    msgTotal = t.count ?? 0
    const inb = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', convIds)
      .eq('sender_type', 'customer')
      .gte('created_at', since30)
    const out = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('conversation_id', convIds)
      .in('sender_type', ['agent', 'bot'])
      .gte('created_at', since30)
    inbound30 = inb.count ?? 0
    outbound30 = out.count ?? 0
  }

  const [contactsTotal, contactsNew30, convOpen, convPending, convClosed, dealsOpen, dealsWon, broadcastsTotal, broadcastsFailed, automationsTotal, automationsActive, flowsTotal, flowsActive, teamMembers, dealsOpenValue, dealsWonValue] =
    await Promise.all([
      count(db, 'contacts', accountId),
      countWhereTimestamp(db, 'contacts', accountId, 'created_at', since30),
      count(db, 'conversations', accountId, { column: 'status', value: 'open' }),
      count(db, 'conversations', accountId, { column: 'status', value: 'pending' }),
      count(db, 'conversations', accountId, { column: 'status', value: 'closed' }),
      count(db, 'deals', accountId, { column: 'status', value: 'open' }),
      count(db, 'deals', accountId, { column: 'status', value: 'won' }),
      count(db, 'broadcasts', accountId),
      count(db, 'broadcasts', accountId, { column: 'status', value: 'failed' }),
      count(db, 'automations', accountId),
      count(db, 'automations', accountId, { column: 'is_active', value: true }),
      count(db, 'flows', accountId),
      count(db, 'flows', accountId, { column: 'status', value: 'active' }),
      count(db, 'profiles', accountId, undefined),
      sumValue(db, accountId, 'open'),
      sumValue(db, accountId, 'won'),
    ])

  return {
    contacts: { total: contactsTotal, new30d: contactsNew30 },
    conversations: { open: convOpen, pending: convPending, closed: convClosed, total: convOpen + convPending + convClosed },
    messages: { total: msgTotal, inbound30d: inbound30, outbound30d: outbound30 },
    deals: { open: dealsOpen, won: dealsWon, openValue: dealsOpenValue, wonValue: dealsWonValue },
    broadcasts: { total: broadcastsTotal, failed: broadcastsFailed },
    automations: { total: automationsTotal, active: automationsActive },
    flows: { total: flowsTotal, active: flowsActive },
    team: { members: teamMembers },
    generatedAt: new Date().toISOString(),
  }
}
