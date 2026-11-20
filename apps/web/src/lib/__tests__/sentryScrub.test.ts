import { describe, it, expect } from "vitest";
import { scrubBreadcrumb, scrubEvent, scrubString } from "@/lib/sentryScrub";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2lnbmF0dXJl";

describe("web sentry scrubber", () => {
  it("redacts token URLs, Authorization headers, auth store data and user PII", () => {
    const event: any = {
      request: {
        url: `https://campusgate.example/login?token=${JWT}`,
        headers: { Authorization: `Bearer ${JWT}`, "User-Agent": "vitest" },
        data: { email: "a@b.c", password: "hunter2" },
      },
      user: { id: "u1", email: "a@b.c", username: "alice" },
      extra: {
        "campusgate-auth": JSON.stringify({ state: { token: JWT } }),
        snapshot: `{"name":"campusgate-auth","state":{}}`,
        form: { password: "hunter2", note: "fine" },
      },
      breadcrumbs: [
        { category: "fetch", data: { url: `wss://api.example/ws/connect?token=${JWT}` } },
        { category: "console", message: `token is ${JWT}` },
      ],
    };

    const out: any = scrubEvent(event);

    expect(out.request.headers.Authorization).toBeUndefined();
    expect(out.request.headers["User-Agent"]).toBe("vitest");
    expect(out.request.data).toBeUndefined();
    expect(out.request.url).toBe("https://campusgate.example/login?token=[Filtered]");
    expect(out.user).toEqual({ id: "u1" });
    expect(out.extra["campusgate-auth"]).toBe("[Filtered]");
    expect(out.extra.snapshot).toBe("[Filtered]");
    expect(out.extra.form).toEqual({ password: "[Filtered]", note: "fine" });
    expect(out.breadcrumbs[0].data.url).toBe("wss://api.example/ws/connect?token=[Filtered]");
    expect(out.breadcrumbs[1].message).toBe("token is [Filtered]");
    expect(JSON.stringify(out)).not.toMatch(/eyJ|hunter2|a@b\.c|alice/);
  });

  it("scrubs breadcrumbs directly", () => {
    const crumb: any = scrubBreadcrumb({ message: "GET /ws?token=abc&x=1", data: { token: "t" } });
    expect(crumb.message).toBe("GET /ws?token=[Filtered]&x=1");
    expect(crumb.data.token).toBe("[Filtered]");
  });

  it("scrubs reset/activation tokens in fragments and query strings, and the new password keys", () => {
    const t = "T".repeat(43);
    expect(scrubString(`https://x.example/reset-password#token=${t}`)).toBe(
      "https://x.example/reset-password#token=[Filtered]",
    );
    expect(scrubString(`/activate?resetToken=${t}&a=1`)).toBe("/activate?resetToken=[Filtered]&a=1");
    expect(scrubString(`/x?inviteToken=${t}`)).toBe("/x?inviteToken=[Filtered]");
    expect(scrubString(`/x#activationToken=${t}`)).toBe("/x#activationToken=[Filtered]");
    const out: any = scrubEvent({
      extra: { newPassword: "a", confirmPassword: "b", confirm: "c", resetToken: "d", inviteToken: "e", activationToken: "f", tokenHash: "g", ok: 1 },
    });
    expect(out.extra).toEqual({
      newPassword: "[Filtered]",
      confirmPassword: "[Filtered]",
      confirm: "[Filtered]",
      resetToken: "[Filtered]",
      inviteToken: "[Filtered]",
      activationToken: "[Filtered]",
      tokenHash: "[Filtered]",
      ok: 1,
    });
  });

  it("leaves harmless strings alone", () => {
    expect(scrubString("/fees/me?page=2")).toBe("/fees/me?page=2");
  });

  it("drops a user without an id", () => {
    const out: any = scrubEvent({ user: { email: "a@b.c" } });
    expect(out.user).toBeUndefined();
  });
});
