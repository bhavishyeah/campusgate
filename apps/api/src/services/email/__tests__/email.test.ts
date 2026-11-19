import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrevoEmailSender,
  ConsoleEmailSender,
  EmailSendError,
  buildAccountLink,
  createEmailSenderFromEnv,
  renderActivation,
  renderPasswordReset,
} from "../index.js";

const msg = { to: { email: "a@x.edu" }, subject: "S", html: "<p>h</p>", text: "t", tag: "tag" };

function res(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("BrevoEmailSender", () => {
  it("posts the expected request and returns messageId", async () => {
    const f = vi.fn(async () => res(201, { messageId: "<m1>" }));
    const s = new BrevoEmailSender("KEY", "from@x.edu", "Campus", f as never);
    expect(await s.send(msg)).toEqual({ messageId: "<m1>" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("KEY");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { email: "from@x.edu", name: "Campus" },
      to: [{ email: "a@x.edu" }],
      subject: "S",
      htmlContent: "<p>h</p>",
      textContent: "t",
      tags: ["tag"],
    });
  });

  it.each([
    [402, "PROVIDER_LIMIT"],
    [429, "PROVIDER_LIMIT"],
    [400, "PROVIDER_REJECTED"],
    [401, "PROVIDER_REJECTED"],
    [500, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
  ])("maps status %i to %s without leaking the key or body", async (status, reason) => {
    const s = new BrevoEmailSender("SECRETKEY", "f@x.edu", "C", (async () => res(status, { code: "c1", message: "secret detail" })) as never);
    const err = await s.send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain("SECRETKEY");
    expect(err.message).not.toContain("secret detail");
  });

  it("maps network failure and timeout to PROVIDER_UNAVAILABLE", async () => {
    const s = new BrevoEmailSender("K", "f@x.edu", "C", (async () => { throw new Error("boom"); }) as never);
    expect((await s.send(msg).catch((e) => e)).reason).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("sender selection", () => {
  const e = (o: Record<string, string>) => createEmailSenderFromEnv(o as never).kind;
  it("matrix", () => {
    expect(e({})).toBe("unconfigured");
    expect(e({ NODE_ENV: "staging" })).toBe("unconfigured");
    expect(e({ NODE_ENV: "production" })).toBe("unconfigured");
    expect(e({ NODE_ENV: "development" })).toBe("console");
    expect(e({ NODE_ENV: "development", RAILWAY_ENVIRONMENT: "prod" })).toBe("unconfigured");
    expect(e({ NODE_ENV: "test" })).toBe("memory");
    expect(e({ BREVO_API_KEY: "k", EMAIL_FROM: "f@x.edu", NODE_ENV: "production", FRONTEND_URL: "https://app.x.edu" })).toBe("brevo");
    expect(e({ BREVO_API_KEY: "k", EMAIL_FROM: "f@x.edu", NODE_ENV: "production" })).toBe("unconfigured");
    expect(e({ BREVO_API_KEY: "k", NODE_ENV: "production" })).toBe("unconfigured");
  });
});

describe("ConsoleEmailSender", () => {
  afterEach(() => vi.restoreAllMocks());
  it("hides links unless EMAIL_DEV_PRINT_LINKS=true", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const m = { ...msg, text: "go https://app.x.edu/activate#token=abc" };
    await new ConsoleEmailSender().send(m);
    expect(String(log.mock.calls[0][0])).not.toContain("abc");
    vi.stubEnv("EMAIL_DEV_PRINT_LINKS", "true");
    await new ConsoleEmailSender().send(m);
    vi.unstubAllEnvs();
    expect(String(log.mock.calls[1][0])).toContain("abc");
  });
});

describe("templates", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("reset: institution in subject, expiry, ignore line, escaping, no images", () => {
    const m = renderPasswordReset({ institutionName: 'Evil <b>"College"</b>', link: "https://a.x/reset-password#token=t&x=1", expiresInMinutes: 45 });
    expect(m.subject).toBe('Reset your CampusGate password - Evil <b>"College"</b>');
    expect(m.html).not.toContain("<b>");
    expect(m.html).toContain("&lt;b&gt;");
    expect(m.html).toContain("t&amp;x=1");
    expect(m.html).not.toContain("<img");
    expect(m.text).toContain("expires in 45 minutes");
    expect(m.text).toContain("ignore this email");
    expect(m.text).toContain("https://a.x/reset-password#token=t&x=1");
  });
  it("activation: 72 hours reads as 3 days", () => {
    const m = renderActivation({ institutionName: "Demo", link: "https://a.x/activate#token=t", expiresInHours: 72 });
    expect(m.subject).toBe("Activate your CampusGate account - Demo");
    expect(m.text).toContain("expires in 3 days");
  });
  it("links use the FRONTEND_URL origin and the fragment form", () => {
    vi.stubEnv("FRONTEND_URL", "https://app.x.edu/some/path?q=1");
    expect(buildAccountLink("/reset-password", "a-b_c")).toBe("https://app.x.edu/reset-password#token=a-b_c");
    expect(buildAccountLink("/activate", "t")).toBe("https://app.x.edu/activate#token=t");
    vi.stubEnv("FRONTEND_URL", "");
    expect(buildAccountLink("/activate", "t")).toBeNull();
  });
});
