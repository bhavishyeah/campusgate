import { BrevoEmailSender } from "./brevo.js";
import {
  ConsoleEmailSender,
  InMemoryEmailSender,
  UnconfiguredEmailSender,
  type EmailSender,
} from "./sender.js";
import { frontendOrigin } from "./templates.js";

export * from "./sender.js";
export { BrevoEmailSender } from "./brevo.js";
export * from "./templates.js";

/**
 * Selection (design 7.1). Only NODE_ENV exactly "development" or "test" are
 * non-production values. NODE_ENV unset, "staging", a typo: all behave like
 * production and never fall back to the console sender. No boot-time throw.
 */
export function createEmailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const key = env.BREVO_API_KEY;
  const from = env.EMAIL_FROM;
  const nodeEnv = env.NODE_ENV;
  const devOrTest = nodeEnv === "development" || nodeEnv === "test";

  if (key && from) {
    // A real sender needs a usable FRONTEND_URL origin outside dev/test: links must not point at localhost.
    if (!devOrTest && !frontendOrigin(env)) {
      return new UnconfiguredEmailSender("FRONTEND_URL is not set");
    }
    return new BrevoEmailSender(key, from, env.EMAIL_FROM_NAME || "CampusGate");
  }
  if (nodeEnv === "test" || env.VITEST) return new InMemoryEmailSender();
  if (nodeEnv === "development" && !env.RAILWAY_ENVIRONMENT) return new ConsoleEmailSender();

  const missing = !key && !from ? "BREVO_API_KEY and EMAIL_FROM are not set" : !key ? "BREVO_API_KEY is not set" : "EMAIL_FROM is not set";
  return new UnconfiguredEmailSender(missing);
}

let singleton: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (!singleton) singleton = createEmailSenderFromEnv();
  return singleton;
}

/** Test seam: pass a stub, or null to reset to env-based selection. */
export function setEmailSender(s: EmailSender | null): void {
  singleton = s;
}
