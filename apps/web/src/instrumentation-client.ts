// Browser-side Sentry. NEXT_PUBLIC_SENTRY_DSN is inlined at build time, so
// with no DSN this whole branch (and the SDK chunk) is dropped from the bundle.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void Promise.all([import("@sentry/nextjs"), import("./lib/sentryOptions")]).then(
    ([Sentry, { sentryOptions }]) => {
      // No replayIntegration / feedbackIntegration: Session Replay stays OFF.
      Sentry.init(sentryOptions());
    },
  );
}
