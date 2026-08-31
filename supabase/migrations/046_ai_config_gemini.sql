-- ============================================================
-- Add Google Gemini as an AI provider.
--
-- The original provider CHECK on ai_configs (029) only allowed
-- ('openai', 'anthropic'). Postgres names an inline table CHECK
-- constraint `ai_configs_provider_check`; we drop it and re-add it
-- widened to include 'gemini'. Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
  ALTER TABLE ai_configs
    ADD CONSTRAINT ai_configs_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'gemini'));
END $$;
