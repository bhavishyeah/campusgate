/**
 * Object-storage adapter seam for Phase 9.7 Document Management (design §6).
 *
 * Large file BLOBS live in OBJECT STORAGE (Supabase Storage), NOT the relational
 * DB. ALL object-storage access sits behind this SMALL `ObjectStore` interface
 * with a concrete `SupabaseStorageAdapter` (raw Storage REST via the built-in
 * `fetch`, server-only service-role key) and an in-memory `InMemoryObjectStore`
 * stub. The injectable `getObjectStore` / `setObjectStore` singleton seam MIRRORS
 * `apps/api/src/services/fees/razorpay.ts` EXACTLY: a `*Like`/interface, a
 * concrete class whose constructor reads env with an `isProd()` guard throwing
 * ONLY in production, a lazy `let singleton`, a `get*()` accessor, and a
 * `set*(x|null)` test seam. No storage SDK/REST call is ever scattered through a
 * route — routes call `getObjectStore()`; tests call `setObjectStore(stub)`.
 *
 * Secret-absence guard — mirrors the razorpay.ts prod-guard SHAPE (throw only
 * when `NODE_ENV === 'production'` and a required value is unset; dev/test
 * tolerate absent/mocked). It ADDITIONALLY guards `SUPABASE_URL` because the
 * adapter is non-functional without it (a benign superset of the secret-only
 * razorpay guard — design review finding 6). The service-role key is used ONLY
 * as the Authorization/apikey header and is NEVER placed in a response body, a
 * log line, or a returned URL.
 */

export interface PutObjectInput {
  key: string; // tenant-prefixed storage key <institutionId>/<documentId>/<versionId>
  body: Buffer; // the received bytes
  contentType: string;
}

export interface HeadObjectResult {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

export interface SignedUrlResult {
  url: string; // absolute, short-lived
  expiresAt: Date;
}

/**
 * The minimal object-storage surface the documents flow needs. Declared as an
 * interface so fast suites inject a stub WITHOUT any SDK/network, and the blob
 * backend can be swapped (R2/S3) by writing one new class.
 */
export interface ObjectStore {
  putObject(input: PutObjectInput): Promise<void>;
  getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult>;
  // REQUIRED method; implemented by every adapter + the stub, but NO 9.7 route
  // calls it (D-1: server-receives-bytes). Required (not optional) so the
  // swap-to-R2/S3 contract is honest and a future large-file path never has to
  // handle `undefined` (design review finding 7).
  getSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<HeadObjectResult>;
}

/**
 * A small typed error the adapter throws so a route maps storage failures to a
 * deterministic 502 and never leaks the service-role key. Carries the HTTP
 * `status` (or 0 for a network error) and the `op` that failed.
 */
export class ObjectStoreError extends Error {
  readonly status: number;
  readonly op: string;
  constructor(op: string, status: number, message?: string) {
    super(message ?? `object store ${op} failed (status ${status})`);
    this.name = "ObjectStoreError";
    this.status = status;
    this.op = op;
  }
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Supabase Storage adapter — raw Storage REST via the built-in global `fetch`
 * (D-4: no @supabase/supabase-js dependency), server-only service-role key.
 */
export class SupabaseStorageAdapter implements ObjectStore {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string; // SERVER-ONLY; never logged, never returned
  private readonly bucket: string;

