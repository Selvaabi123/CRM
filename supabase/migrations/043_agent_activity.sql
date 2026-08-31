-- ============================================================
-- 043_agent_activity.sql — AI agent activity history
--
-- An append-only log of what each AI agent did: delegated a task,
-- completed one, escalated, sent a message, changed a deal, ran an
-- analysis, posted a report to the owner. The org page renders this
-- as "Activity history" and the Co-Founder monitor reads it to stay
-- aware of what its reports are doing.
--
-- Append-only on purpose: the RLS policy permits SELECT + INSERT but
-- no UPDATE/DELETE, so history is tamper-resistant from the client.
-- The service-role (app) path may delete old rows if pruning is ever
-- added.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,

  -- What kind of thing happened. Stable machine-readable keys:
  -- task_delegated, task_completed, task_escalated, report_sent,
  -- message_sent, deal_updated, analysis_run, goal_created, ...
  type TEXT NOT NULL,

  -- Human-readable one-liner shown in the activity feed.
  summary TEXT NOT NULL,

  -- Structured context (task id, deal id, message id, tool used...).
  metadata JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_account ON agent_activity_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_agent   ON agent_activity_log(agent_id, created_at DESC);

ALTER TABLE agent_activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_activity_select ON agent_activity_log;
DROP POLICY IF EXISTS agent_activity_insert ON agent_activity_log;
DROP POLICY IF EXISTS agent_activity_update ON agent_activity_log;
DROP POLICY IF EXISTS agent_activity_delete ON agent_activity_log;
CREATE POLICY agent_activity_select ON agent_activity_log FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY agent_activity_insert ON agent_activity_log FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

COMMENT ON TABLE agent_activity_log IS
  'Append-only audit trail of AI agent actions, rendered as activity '
  'history on the Agent Organization page.';
