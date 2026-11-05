"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { RouteGuard } from "@/components/auth/RouteGuard";
import { NoAccess } from "@/components/ui-ext/NoAccess";
import { ModuleMatrix } from "@/components/platform/ModuleMatrix";
import { PLATFORM_PERM } from "@/features/platform/permissions";

export default function InstitutionModulesPage() {
  const params = useParams();
  const raw = params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;

  if (!id) return <NoAccess what="this institution's modules" />;

  return (
    <RouteGuard requirePermission={PLATFORM_PERM.entitlementsManage}>
      <div className="space-y-6">
        <div className="space-y-2">
          <Link
            href="/platform/institutions"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Institutions
          </Link>
          <h2 className="text-2xl font-bold text-gray-900">Module entitlements</h2>
        </div>
        <ModuleMatrix institutionId={id} />
      </div>
    </RouteGuard>
  );
}
