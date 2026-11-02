"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { ApiError } from "@/lib/api";

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

  return (
    <QueryClientProvider client={qc}>
      {children}
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
