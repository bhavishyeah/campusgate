"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LogOut, Menu, X } from "lucide-react";
import { useAuthStore } from "@/stores/auth";
import { useNavItemVisible } from "./ModuleLinks";
import { sheetNavItems, type SheetLink } from "./mobileNav";
import type { NavItem } from "./navItems";

const ROW =
  "flex items-center gap-3 min-h-[44px] px-3 rounded-lg text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500";

function SheetNavRow({ item, perms, pathname, onNavigate }: { item: NavItem; perms: string[]; pathname: string; onNavigate: () => void }) {
  const visible = useNavItemVisible(item, perms);
  if (!visible) return null;
  const active = pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`${ROW} ${active ? "bg-primary-50 text-primary-700" : "text-gray-700 active:bg-gray-100"}`}
    >
      <item.icon className="w-5 h-5 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/**
 * Bottom-bar "More" tab that opens a slide-up sheet with every link the desktop
 * sidebar offers: optional legacy-portal links, then the shared "Campus services" list.
 */
export function MobileMoreSheet({
  extraLinks = [],
  extraHeading = "Menu",
  includeGatePass = false,
  onSignOut,
}: {
  extraLinks?: SheetLink[];
  extraHeading?: string;
  includeGatePass?: boolean;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const perms = useAuthStore((s) => s.permissions);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  const close = () => setOpen(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger
        className="flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-[44px] px-3 py-1 rounded-lg text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        aria-label="More"
      >
        <Menu className="w-5 h-5" />
        <span className="text-xs">More</span>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-[70] flex max-h-[85dvh] flex-col rounded-t-2xl bg-white shadow-lg pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom duration-200"
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <DialogPrimitive.Title className="text-base font-semibold text-gray-900">Menu</DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto overscroll-contain px-3 pb-3 space-y-1">
            {extraLinks.length > 0 && (
              <div className="space-y-1">
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">{extraHeading}</p>
                {extraLinks.map((l) => {
                  const active = pathname === l.href;
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      onClick={close}
                      aria-current={active ? "page" : undefined}
                      className={`${ROW} ${active ? "bg-primary-50 text-primary-700" : "text-gray-700 active:bg-gray-100"}`}
                    >
                      <l.icon className="w-5 h-5 shrink-0" />
                      <span className="truncate">{l.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
            <div className={extraLinks.length > 0 ? "mt-3 pt-3 border-t border-gray-200 space-y-1" : "space-y-1"} data-testid="more-sheet-links">
              <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">Campus services</p>
              {sheetNavItems(includeGatePass).map((item) => (
                <SheetNavRow key={`${item.href}:${item.label}`} item={item} perms={perms} pathname={pathname} onNavigate={close} />
              ))}
            </div>
            {onSignOut && (
              <button
                type="button"
                onClick={() => {
                  close();
                  onSignOut();
                }}
                className={`${ROW} w-full mt-3 border-t border-gray-200 text-gray-700 active:bg-gray-100`}
              >
                <LogOut className="w-5 h-5 shrink-0" />
                Sign Out
              </button>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Fixed bottom bar: primary tabs (children) followed by the More sheet trigger. */
export function MobileTabBar({
  children,
  ...sheet
}: { children?: React.ReactNode } & React.ComponentProps<typeof MobileMoreSheet>) {
  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex justify-around items-center py-2">
        {children}
        <MobileMoreSheet {...sheet} />
      </div>
    </nav>
  );
}

/** Bottom bar tab for a legacy-portal primary link. */
export function MobileTab({ href, label, icon: Icon, active }: SheetLink & { active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex flex-col items-center justify-center gap-1 min-h-[44px] min-w-[44px] px-3 py-1 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
        active ? "text-primary-600" : "text-gray-500"
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="text-xs">{label}</span>
    </Link>
  );
}
