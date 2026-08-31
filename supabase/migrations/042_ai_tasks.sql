-- ============================================================
-- 042_ai_tasks.sql — Tasks for the AI organization
--
-- The Co-Founder creates goals and tasks, delegates them to AI
-- Employees, and monitors their progress. Employees complete work,
-- record results, and escalate blocking issues. The owner can also
-- file tasks for any agent (or for the Co-Founder itself) from the
-- org page.
--
-- Status flow (server enforces transitions where it matters):
--   todo -> in_progress -> done
--     \-> blocked -> todo (unblock)  |  any -> cancelled
--
-- Escalation is a boolean the employee flips with an `escalation_note`
-- when it can't finish; the Co-Founder's monitor loop picks those up
-- and either re-delegates or surfaces them to the owner.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_task_status_enum') THEN
    CREATE TYPE ai_task_status_enum AS ENUM (
      'todo', 'in_progress', 'blocked', 'done', 'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_task_priority_enum') THEN
    CREATE TYPE ai_task_priority_enum AS ENUM ('low', 'medium', 'high', 'critical');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- The agent that is supposed to do the work.
  assignee_agent_id UUID NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,

  -- Who handed the task out. NULL for owner-created tasks, otherwise
  -- almost always the Co-Founder.
  created_by_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  title TEXT NOT NULL,
  description TEXT,

  status ai_task_status_enum NOT NULL DEFAULT 'todo',
  priority ai_task_priority_enum NOT NULL DEFAULT 'medium',

  due_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Free-text percentage 0-100 reported by the employee, plus the
  -- human/JSON result payload it posts back.
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  result TEXT,
  result_metadata JSONB,

  -- Escalation back up the tree.
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_note TEXT,
  resolved_by_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,

  -- Optional parent/child (rarely used, kept for goal decomposition).
  parent_task_id UUID REFERENCES ai_tasks(id) ON DELETE CASCADE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_tasks_account        ON ai_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_assignee       ON ai_tasks(assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status         ON ai_tasks(status);
-- Fast lookup for the Co-Founder monitor: which open tasks, per agent.
CREATE INDEX IF NOT EXISTS idx_ai_tasks_open_assignee  ON ai_tasks(assignee_agent_id, status)
  WHERE status IN ('todo', 'in_progress', 'blocked');

ALTER TABLE ai_tasks ENABLE ROW LEVEL SECURITY;

-- RLS: agents+ manage tasks; viewers read. Admin+ not required here
-- because the Co-Founder's own loop needs to be able to write via a
-- service-role client (which bypasses RLS anyway); client-side, the
-- whole team may operate on operational task data.
DROP POLICY IF EXISTS ai_tasks_select ON ai_tasks;
DROP POLICY IF EXISTS ai_tasks_insert ON ai_tasks;
DROP POLICY IF EXISTS ai_tasks_update ON ai_tasks;
DROP POLICY IF EXISTS ai_tasks_delete ON ai_tasks;
CREATE POLICY ai_tasks_select ON ai_tasks FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY ai_tasks_insert ON ai_tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY ai_tasks_update ON ai_tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY ai_tasks_delete ON ai_tasks FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_tasks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE ai_tasks IS
  'Goals and tasks created by the AI Co-Founder (or the owner), '
  'assigned to AI Employees, and monitored through completion.';
