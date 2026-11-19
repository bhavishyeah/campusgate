"use client";

import NextError from "next/error";
import { useEffect } from "react";

// Root error boundary (App Router). Reports render errors to Sentry only when
// NEXT_PUBLIC_SENTRY_DSN is set; otherwise it just shows the default error page.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
      void import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error));
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
