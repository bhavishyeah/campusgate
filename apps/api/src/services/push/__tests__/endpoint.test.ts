import { describe, expect, it } from "vitest";
import { endpointHost, isAllowedPushEndpoint } from "../endpoint.js";

const ok = [
  "https://fcm.googleapis.com/fcm/send/abc",
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://web.push.apple.com/QAbc",
  "https://wns2-par02p.notify.windows.com/w/?token=abc",
  "https://fcm.googleapis.com:443/fcm/send/abc",
];
const bad = [
  "http://fcm.googleapis.com/fcm/send/abc",
  "https://storage.googleapis.com/x",
  "https://googleapis.com.evil.com/x",
  "https://fcm.googleapis.com.evil.com/x",
  "https://evil.com/fcm.googleapis.com",
  "https://127.0.0.1/x",
  "https://[::1]/x",
  "https://10.0.0.5/x",
  "https://fcm.googleapis.com:8443/x",
  "https://user:pw@fcm.googleapis.com/x",
  "not a url",
  "",
  "https://fcm.googleapis.com/" + "a".repeat(2100),
  "https://notpush.services.mozilla.com.evil.com/x",
];

describe("isAllowedPushEndpoint", () => {
  it.each(ok)("accepts %s", (u) => expect(isAllowedPushEndpoint(u, {})).toBe(true));
  it.each(bad)("rejects %s", (u) => expect(isAllowedPushEndpoint(u, {})).toBe(false));

  it("PUSH_ENDPOINT_HOSTS adds exact hostnames only", () => {
    const env = { PUSH_ENDPOINT_HOSTS: "push.example.org, *.wild.example, other.example.org/path" } as NodeJS.ProcessEnv;
    expect(isAllowedPushEndpoint("https://push.example.org/x", env)).toBe(true);
    expect(isAllowedPushEndpoint("https://a.push.example.org/x", env)).toBe(false);
    expect(isAllowedPushEndpoint("https://a.wild.example/x", env)).toBe(false);
    expect(isAllowedPushEndpoint("https://other.example.org/x", env)).toBe(false);
  });
});

describe("endpointHost", () => {
  it("returns the lower-cased host for https and null otherwise", () => {
    expect(endpointHost("https://FCM.googleapis.com/x")).toBe("fcm.googleapis.com");
    expect(endpointHost("http://fcm.googleapis.com/x")).toBeNull();
    expect(endpointHost("nope")).toBeNull();
  });
});
