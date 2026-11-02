/**
 * Phase-9.7 gated real-Supabase-Storage smoke check (design §16.4). This is the
 * ONLY place the REAL SupabaseStorageAdapter runs against a real bucket, and the
 * only place the external Supabase Storage REST endpoint shapes are confirmed.
 *
 * It is SKIPPED unless BOTH SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
 * present in the environment — so the default fast run and the integration run
 * stay free of real blob I/O. When enabled it drives the adapter end-to-end:
 *   putObject a tiny buffer under smoke/<uuid> → headObject reports it exists
 *   with the right size → getSignedDownloadUrl returns an absolute URL that
 *   fetches back the identical bytes → deleteObject → headObject reports gone.
 * It NEVER prints the service-role key.
 */
import { randomUUID, createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SupabaseStorageAdapter } from "../storage.js";

const ENABLED = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!ENABLED)("SupabaseStorageAdapter real smoke (gated on SUPABASE_* env)", () => {
  const adapter = new SupabaseStorageAdapter();
  const key = `smoke/${randomUUID()}`;
  const bytes = Buffer.from(`campass-smoke-${randomUUID()}`);

  afterAll(async () => {
    // best-effort cleanup in case a mid-test assertion failed before the delete
    await adapter.deleteObject(key).catch(() => {});
  });

  it("round-trips a real object end-to-end", { timeout: 60000 }, async () => {
    await adapter.putObject({ key, body: bytes, contentType: "application/octet-stream" });

    const head = await adapter.headObject(key);
    expect(head.exists).toBe(true);
    if (head.sizeBytes !== undefined) expect(head.sizeBytes).toBe(bytes.length);

    const signed = await adapter.getSignedDownloadUrl(key, 120);
    expect(signed.url.startsWith("http")).toBe(true);
    const fetched = await fetch(signed.url);
    expect(fetched.ok).toBe(true);
    const downloaded = Buffer.from(await fetched.arrayBuffer());
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    await adapter.deleteObject(key);
    const gone = await adapter.headObject(key);
    expect(gone.exists).toBe(false);
  });
});
