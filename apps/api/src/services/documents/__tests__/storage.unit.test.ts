/**
 * Phase-9.7 Document Management FAST unit specs for the ObjectStore seam (no DB,
 * no network). Covers (design §16.1):
 *   - InMemoryObjectStore behavior (put/head/signed-url/delete + has/size);
 *   - the SupabaseStorageAdapter constructor guard (throws in prod when URL/key
 *     unset; imports/constructs cleanly in test with absent values — mirrors the
 *     razorpay guard test);
 *   - the injectable get/setObjectStore singleton lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryObjectStore,
  SupabaseStorageAdapter,
  ObjectStoreError,
  getObjectStore,
  setObjectStore,
} from "../storage.js";

describe("InMemoryObjectStore", () => {
  let store: InMemoryObjectStore;
  beforeEach(() => {
    store = new InMemoryObjectStore();
  });

  it("stores and heads an object with the right size + contentType", async () => {
    await store.putObject({ key: "inst/doc/v1", body: Buffer.from("hello"), contentType: "text/plain" });
    expect(store.has("inst/doc/v1")).toBe(true);
    expect(store.size()).toBe(1);
    const head = await store.headObject("inst/doc/v1");
    expect(head).toEqual({ exists: true, sizeBytes: 5, contentType: "text/plain" });
  });

  it("reports absence for an unknown key", async () => {
    expect(await store.headObject("missing")).toEqual({ exists: false });
    expect(store.has("missing")).toBe(false);
  });

  it("rejects a duplicate key (x-upsert:false parity)", async () => {
    await store.putObject({ key: "k", body: Buffer.from("a"), contentType: "text/plain" });
    await expect(
      store.putObject({ key: "k", body: Buffer.from("b"), contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(ObjectStoreError);
  });

  it("mints a synthetic short-lived signed download URL with an expiry", async () => {
    const before = Date.now();
    const signed = await store.getSignedDownloadUrl("inst/doc/v1", 120);
    expect(signed.url).toContain("stub://inst/doc/v1");
    expect(signed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000 - 1000);
  });

  it("mints a synthetic signed upload URL (interface completeness, unwired)", async () => {
    const signed = await store.getSignedUploadUrl("inst/doc/v1", 60);
    expect(signed.url).toContain("stub://upload/inst/doc/v1");
  });

  it("deletes an object (idempotent)", async () => {
    await store.putObject({ key: "k", body: Buffer.from("a"), contentType: "text/plain" });
    await store.deleteObject("k");
    expect(store.has("k")).toBe(false);
    await expect(store.deleteObject("k")).resolves.toBeUndefined(); // idempotent
  });
});

describe("SupabaseStorageAdapter constructor guard (prod-parity with razorpay)", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("constructs cleanly in test with SUPABASE_* unset (no throw at import/construct)", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NODE_ENV = "test";
    expect(() => new SupabaseStorageAdapter()).not.toThrow();
  });

  it("throws in production when SUPABASE_URL is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    expect(() => new SupabaseStorageAdapter()).toThrow(/SUPABASE_URL/);
  });

  it("throws in production when SUPABASE_SERVICE_ROLE_KEY is unset", () => {
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_URL = "https://ref.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => new SupabaseStorageAdapter()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("constructs in production when both are set (overrides)", () => {
    process.env.NODE_ENV = "production";
    expect(
      () => new SupabaseStorageAdapter({ supabaseUrl: "https://x.co", serviceRoleKey: "k" }),
    ).not.toThrow();
  });
});

describe("get/setObjectStore singleton lifecycle", () => {
  afterEach(() => setObjectStore(null));

  it("returns the injected store, and resets to a lazy default on null", () => {
    const stub = new InMemoryObjectStore();
    setObjectStore(stub);
    expect(getObjectStore()).toBe(stub);
    setObjectStore(null);
    // A fresh default is lazily constructed (SupabaseStorageAdapter); not the stub.
    expect(getObjectStore()).not.toBe(stub);
    expect(getObjectStore()).toBeInstanceOf(SupabaseStorageAdapter);
  });
});
