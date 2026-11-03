"use client";

import React, { useEffect, useState } from "react";
import { AppSidebar } from "./AppSidebar";
import { AppHeader } from "./AppHeader";

interface Props {
  children: React.ReactNode;
}

export function DashboardShell({ children }: Props) {
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  return (
    <div className="relative flex h-[100dvh] w-full max-w-[100vw] overflow-hidden bg-neutral-100 dark:bg-neutral-950">
      <AppSidebar
        mobileOpen={mobileNavigationOpen}
        onMobileClose={() => setMobileNavigationOpen(false)}
      />

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader
          mobileNavigationOpen={mobileNavigationOpen}
          onMenuClick={() => setMobileNavigationOpen((open) => !open)}
        />
        <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-neutral-50 p-3 dark:bg-neutral-900/40 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
