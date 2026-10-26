"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useTenantStore } from "@/lib/store/tenant-store";
import { LogOut, UserCheck, ChevronDown } from "lucide-react";

// Replaces the old "PersonaSwitcher" — that component let anyone impersonate
// any mock user/role with a single click and no password, which was a
// critical security hole. This now only shows the real signed-in identity
// (from the server session) and provides a real logout.
export function PersonaSwitcher() {
  const router = useRouter();
  const { currentUser, activeRole, logout } = useTenantStore();
  const [isOpen, setIsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
    setLoggingOut(false);
    setIsOpen(false);
    router.push("/login");
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-mono transition-colors"
        title="Account"
      >
        <UserCheck className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
        <div className="text-left leading-tight hidden sm:block">
          <div className="font-semibold text-neutral-900 dark:text-neutral-100 truncate max-w-[140px]">
            {currentUser?.full_name || "Not signed in"}
          </div>
          <div className="text-[10px] text-neutral-400 truncate">
            {activeRole?.name || "No Role"}
          </div>
        </div>
        <ChevronDown className="w-3.5 h-3.5 text-neutral-400 ml-0.5" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-1 w-64 bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded shadow-xl z-50 p-2 space-y-1">
            <div className="px-2 py-1.5 border-b border-neutral-100 dark:border-neutral-800">
              <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                {currentUser?.full_name || "Not signed in"}
              </div>
              <div className="text-[10px] font-mono text-neutral-400 truncate">
                {currentUser?.email || currentUser?.phone_number || ""}
              </div>
            </div>
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="w-full flex items-center gap-2 p-2 rounded text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              <LogOut className="w-3.5 h-3.5" />
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
