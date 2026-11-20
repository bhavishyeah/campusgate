"use client";

import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { ApiError, setSessionRefreshListener } from "@/lib/api";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30000,
            gcTime: 300000,
            refetchOnWindowFocus: false,
            retry: (count, err) =>
              err instanceof ApiError &&
              (err.status === 401 || err.status === 403)
                ? false
                : count < 2,
          },
          mutations: { retry: false },
        },
      })
  );

  // After a silent token refresh (role change), cached permission-driven data is stale.
  useEffect(() => {
    setSessionRefreshListener(() => {
      void qc.invalidateQueries();
    });
    return () => setSessionRefreshListener(null);
  }, [qc]);
  return (
    <QueryClientProvider client={qc}>
      {children}
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
