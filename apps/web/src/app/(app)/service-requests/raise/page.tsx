"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Megaphone } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui-ext/EmptyState";
import { ErrorBlock, TableSkeleton } from "@/components/ui-ext/ErrorBlock";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { RaiseForm } from "@/components/service-requests/RaiseForm";
import { useActiveTypes } from "@/features/service-requests/hooks";
import { groupActiveTypes, resolvePreselectType, slaLabel } from "@/features/service-requests/format";
import { readIdParam } from "@/lib/paging";
import type { ActiveType } from "@/features/service-requests/types";

export default function RaisePage() {
  return (
    <RouteGuard requirePermission="service_requests.request_own">
      <Suspense fallback={<TableSkeleton />}>
        <RaiseInner />
      </Suspense>
    </RouteGuard>
  );
}

function RaiseInner() {
  const params = useSearchParams();
  const [typeIdParam] = useState(() => readIdParam(params.get("typeId")));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preselectApplied, setPreselectApplied] = useState(false);
  const [deepLinkMissed, setDeepLinkMissed] = useState(false);
  const catalogue = useActiveTypes();

  const types = catalogue.data?.types ?? [];

  // Apply the ?typeId pre-select once the catalogue loads.
  useEffect(() => {
    if (preselectApplied || !catalogue.data) return;
    setPreselectApplied(true);
    const resolved = resolvePreselectType(typeIdParam, catalogue.data.types);
    if (resolved) setSelectedId(resolved);
    else if (typeIdParam) setDeepLinkMissed(true);
  }, [catalogue.data, preselectApplied, typeIdParam]);

  const selected: ActiveType | undefined = types.find((t) => t.id === selectedId);
  const groups = groupActiveTypes(types);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Raise a request</h1>
        <p className="text-sm text-gray-500">Choose a request type, then fill in the form.</p>
      </div>

      {!catalogue.allowed ? (
        <NoAccess what="the request catalogue" />
      ) : catalogue.isLoading ? (
        <TableSkeleton />
      ) : catalogue.isError ? (
        <ErrorBlock error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      ) : types.length === 0 ? (
        <EmptyState icon={Megaphone} label="No request types are available to raise right now." />
      ) : selected ? (
        <RaiseForm type={selected} onBack={() => setSelectedId(null)} />
      ) : (
        <div className="space-y-6">
          {deepLinkMissed ? (
            <p className="text-sm text-warning-600">
              That request type is not available. Choose one from the catalogue below.
            </p>
          ) : null}
          {groups.map((g) => (
            <div key={g.category} className="space-y-2">
              <h2 className="text-sm font-medium text-gray-500">{g.category}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {g.types.map((t) => (
                  <button key={t.id} type="button" onClick={() => setSelectedId(t.id)} className="text-left">
                    <Card className="transition-colors hover:bg-gray-50">
                      <CardContent className="space-y-1 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium text-gray-900">{t.name}</p>
                          {t.requiresApproval ? <Badge variant="outline">Approval required</Badge> : null}
                        </div>
                        {t.description ? <p className="text-sm text-gray-500">{t.description}</p> : null}
                        <p className="text-xs text-gray-400">{slaLabel(t)}</p>
                      </CardContent>
                    </Card>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
