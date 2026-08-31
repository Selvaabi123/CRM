// Minimal ambient types for the `mailparser` package (greenlight v3 /
// nodemailer fork). mailparser v3 ships no bundled TypeScript declarations
// and there is no official @types/mailparser, so we type only the
// surface we use (simpleParser) to keep the import type-safe.
declare module 'mailparser' {
  export interface AddressObject {
    value?: Array<{ address?: string; name?: string }>;
  }

  export interface ParsedMail {
    subject?: string;
    from?: AddressObject;
    to?: AddressObject;
    date?: Date;
    messageId?: string;
    text?: string;
    textAsHtml?: string;
    html?: string | false;
  }

  export function simpleParser(
    stream: import('stream').Readable | Buffer | string,
    options?: Record<string, unknown>,
  ): Promise<ParsedMail>;
}
