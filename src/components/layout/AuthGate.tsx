"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Loader2, LogOut } from "lucide-react";
import { landingPageForUser, permissionForPage } from "@/lib/auth/permissions";

const PUBLIC_ROUTES = new Set(["/", "/login"]);

/** Hydrates the session on load and gates every route behind a real signed-in user. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, authLoading, hydrateSession, hasPermission, logout, currentUser } = useTenantStore();
  const requiredPermission = permissionForPage(pathname);
  const isSuperAdmin = currentUser?.is_super_admin === true;
  const isSuperAdminRoute = pathname === "/super-admin" || pathname.startsWith("/super-admin/");
  const canAccessRooms = hasPermission("frontdesk:read") ||
    hasPermission("housekeeping:write") || hasPermission("rooms:manage");
  const canViewPermission = (permission: string) =>
    permission === "frontdesk:read" ? canAccessRooms : hasPermission(permission);
  const landingPage = landingPageForUser(canViewPermission);
  const canViewPage = requiredPermission === null || canViewPermission(requiredPermission);

  useEffect(() => {
    if (pathname === "/") return;
    void hydrateSession();
    // Only run once on mount — hydrateSession is stable across the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pathname === "/" || authLoading) return;
    const isPublic = PUBLIC_ROUTES.has(pathname);
    if (!isAuthenticated && !isPublic) {
      router.replace("/login");
    } else if (isAuthenticated && isSuperAdmin && !isPublic && !isSuperAdminRoute) {
      router.replace("/super-admin");
    } else if (isAuthenticated && !isSuperAdmin && isSuperAdminRoute && landingPage) {
      router.replace(landingPage);
    } else if (isAuthenticated && isPublic && landingPage) {
      router.replace(landingPage);
    } else if (isAuthenticated && isPublic && isSuperAdmin) {
      router.replace("/super-admin");
    } else if (isAuthenticated && !isPublic && !canViewPage && landingPage) {
      router.replace(landingPage);
    }
  }, [authLoading, canViewPage, isAuthenticated, isSuperAdmin, isSuperAdminRoute, landingPage, pathname, router]);

  if (pathname === "/") {
    return <>{children}</>;
  }

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

  if (isAuthenticated && !isSuperAdmin && !PUBLIC_ROUTES.has(pathname) && !landingPage) {
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

  if (isAuthenticated && isSuperAdminRoute && !isSuperAdmin) return null;
  if (isAuthenticated && requiredPermission && !canViewPage) return null;

  return <>{children}</>;
}
