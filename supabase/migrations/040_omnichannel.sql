-- ============================================================
-- 040_omnichannel.sql — Omnichannel foundation
--
-- wacrm was WhatsApp-only: every conversation and message is
-- implicitly WhatsApp. This migration makes the chat layer
-- channel-aware without disturbing the WhatsApp code path.
--
-- Changes:
--   1. `conversations.channel` — which channel a conversation lives
--      on. Backfilled to 'whatsapp' so existing rows never break,
--      with a single partial index on the channel-unique switch.
--   2. `messages.channel` — denormalised from the conversation so
--      broadcast/automation sends and the unified inbox filter can
--      read messages without always joining. Backfilled the same way.
--   3. `channel_configs` — per-account, per-channel credential
--      storage. WhatsApp keeps using `whatsapp_config` (it predates
--      this and has registration state + encryption specifics), so
--      this table is for the NEW channels: instagram, messenger,
--      email, webchat. Credentials are stored encrypted by the app
--      (AES-256-GCM with ENCRYPTION_KEY), so the columns are simply
--      JSONB payloads the server encrypts before writing — never
--      plaintext connection details in the DB.
--
-- Idempotent — safe to re-run. Follows the house style of
-- migration 017 (nullable column -> backfill -> NOT NULL).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_enum') THEN
    CREATE TYPE channel_enum AS ENUM (
      'whatsapp', 'instagram', 'messenger', 'email', 'webchat'
    );
  END IF;
END $$;

-- ============================================================
-- 1. conversations.channel
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel channel_enum;

-- Backfill every existing row (WhatsApp-only pre-040 world).
UPDATE conversations SET channel = 'whatsapp' WHERE channel IS NULL;

ALTER TABLE conversations ALTER COLUMN channel SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN channel SET DEFAULT 'whatsapp';

-- Partial index: the "one conversation per account+contact" invariant
-- in the WhatsApp path (resolve-conversation uses oldest-first
-- .limit(1)) is WhatsApp-specific. A partial index keeps lookup fast
-- without globally forbidding the same contact on multiple channels.
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(channel) WHERE channel <> 'whatsapp';

-- ============================================================
-- 2. messages.channel
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel channel_enum;

-- Backfill from the owning conversation. Pure column default won't
-- handle pre-existing rows, so copy from the relationship once.
UPDATE messages m SET channel = c.channel
FROM conversations c
WHERE m.conversation_id = c.id
  AND m.channel IS NULL;

ALTER TABLE messages ALTER COLUMN channel SET NOT NULL;
ALTER TABLE messages ALTER COLUMN channel SET DEFAULT 'whatsapp';

CREATE INDEX IF NOT EXISTS idx_messages_channel
  ON messages(channel) WHERE channel <> 'whatsapp';

-- New rows inherit the channel from their parent conversation even if
-- a caller forgets to set it. Keep the enum constraint intact; the
-- conversation.channel is the source of truth at insert time.
CREATE OR REPLACE FUNCTION messages_default_channel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.channel IS NULL THEN
    SELECT channel INTO NEW.channel FROM conversations WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_default_channel_trigger ON messages;
CREATE TRIGGER messages_default_channel_trigger
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_default_channel();

-- ============================================================
-- 3. channel_configs — credentials for non-WhatsApp channels
-- ============================================================
CREATE TABLE IF NOT EXISTS channel_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel channel_enum NOT NULL,
  -- The app encrypts the provider credentials (AES-256-GCM with
  -- ENCRYPTION_KEY) and stores the opaque blob here; the server
  -- decrypts at use time. The columns are intentionally nullable —
  -- a "connected" webchat needs no secret, an email needs SMTP creds,
  -- an Instagram/Messenger page needs a token.
  config JSONB,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  connected_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One config per channel per account, mirroring whatsapp_config's
  -- UNIQUE(account_id).
  UNIQUE (account_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_account
  ON channel_configs(account_id);

ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;

-- ----- RLS: settings-class (admin+ writes, all members read) ------
DROP POLICY IF EXISTS channel_configs_select ON channel_configs;
DROP POLICY IF EXISTS channel_configs_insert ON channel_configs;
DROP POLICY IF EXISTS channel_configs_update ON channel_configs;
DROP POLICY IF EXISTS channel_configs_delete ON channel_configs;
CREATE POLICY channel_configs_select ON channel_configs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY channel_configs_insert ON channel_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY channel_configs_update ON channel_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY channel_configs_delete ON channel_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON channel_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channel_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE channel_configs IS
  'Per-account settings for every non-WhatsApp channel. WhatsApp uses '
  'the older whatsapp_config table. The config blob is app-side encrypted.';

-- Clean up the helper trigger function if it's not needed elsewhere
-- (kept defined so a future channel insert path can call it directly).