  constructor(opts?: { supabaseUrl?: string; serviceRoleKey?: string; bucket?: string }) {
    this.supabaseUrl = (opts?.supabaseUrl ?? process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
    this.serviceRoleKey = opts?.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    this.bucket = opts?.bucket ?? process.env.SUPABASE_STORAGE_BUCKET ?? "documents";

    // Mirror razorpay.ts/server.ts: fail hard ONLY in production when a required
    // value is unset. Dev/test must import + construct cleanly (mocked/absent is
    // fine). The URL guard is a benign superset of the secret-only razorpay guard
    // because the adapter cannot form a single request without the URL.
    if (isProd()) {
      if (!this.supabaseUrl) {
        throw new Error("SUPABASE_URL must be set in production");
      }
      if (!this.serviceRoleKey) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set in production");
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
    };
  }

  private encodeKey(key: string): string {
    // Preserve the path separators (the tenant prefix) but encode each segment.
    return key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const url = `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${this.encodeKey(input.key)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          ...this.authHeaders(),
          "Content-Type": input.contentType,
          "x-upsert": "false", // a key collision is a hard error, not a silent overwrite
        },
        body: new Uint8Array(input.body),
      });
    } catch (err) {
      throw new ObjectStoreError("putObject", 0, (err as Error)?.message);
    }
    if (!res.ok) {
      throw new ObjectStoreError("putObject", res.status);
    }
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult> {
    const url = `${this.supabaseUrl}/storage/v1/object/sign/${this.bucket}/${this.encodeKey(key)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
    } catch (err) {
      throw new ObjectStoreError("getSignedDownloadUrl", 0, (err as Error)?.message);
    }
    if (!res.ok) {
      throw new ObjectStoreError("getSignedDownloadUrl", res.status);
    }
    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = body.signedURL ?? body.signedUrl;
    if (!signed) {
      throw new ObjectStoreError("getSignedDownloadUrl", res.status, "no signedURL in response");
    }
    const absolute = signed.startsWith("http")
      ? signed
      : `${this.supabaseUrl}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
    return { url: absolute, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async getSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult> {
    // Implemented so the swap-to-R2/S3 contract stays honest, but NO 9.7 route
    // calls it (D-1: server-receives-bytes).
    const url = `${this.supabaseUrl}/storage/v1/object/upload/sign/${this.bucket}/${this.encodeKey(key)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
    } catch (err) {
      throw new ObjectStoreError("getSignedUploadUrl", 0, (err as Error)?.message);
    }
    if (!res.ok) {
      throw new ObjectStoreError("getSignedUploadUrl", res.status);
    }
    const body = (await res.json()) as { url?: string; signedURL?: string; signedUrl?: string };
    const signed = body.url ?? body.signedURL ?? body.signedUrl;
    if (!signed) {
      throw new ObjectStoreError("getSignedUploadUrl", res.status, "no upload URL in response");
    }
    const absolute = signed.startsWith("http")
      ? signed
      : `${this.supabaseUrl}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
    return { url: absolute, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async deleteObject(key: string): Promise<void> {
    const url = `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${this.encodeKey(key)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "DELETE", headers: this.authHeaders() });
    } catch (err) {
      throw new ObjectStoreError("deleteObject", 0, (err as Error)?.message);
    }
    // A delete of an already-absent object is tolerated (404 => idempotent no-op).
    if (!res.ok && res.status !== 404) {
      throw new ObjectStoreError("deleteObject", res.status);
    }
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const url = `${this.supabaseUrl}/storage/v1/object/info/${this.bucket}/${this.encodeKey(key)}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: this.authHeaders() });
    } catch (err) {
      throw new ObjectStoreError("headObject", 0, (err as Error)?.message);
    }
    if (res.status === 404) return { exists: false };
    if (!res.ok) {
      throw new ObjectStoreError("headObject", res.status);
    }
    const info = (await res.json().catch(() => ({}))) as {
      size?: number;
      contentLength?: number;
      metadata?: { size?: number; mimetype?: string };
      contentType?: string;
    };
    const sizeBytes = info.size ?? info.contentLength ?? info.metadata?.size;
    const contentType = info.contentType ?? info.metadata?.mimetype;
    return {
      exists: true,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  }
}

/**
 * In-memory stub — the fast suite + the behavioral live suite inject the
 * identical fake, so no test touches the network. Exposes test-only `has(key)` /
 * `size()` so a test can assert a blob was/wasn't written (proving the
 * partial-failure ordering, §8).
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly store = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(input: PutObjectInput): Promise<void> {
    if (this.store.has(input.key)) {
      // x-upsert:false parity — a key collision is a hard error, not a silent
      // overwrite (the version id embedded in the key makes this effectively
      // unreachable in normal flow).
      throw new ObjectStoreError("putObject", 409, "key already exists");
    }
    this.store.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
  }

  async getSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    return { url: `stub://${key}?exp=${expiresAt.getTime()}`, expiresAt };
  }

  async getSignedUploadUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult> {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    return { url: `stub://upload/${key}?exp=${expiresAt.getTime()}`, expiresAt };
  }

  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    const entry = this.store.get(key);
    if (!entry) return { exists: false };
    return { exists: true, sizeBytes: entry.body.length, contentType: entry.contentType };
  }

  // ── test-only helpers (not part of the ObjectStore interface) ──────────────
  has(key: string): boolean {
    return this.store.has(key);
  }
  size(): number {
    return this.store.size;
  }
}

// ─── Lazy singleton (EXACTLY the razorpay.ts seam) ───────────────────────────
// Constructed on first access (not at import) so a dev/test import never trips
// the production guard and never requires the service-role key until a route
// actually stores or signs. Routes call `getObjectStore()`; tests call
// `setObjectStore(new InMemoryObjectStore())` in beforeEach and
// `setObjectStore(null)` in afterEach.
let singleton: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (!singleton) singleton = new SupabaseStorageAdapter();
  return singleton;
}

/** Test seam: override (or reset with `null`) the process-wide object store. */
export function setObjectStore(store: ObjectStore | null): void {
  singleton = store;
}
