import { EmailSendError, type EmailMessage, type EmailSender } from "./sender.js";

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * Brevo transactional email via the REST API (global fetch, no SDK).
 * No retries: a retry could double-send and burn the daily budget.
 * Logs never include the request body, the key, or the provider response body.
 */
export class BrevoEmailSender implements EmailSender {
  readonly kind = "brevo" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly fromName: string = "CampusGate",
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async send(m: EmailMessage): Promise<{ messageId?: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(BREVO_URL, {
        method: "POST",
        headers: {
          "api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender: { email: this.fromEmail, name: this.fromName },
          to: [{ email: m.to.email }],
          subject: m.subject,
          htmlContent: m.html,
          textContent: m.text,
          ...(m.tag ? { tags: [m.tag] } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EmailSendError("PROVIDER_UNAVAILABLE", "Email provider unreachable");
    }

    if (res.ok) {
      try {
        const body = (await res.json()) as { messageId?: string };
        return { messageId: body.messageId };
      } catch {
        return {};
      }
    }

    // Only the status and Brevo's `code` field are surfaced, never the body text.
    let code: string | undefined;
    try {
      const body = (await res.json()) as { code?: string };
      if (typeof body.code === "string") code = body.code.slice(0, 64);
    } catch {
      /* ignore */
    }
    const suffix = code ? ` (${code})` : "";
    if (res.status === 402 || res.status === 429) {
      throw new EmailSendError("PROVIDER_LIMIT", `Email provider limit, status ${res.status}${suffix}`, res.status);
    }
    if (res.status >= 400 && res.status < 500) {
      throw new EmailSendError("PROVIDER_REJECTED", `Email provider rejected the request, status ${res.status}${suffix}`, res.status);
    }
    throw new EmailSendError("PROVIDER_UNAVAILABLE", `Email provider error, status ${res.status}${suffix}`, res.status);
  }
}
