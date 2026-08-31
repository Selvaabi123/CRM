-- ============================================================
-- 045_omnichannel_contacts.sql
--
-- Make the unified customer record channel-aware so one CRM account
-- can hold conversations on Instagram, Messenger, Email and Website
-- Chat alongside WhatsApp — all reusing the same `contacts` /
-- `conversations` / `messages` tables (no separate inbox systems).
--
-- Model decision: a *contact row is channel-scoped*. A WhatsApp
-- customer and an Instagram customer are two rows (keyed by their
-- different external identities); merging cross-channel identities
-- into a single master record is left for a later "identity graph"
-- feature. This keeps the existing WhatsApp path — which resolves
-- contacts purely by phone/postgres-generated `phone_normalized`
-- (migration 022) and creates one conversation per (account, contact)
-- (migration 036) — completely untouched.
--
-- Changes here:
--   1. `contacts.channel`              — which channel owns this contact
--      (defaults to 'whatsapp', so existing rows are automatically
--      WhatsApp and every existing insert path stays valid).
--   2. `contacts.channel_external_id`  — the provider's remote user
--      identifier: Instagram IG-scoped user id, Messenger PSID, the
--      contact's email (email channel), or a webchat session token.
--      NULL for WhatsApp (which identifies by phone).
--   3. A partial UNIQUE index
--        (account_id, channel, channel_external_id)
--      WHERE channel <> 'whatsapp'  AND channel_external_id IS NOT NULL
--      — the dedupe guarantee for the new channels, mirroring the
--      phone-normalized unique index (migration 022) WhatsApp relies on.
--
-- `contacts.phone` remains NOT NULL: for non-phone channels we still
-- insert a row (the column is mandatory) using a stable, DIGIT-FREE
-- synthetic value. Because it contains no digits, `phone_normalized`
-- (generated: strip non-digits) evaluates to '' and the row is excluded
-- from the Google of WhatsApp's `(account_id, phone_normalized)` unique
-- index (which is `WHERE phone_normalized <> ''`), so these rows can
-- never collide with a real phone or with each other. They are instead
-- uniquely guarded by the new channel index above.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel channel_enum NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS channel_external_id TEXT;

-- Dedupe guarantee for the non-phone channels. WhatsApp rows are
-- excluded (they use channel_external_id = NULL + phone instead).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_channel_external_id
  ON contacts (account_id, channel, channel_external_id)
  WHERE channel <> 'whatsapp' AND channel_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_channel ON contacts(channel);
