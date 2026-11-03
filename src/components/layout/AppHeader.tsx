"use client";

import React, { useState } from "react";
import { useTenantStore } from "@/lib/store/tenant-store";
import { PropertySwitcherModal } from "./PropertySwitcherModal";
import { PersonaSwitcher } from "./PersonaSwitcher";
import { ResilienceStatus } from "./ResilienceStatus";
import {
  Building2, 
  ChevronRight, 
  Menu,
  TerminalSquare,
  X,
} from "lucide-react";

interface AppHeaderProps {
  mobileNavigationOpen: boolean;
  onMenuClick: () => void;
}

export function AppHeader({ mobileNavigationOpen, onMenuClick }: AppHeaderProps) {
  const { 
    company, 
    activeProperty, 
    activeOutlet, 
    activeStation, 
    availableProperties 
  } = useTenantStore();

  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);

  return (
    <>
      <header className="z-30 flex h-14 shrink-0 select-none items-center justify-between gap-2 border-b border-neutral-200 bg-white px-2.5 dark:border-neutral-800 dark:bg-neutral-900 sm:px-4">
        {/* Left: Breadcrumbs and Property Selector */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={mobileNavigationOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileNavigationOpen}
            className="shrink-0 rounded p-2 text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800 lg:hidden"
          >
            {mobileNavigationOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-neutral-500 font-mono">
            <span className="font-semibold text-neutral-800 dark:text-neutral-200 truncate hidden md:inline">
              {company?.name || "Kore Bench"}
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-neutral-400 hidden md:inline shrink-0" />
          </div>

          <button
            onClick={() => setIsSwitcherOpen(true)}
            className="flex min-w-0 items-center gap-1.5 rounded border border-neutral-300 bg-neutral-100 px-2 py-2 text-xs font-medium text-neutral-900 transition-colors hover:bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700 sm:gap-2 sm:px-2.5"
            title="Click to switch active property or outlet"
          >
            <Building2 className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
            <span className="max-w-[35vw] truncate sm:max-w-[240px]">
              {activeProperty?.name || "Select Property"}
            </span>
            {availableProperties.length > 1 && (
              <span className="px-1 py-0.2 bg-black text-white dark:bg-white dark:text-black rounded text-[9px] font-mono">
                {availableProperties.length} Sites
              </span>
            )}
          </button>

          {activeOutlet && (
            <div className="hidden lg:flex items-center gap-1.5 text-xs text-neutral-500 font-mono">
              <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
              <span className="text-neutral-700 dark:text-neutral-300 truncate">
                {activeOutlet.name}
              </span>
            </div>
          )}
        </div>

        {/* Right: Station ID, Online Indicator, Persona Switcher */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          {activeStation && (
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[11px] font-mono text-neutral-600 dark:text-neutral-400">
              <TerminalSquare className="w-3 h-3 text-neutral-500" />
              <span>{activeStation.name}</span>
            </div>
          )}

          <ResilienceStatus />

          {/* Persona Switcher (Testing RLS Isolation) */}
          <PersonaSwitcher />
        </div>
      </header>

      {/* Property Switcher Modal */}
      <PropertySwitcherModal
        isOpen={isSwitcherOpen}
        onClose={() => setIsSwitcherOpen(false)}
      />
    </>
  );
}
