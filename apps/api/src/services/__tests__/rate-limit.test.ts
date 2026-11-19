import { describe, expect, it, vi } from "vitest";
import { clientIpKey, createLimiter, isPrivateOrCgnatIp, limiters, resetAllLimiters } from "../rate-limit.js";

describe("createLimiter", () => {
  it("allows max hits per window, then denies with Retry-After, then resets", () => {
    const l = createLimiter({ max: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i++) expect(l.hit("k", 0).allowed).toBe(true);
    const d = l.hit("k", 100);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBe(1);
    expect(l.hit("other", 100).allowed).toBe(true);
    expect(l.hit("k", 1000).allowed).toBe(true);
  });

  it("bounds memory with maxKeys", () => {
    const l = createLimiter({ max: 1, windowMs: 60_000, maxKeys: 50 });
    for (let i = 0; i < 500; i++) l.hit(`k${i}`, 0);
    expect(l.size()).toBeLessThanOrEqual(50);
  });

  it("tokenIp allows 600 hits from one IP and denies the 601st", () => {
    resetAllLimiters();
    for (let i = 0; i < 600; i++) expect(limiters.tokenIp.hit("9.9.9.9").allowed).toBe(true);
    expect(limiters.tokenIp.hit("9.9.9.9").allowed).toBe(false);
    resetAllLimiters();
  });
});

describe("private / CGNAT detector and fail-safe", () => {
  it.each(["10.0.0.1", "100.64.0.1", "100.127.255.1", "172.16.0.1", "172.31.1.1", "192.168.1.1", "127.0.0.1", "::1", "fd00::1", "::ffff:10.1.1.1"])(
    "%s is internal",
    (ip) => expect(isPrivateOrCgnatIp(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1", "49.36.1.1"])("%s is public", (ip) =>
    expect(isPrivateOrCgnatIp(ip)).toBe(false),
  );

  it("returns null (skips IP limiters) for an internal IP in production, not in dev/test", () => {
    const log = { warn: vi.fn() } as never;
    expect(clientIpKey({ ip: "10.1.1.1", log }, { NODE_ENV: "production" } as never)).toBeNull();
    expect(clientIpKey({ ip: "10.1.1.1", log }, {} as never)).toBeNull();
    expect(clientIpKey({ ip: "10.1.1.1", log }, { NODE_ENV: "test" } as never)).toBe("10.1.1.1");
    expect(clientIpKey({ ip: "49.36.1.1", log }, { NODE_ENV: "production" } as never)).toBe("49.36.1.1");
  });
});
