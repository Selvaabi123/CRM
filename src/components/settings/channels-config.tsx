"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Camera,
  MessageCircle,
  Mail,
  Globe,
  Loader2,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Channel } from "@/types";

interface ChannelConfig {
  id: string;
  channel: Exclude<Channel, "whatsapp">;
  is_enabled: boolean;
  connected_at: string | null;
  last_error: string | null;
  endpoint: string | null;
  account_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FieldMeta {
  key: string;
  label: string;
  placeholder: string;
  type?: "text" | "password" | "number";
  options?: { value: string; label: string }[];
}

const CHANNEL_META: Record<
  Exclude<Channel, "whatsapp">,
  { label: string; icon: typeof Mail; hint: string; fields: FieldMeta[] }
> = {
  instagram: {
    label: "Instagram",
    icon: Camera,
    hint: "Instagram business account messaging.",
    fields: [
      { key: "instagramBusinessAccountId", label: "Instagram Business Account ID", placeholder: "e.g. 17841400000000000" },
      { key: "accessToken", label: "Access token", type: "password", placeholder: "Paste a Meta user/page access token" },
      { key: "verifyToken", label: "Verify token", placeholder: "A secret token you set in the Meta webhook config" },
    ],
  },
  messenger: {
    label: "Facebook Messenger",
    icon: MessageCircle,
    hint: "Facebook Page messaging via Messenger.",
    fields: [
      { key: "pageId", label: "Page ID", placeholder: "e.g. 1234567890" },
      { key: "pageAccessToken", label: "Page access token", type: "password", placeholder: "Paste your Page access token" },
      { key: "verifyToken", label: "Verify token", placeholder: "A secret token you set in the Meta webhook config" },
    ],
  },
  email: {
    label: "Email",
    icon: Mail,
    hint: "Shared inbox mailbox (SMTP/IMAP).",
    fields: [
      { key: "mailboxEmail", label: "Mailbox email", placeholder: "support@example.com" },
      { key: "imapHost", label: "IMAP host", placeholder: "imap.example.com" },
      { key: "imapUser", label: "IMAP username", placeholder: "support@example.com" },
      { key: "imapPass", label: "IMAP password", type: "password", placeholder: "••••••••" },
      { key: "smtpHost", label: "SMTP host", placeholder: "smtp.example.com" },
      { key: "smtpPort", label: "SMTP port", type: "number", placeholder: "587" },
      {
        key: "smtpSecure",
        label: "SMTP security",
        type: "text",
        placeholder: "false",
        options: [
          { value: "", label: "Auto (use 465/587)" },
          { value: "true", label: "TLS (implicit/SSL, usually 465)" },
          { value: "false", label: "STARTTLS (usually 587)" },
        ],
      },
      { key: "subjectPrefix", label: "Subject prefix", placeholder: "[Support]" },
    ],
  },
  webchat: {
    label: "Website Live Chat",
    icon: Globe,
    hint: "Embeddable live chat widget for your website.",
    fields: [],
  },
};

function formatTime(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

export function ChannelsConfig() {
  const { accountRole } = useAuth();
  const admin = accountRole ? canEditSettings(accountRole) : false;
  const [configs, setConfigs] = useState<ChannelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/channels");
      const json = await res.json();
      if (Array.isArray(json.data)) setConfigs(json.data);
    } catch {
      // Swallow — the retry is manual via Save / remount.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byChannel = (ch: Exclude<Channel, "whatsapp">) =>
    configs.find((c) => c.channel === ch);

  const save = async (ch: Exclude<Channel, "whatsapp">) => {
    setSaving((s) => ({ ...s, [ch]: true }));
    const cfg = byChannel(ch);
    const fields = values[ch] ?? {};
    // Convert number/select fields to the right primitive before storing.
    const config: Record<string, unknown> = {};
    for (const f of CHANNEL_META[ch].fields) {
      const raw = (fields[f.key] ?? "").trim();
      if (!raw) continue;
      if (f.type === "number") config[f.key] = Number(raw);
      else if (f.key === "smtpSecure") config[f.key] = raw === "true";
      else config[f.key] = raw;
    }
    const hasTokens =
      Object.keys(config).length > 0 || CHANNEL_META[ch].fields.length === 0;

    // If the user typed no new credentials but a config row already
    // exists (e.g. they only toggled fields / want to re-enable), PATCH
    // so we don't wipe the saved encrypted creds with a POST overwrite.
    const alreadyConfigured = Boolean(cfg?.id);

    const res = await fetch(
      "/api/channels",
      alreadyConfigured && !hasTokens
        ? {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: ch, is_enabled: true }),
          }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: ch,
              config: hasTokens ? config : undefined,
              is_enabled: true,
            }),
          },
    );
    const json = await res.json().catch(() => ({}));
    setSaving((s) => ({ ...s, [ch]: false }));
    if (!json.error) {
      setSaved((s) => ({ ...s, [ch]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [ch]: false })), 2000);
      if (hasTokens) toast.success(`${CHANNEL_META[ch].label} config saved`);
    } else {
      toast.error(json.error || "Failed to save");
    }
    await refresh();
    // Dim the secret inputs after save (they're never echoed back).
    if (hasTokens) setValues((v) => ({ ...v, [ch]: {} }));
  };

  const toggle = async (
    ch: Exclude<Channel, "whatsapp">,
    enabled: boolean,
  ) => {
    setToggling((t) => ({ ...t, [ch]: true }));
    const res = await fetch("/api/channels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: ch, is_enabled: enabled }),
    });
    const json = await res.json().catch(() => ({}));
    setToggling((t) => ({ ...t, [ch]: false }));
    if (json.error) {
      toast.error(json.error || "Failed to update");
    } else {
      toast.success(`${CHANNEL_META[ch].label} ${enabled ? "enabled" : "disabled"}`);
    }
    await refresh();
  };

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1800);
    } catch {
      toast.error("Copy failed");
    }
  };

  // Build a copyable webchat embed snippet for connected webchat accounts.
  const webchatEmbed = (
    accountId: string | null,
    base: string | null,
  ): string | null => {
    if (!accountId || !base) return null;
    const origin = base.replace(/\/api\/webchat\/widget\.js\?account=.*$/, "");
    return (
      `<script>\n` +
      `  (function(w){w.__wacrmCfg={accountId:'${accountId}',base:'${origin}'};\n` +
      `  var s=document.createElement('script');s.async=1;\n` +
      `  s.src=w.__wacrmCfg.base+'/api/webchat/widget.js?account='+w.__wacrmCfg.accountId+'&base='+encodeURIComponent(w.__wacrmCfg.base);\n` +
      `  document.body.appendChild(s);})(window);\n` +
      `</script>`
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading channels...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Omnichannel</h2>
        <p className="text-sm text-muted-foreground">
          Connect more channels so every customer conversation lands in one unified inbox.
          WhatsApp is configured separately under WhatsApp.
        </p>
      </div>

      {(Object.keys(CHANNEL_META) as Exclude<Channel, "whatsapp">[]).map((ch) => {
        const meta = CHANNEL_META[ch];
        const Icon = meta.icon;
        const cfg = byChannel(ch);
        const connected = cfg?.is_enabled && Boolean(cfg?.connected_at);
        return (
          <Card key={ch}>
            <CardHeader className="flex flex-row items-center gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <CardTitle className="flex items-center gap-2">
                  {meta.label}
                  {connected ? (
                    <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">Connected</Badge>
                  ) : cfg?.is_enabled ? (
                    <Badge variant="outline">Enabled</Badge>
                  ) : (
                    <Badge variant="outline">Disabled</Badge>
                  )}
                  {admin && (
                    <Switch
                      checked={Boolean(cfg?.is_enabled)}
                      disabled={Boolean(toggling[ch])}
                      onCheckedChange={(v) => void toggle(ch, v)}
                    />
                  )}
                </CardTitle>
                <CardDescription>{meta.hint}</CardDescription>
                {cfg?.last_error && cfg.is_enabled && (
                  <p className="mt-1 text-xs text-red-400">
                    Last error: {cfg.last_error}
                  </p>
                )}
                {connected && cfg?.connected_at && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Connected {formatTime(cfg.connected_at)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {admin && (
                  <Button size="sm" onClick={() => save(ch)} disabled={saving[ch]}>
                    {saving[ch] ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : saved[ch] ? <CheckCircle2 className="mr-1.5 h-4 w-4 text-emerald-400" /> : null}
                    Save
                  </Button>
                )}
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              {ch === "webchat" ? (
                cfg?.endpoint ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Enable the webchat, then paste this snippet before{" "}
                      <code className="text-foreground">&lt;/body&gt;</code> on your site.
                    </p>
                    <div className="flex items-start gap-2">
                      <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                        {webchatEmbed(cfg.account_id, cfg.endpoint)}
                      </pre>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          copyText(webchatEmbed(cfg.account_id, cfg.endpoint) ?? "", "wc")
                        }
                      >
                        {copied === "wc" ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Save this channel to enable the webchat and reveal your embed snippet.
                  </p>
                )
              ) : (
                <div className="space-y-3">
                  {meta.fields.map((f) => (
                    <div key={f.key} className="space-y-1.5">
                      <Label htmlFor={`${ch}-${f.key}`}>{f.label}</Label>
                      {f.options ? (
                        <select
                          id={`${ch}-${f.key}`}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                          value={values[ch]?.[f.key] ?? ""}
                          onChange={(e) =>
                            setValues((v) => ({
                              ...v,
                              [ch]: { ...(v[ch] ?? {}), [f.key]: e.target.value },
                            }))
                          }
                          disabled={!admin}
                        >
                          {f.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={`${ch}-${f.key}`}
                          type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                          placeholder={f.placeholder}
                          value={values[ch]?.[f.key] ?? ""}
                          onChange={(e) =>
                            setValues((v) => ({
                              ...v,
                              [ch]: { ...(v[ch] ?? {}), [f.key]: e.target.value },
                            }))
                          }
                          disabled={!admin}
                        />
                      )}
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Stored credentials are encrypted and never returned by the API;
                    re-enter them to rotate. Fields left blank are kept as-is on save.
                  </p>
                </div>
              )}

              {cfg?.endpoint && ch !== "webchat" && (
                <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    {ch === "email" ? "Poll endpoint:" : "Webhook endpoint:"}
                  </span>
                  <code className="flex-1 truncate text-xs">{cfg.endpoint}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => copyText(cfg.endpoint ?? "", ch)}
                  >
                    {copied === ch ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

