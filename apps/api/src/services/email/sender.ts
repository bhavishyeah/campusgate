/**
 * Provider-agnostic transactional email seam. Mirrors the shape of
 * services/documents/storage.ts: an interface, concrete adapters, a lazy
 * singleton (`getEmailSender`) and a test seam (`setEmailSender`).
 *
 * Routes call `getEmailSender()`; nothing else knows which provider is behind it.
 * The API key is only ever used as a request header and never logged.
 */
export interface EmailMessage {
  to: { email: string };
  subject: string;
  html: string;
  text: string;
  tag?: string;
}

export type EmailFailureReason =
  | "NOT_CONFIGURED"
  | "PROVIDER_LIMIT"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE";

export class EmailSendError extends Error {
  constructor(
    public reason: EmailFailureReason,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface EmailSender {
  readonly kind: "brevo" | "console" | "memory" | "unconfigured";
  isConfigured(): boolean;
  send(m: EmailMessage): Promise<{ messageId?: string }>;
}

/** Captures messages for assertions. Prints nothing. */
export class InMemoryEmailSender implements EmailSender {
  readonly kind = "memory" as const;
  readonly sent: EmailMessage[] = [];
  failWith: EmailSendError | null = null;
  isConfigured(): boolean {
    return true;
  }
  async send(m: EmailMessage): Promise<{ messageId?: string }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(m);
    return { messageId: `mem-${this.sent.length}` };
  }
}

/** Development only. Hides the link unless EMAIL_DEV_PRINT_LINKS=true. */
export class ConsoleEmailSender implements EmailSender {
  readonly kind = "console" as const;
  isConfigured(): boolean {
    return true;
  }
  async send(m: EmailMessage): Promise<{ messageId?: string }> {
    const showLinks = process.env.EMAIL_DEV_PRINT_LINKS === "true";
    const text = showLinks ? m.text : m.text.replace(/https?:\/\/\S+/g, "[link hidden, set EMAIL_DEV_PRINT_LINKS=true]");
    // eslint-disable-next-line no-console
    console.log(`[email:dev] to=${m.to.email} subject="${m.subject}"\n${text}`);
    return {};
  }
}

let warnedUnconfigured = false;

/** Used whenever no real sender is available. Never throws at boot. */
export class UnconfiguredEmailSender implements EmailSender {
  readonly kind = "unconfigured" as const;
  constructor(private readonly reason = "BREVO_API_KEY and EMAIL_FROM are not set") {}
  isConfigured(): boolean {
    return false;
  }
  async send(_m: EmailMessage): Promise<{ messageId?: string }> {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(`[email] sender not configured: ${this.reason}`);
    }
    throw new EmailSendError("NOT_CONFIGURED", "Email sender is not configured");
  }
}
