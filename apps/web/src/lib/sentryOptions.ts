import type { init } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./sentryScrub";

type SentryInitOptions = NonNullable<Parameters<typeof init>[0]>;

/**
 * Shared Sentry.init options for client, server and edge. Only used when
 * NEXT_PUBLIC_SENTRY_DSN is set (callers check before loading the SDK).
 * Errors only: no tracing, no Session Replay, no automatic PII collection.
 */
export function sentryOptions() {
  return {
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    // SDK v11 replacement for `sendDefaultPii: false`.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: <T extends object>(event: T) => scrubEvent(event),
    beforeBreadcrumb: <T extends object>(crumb: T) => scrubBreadcrumb(crumb),
  } satisfies SentryInitOptions;
}
