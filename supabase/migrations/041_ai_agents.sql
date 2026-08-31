-- ============================================================
-- 041_ai_agents.sql — AI Co-Founder + AI Employees
--
-- The business-owner-level AI Co-Founder and the specialized AI
-- Employees (Sales, Marketing, Support, Operations, Social, Finance,
-- HR, or owner-created custom roles) all live in one table with a
-- self-referencing manager_id forming the org tree:
--
--   Business Owner
--   └── AI Co-Founder (manager_id = NULL, top of the tree)
--       ├── Sales AI
--       ├── Marketing AI
--       ├── Support AI
--       └── ... custom AI Employees
--
-- Design notes:
--   - `role` distinguishes the Co-Founder from employees. Exactly one
--     co_founder per account is enforced via a partial unique index
--     (a second Co-Founder would silently fork the org tree and
--     confuse both delegation and reporting).
--   - `instructions` is the free-form system prompt (+ any owner
--     customisation for custom roles). `responsibilities` is a
--     structured list so the UI and the Co-Founder can enumerate what
--     an employee does.
--   - `tools` is the allow-list of capabilities the agent may use
--     (e.g. ['send_whatsapp','broadcast','pipeline','webhook']),
--     matching the "Connected tools" requirement.
--   - `status` lets the owner pause an employee without deleting it.
--   - `reports_to` is denormalised from manager_id for the "reports
--     to its manager" display card; kept in sync by the app (or left
--     to be a plain mirror).
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_agent_role_enum') THEN
    CREATE TYPE ai_agent_role_enum AS ENUM (
      'co_founder', 'sales', 'marketing', 'support',
      'operations', 'social', 'finance', 'hr', 'custom'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_agent_status_enum') THEN
    CREATE TYPE ai_agent_status_enum AS ENUM ('active', 'paused');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role ai_agent_role_enum NOT NULL DEFAULT 'custom',

  -- Short human label, e.g. "Sales AI". Falls back to name for custom
  -- roles that carry no distinct title.
  title TEXT,

  -- System prompt / operating instructions for the agent. For custom
  -- employees this is generated from the owner's free-text job
  -- description at creation time, then editable afterwards.
  instructions TEXT,

  -- Structured responsibilities (array). Rendered on the org card and
  -- fed to the Co-Founder so it knows what to delegate.
  responsibilities TEXT[] NOT NULL DEFAULT '{}',

  -- Capabilities this agent may invoke. Must be a subset of the
  -- registry the server understands; unknown entries are ignored at
  -- execution time (defence in depth).
  tools TEXT[] NOT NULL DEFAULT '{}',

  -- Org tree. NULL = top of the tree (the Co-Founder).
  manager_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,

  -- Denormalised mirror of manager_id for quick reads / display.
  reports_to UUID REFERENCES ai_agents(id) ON DELETE SET NULL,

  status ai_agent_status_enum NOT NULL DEFAULT 'active',

  -- Owner-provided free-text job description (custom roles).
  job_description TEXT,

  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One Co-Founder per account (partial unique index on active rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_agents_one_cofounder
  ON ai_agents(account_id) WHERE role = 'co_founder';

CREATE INDEX IF NOT EXISTS idx_ai_agents_account ON ai_agents(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_manager ON ai_agents(manager_id);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

-- ----- RLS: settings-class (admin+ for create/update/delete) ------
DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
DROP POLICY IF EXISTS ai_agents_insert ON ai_agents;
DROP POLICY IF EXISTS ai_agents_update ON ai_agents;
DROP POLICY IF EXISTS ai_agents_delete ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY ai_agents_insert ON ai_agents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ai_agents_update ON ai_agents FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY ai_agents_delete ON ai_agents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_agents;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Seed helper RPC: ensure_aico_founder(account_id)
--
-- Creates the Co-Founder for an account if one doesn't already
-- exist. Called lazily (first time the owner opens the Agent
-- Organization page). SECURITY DEFINER + dynamic account so the
-- service-role admin client can seed it without a user session.
-- ============================================================
CREATE OR REPLACE FUNCTION ensure_aico_founder(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing UUID;
  v_created UUID;
BEGIN
  SELECT id INTO v_existing FROM ai_agents
   WHERE account_id = p_account_id AND role = 'co_founder' LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO ai_agents (account_id, name, role, title, instructions, responsibilities, tools)
  VALUES (
    p_account_id,
    'AI Co-Founder',
    'co_founder',
    'AI Co-Founder',
    E'You are the AI Co-Founder of this business. You act as the top-level business assistant.\n\nYour duties:\n- Understand the entire business (customers, sales, marketing, operations, support).\n- Monitor business activity and performance.\n- Analyze sales, customers, marketing, operations, and support.\n- Give recommendations to the owner.\n- Create goals and tasks for yourself and for the AI employees below you.\n- Delegate work to your AI employees and monitor their progress.\n- Escalate important problems and opportunities to the business owner.\n\nYou answer to the business owner only. You manage every other AI Employee.',
    ARRAY['Monitor business performance across all modules',
          'Give strategic recommendations to the owner',
          'Create goals and delegate tasks to AI employees',
          'Monitor progress of AI employees and escalate issues'],
    ARRAY['analyze', 'report', 'delegate', 'review']
  )
  RETURNING id INTO v_created;

  RETURN v_created;
END;
$$;

ALTER FUNCTION ensure_aico_founder(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION ensure_aico_founder(UUID) TO service_role;
