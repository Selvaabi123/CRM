// ============================================================
// Email channel — outbound SMTP send + inbound IMAP poll.
//
// Credentials live in `channel_configs.config` (encrypted):
//   imapHost, imapUser, imapPass          (inbound IMAP)
//   smtpHost, smtpPort, smtpSecure        (outbound SMTP; smtpHost
//                                          defaults to imapHost)
//   mailboxEmail                          (the address messages arrive
//                                          at / are sent from)
//   subjectPrefix                         (optional prefix on replies)
//
// Uses nodemailer (SMTP) and imapflow (IMAP). Both are stateful client
// libraries, so the inbound poller opens a short-lived connection per
// account per run rather than holding a long-lived socket.
// ============================================================

import nodemailer from 'nodemailer';

export interface EmailConfig {
  imapHost?: string;
  imapUser?: string;
  imapPass?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  mailboxEmail?: string;
  subjectPrefix?: string;
  [key: string]: unknown;
}

export interface EmailSendInput {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailSendResult {
  messageId: string | null;
}

/** Send an outbound email reply via SMTP. Returns the provider Message-Id. */
export async function sendEmailViaSMTP(
  config: EmailConfig,
  input: EmailSendInput,
): Promise<EmailSendResult> {
  const host = config.smtpHost || config.imapHost;
  const user = config.imapUser;
  const pass = config.imapPass;
  if (!host || !user || !pass) {
    throw new Error('Email SMTP not fully configured');
  }

  const port = Number(config.smtpPort ?? 587);
  const secure = config.smtpSecure ?? port === 465;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const from = input.from || `${user}`;
  const info = await transporter.sendMail({
    from,
    to: input.to,
    subject: `${config.subjectPrefix ? config.subjectPrefix + ' ' : ''}${input.subject}`,
    text: input.text,
  });

  // info.messageId is like "<abc@host>" — store it verbatim; the unique
  // index (conversation_id, message_id) will dedupe on it if needed.
  return { messageId: info.messageId ?? null };
}
