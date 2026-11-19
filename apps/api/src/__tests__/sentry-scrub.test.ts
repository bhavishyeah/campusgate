import { describe, it, expect } from "vitest";
import { scrubBreadcrumb, scrubEvent, scrubUrlString } from "../sentry-scrub.js";

describe("sentry scrubber", () => {
  it("redacts auth headers, bodies on /api/auth, secret fields, token URLs and user PII", () => {
    const event: any = {
      message: "boom at wss://api.example/ws/connect?token=eyJhbGciOi.JWT.sig&x=1",
      request: {
        url: "https://api.example/api/auth/login",
        method: "POST",
        headers: {
          Authorization: "Bearer eyJ.secret.jwt",
          cookie: "sid=abc",
          "X-Step-Up": "stepup-token",
          "user-agent": "vitest",
        },
        data: { email: "a@b.c", password: "hunter2" },
        query_string: "token=abc123&page=2",
      },
      user: { id: "u1", email: "a@b.c", username: "alice", ip_address: "1.2.3.4" },
      extra: {
        body: { passwordHash: "x", stepUpToken: "y", code: "123456", secret: "s", razorpay_signature: "sig", ok: 1 },
      },
      breadcrumbs: [{ category: "http", data: { url: "/ws/connect?token=JWT123" } }],
    };

    const out: any = scrubEvent(event);

    expect(out.request.headers.Authorization).toBeUndefined();
    expect(out.request.headers.cookie).toBeUndefined();
    expect(out.request.headers["X-Step-Up"]).toBeUndefined();
    expect(out.request.headers["user-agent"]).toBe("vitest");
    expect(out.request.data).toBeUndefined();
    expect(out.request.query_string).toBe("token=[Filtered]&page=2");
    expect(out.message).not.toContain("eyJhbGciOi");
    expect(out.message).toContain("token=[Filtered]&x=1");
    expect(out.user).toEqual({ id: "u1" });
    expect(out.extra.body).toEqual({
      passwordHash: "[Filtered]",
      stepUpToken: "[Filtered]",
      code: "[Filtered]",
      secret: "[Filtered]",
      razorpay_signature: "[Filtered]",
      ok: 1,
    });
    expect(out.breadcrumbs[0].data.url).toBe("/ws/connect?token=[Filtered]");
    expect(JSON.stringify(out)).not.toMatch(/hunter2|JWT123|a@b\.c|1\.2\.3\.4|eyJ/);
  });

  it("drops request bodies for /api/platform and filters password in other bodies", () => {
    const platform: any = scrubEvent({ request: { url: "/api/platform/institutions", data: { name: "X" } } });
    expect(platform.request.data).toBeUndefined();
    const other: any = scrubEvent({ request: { url: "/api/fees/pay", data: { password: "p", amount: 5 } } });
    expect(other.request.data).toEqual({ password: "[Filtered]", amount: 5 });
  });

  it("scrubs breadcrumbs and URL strings", () => {
    expect(scrubUrlString("/ws?a=1&token=abc#x")).toBe("/ws?a=1&token=[Filtered]#x");
    const crumb: any = scrubBreadcrumb({ message: "GET /ws?token=zzz", data: { password: "p" } });
    expect(crumb.message).toBe("GET /ws?token=[Filtered]");
    expect(crumb.data.password).toBe("[Filtered]");
  });

  it("removes a user object that has no id", () => {
    const out: any = scrubEvent({ user: { email: "a@b.c" } });
    expect(out.user).toBeUndefined();
  });
});

describe("sentry scrubber: account lifecycle tokens", () => {
  it("filters fragment/query tokens and the new key names, and account-invites bodies", () => {
    expect(scrubUrlString("https://a.x/reset-password#token=SECRET1")).not.toContain("SECRET1");
    expect(scrubUrlString("/x?resetToken=SECRET2&a=1")).not.toContain("SECRET2");
    expect(scrubUrlString("/x?inviteToken=SECRET3")).not.toContain("SECRET3");
    expect(scrubUrlString("/x?activationToken=SECRET4")).not.toContain("SECRET4");
    const out: any = scrubEvent({
      request: { url: "https://api.x/api/account-invites/bulk-students", data: { userIds: ["a"] } },
      extra: { newPassword: "n", confirmPassword: "c", confirm: "c", resetToken: "r", inviteToken: "i", activationToken: "a", tokenHash: "h", ok: 1 },
    });
    expect(out.request.data).toBeUndefined();
    for (const k of ["newPassword", "confirmPassword", "confirm", "resetToken", "inviteToken", "activationToken", "tokenHash"]) {
      expect(out.extra[k]).toBe("[Filtered]");
    }
    expect(out.extra.ok).toBe(1);
  });
});
