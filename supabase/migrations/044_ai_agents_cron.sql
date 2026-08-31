-- ============================================================
-- 044_ai_agents_cron.sql — add fields used by the scheduled
-- Co-Founder monitor loop (and the Agent Org enable/disable UI).
--
--   is_enabled          : hard on/off for an AI agent. The cron loop
--                         only analyses accounts whose co-founder has
--                         is_enabled = true.
--   last_monitor_run_at : recency stamp so the Agent Org page can show
--                         "analyzed N minutes ago".
--   last_monitor_error  : most recent error from the monitor loop, so a
--                         misconfigured key/model surfaces in the UI
--                         instead of failing silently.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_monitor_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_monitor_error TEXT;
