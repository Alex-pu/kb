"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Loader2, LogOut } from "lucide-react";
import { landingPageForUser, permissionForPage } from "@/lib/auth/permissions";

const PUBLIC_ROUTES = new Set(["/login"]);

/** Hydrates the session on load and gates every route behind a real signed-in user. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, authLoading, hydrateSession, hasPermission, logout } = useTenantStore();
  const requiredPermission = permissionForPage(pathname);
  const canAccessRooms = hasPermission("frontdesk:read") ||
    hasPermission("housekeeping:write") || hasPermission("rooms:manage");
  const canViewPermission = (permission: string) =>
    permission === "frontdesk:read" ? canAccessRooms : hasPermission(permission);
  const landingPage = landingPageForUser(canViewPermission);
  const canViewPage = requiredPermission === null || canViewPermission(requiredPermission);

  useEffect(() => {
    void hydrateSession();
    // Only run once on mount — hydrateSession is stable across the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authLoading) return;
    const isPublic = PUBLIC_ROUTES.has(pathname);
    if (!isAuthenticated && !isPublic) {
      router.replace("/login");
    } else if (isAuthenticated && isPublic && landingPage) {
      router.replace(landingPage);
    } else if (isAuthenticated && !isPublic && !canViewPage && landingPage) {
      router.replace(landingPage);
    }
  }, [authLoading, canViewPage, isAuthenticated, landingPage, pathname, router]);

  if (authLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-neutral-100 dark:bg-neutral-950">
        <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!isAuthenticated && !PUBLIC_ROUTES.has(pathname)) {
    return null;
  }

  if (isAuthenticated && !PUBLIC_ROUTES.has(pathname) && !landingPage) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-100 dark:bg-neutral-950 p-6">
        <section className="max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold">No workspace is assigned</h1>
          <p className="text-sm text-neutral-500">Ask an administrator to grant access to a work area.</p>
          <button
            type="button"
            onClick={() => void logout().then(() => router.replace("/login"))}
            className="inline-flex items-center gap-2 px-3 py-2 rounded bg-black text-white dark:bg-white dark:text-black text-sm"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </section>
      </main>
    );
  }

  if (isAuthenticated && requiredPermission && !canViewPage) return null;

  return <>{children}</>;
}
