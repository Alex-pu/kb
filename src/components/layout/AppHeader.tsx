"use client";

import React, { useState } from "react";
import { useTenantStore } from "@/lib/store/tenant-store";
import { PropertySwitcherModal } from "./PropertySwitcherModal";
import { PersonaSwitcher } from "./PersonaSwitcher";
import { ResilienceStatus } from "./ResilienceStatus";
import { 
  Building2, 
  ChevronRight, 
  Radio, 
  Layers, 
  TerminalSquare 
} from "lucide-react";

export function AppHeader() {
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
      <header className="h-14 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 flex items-center justify-between shrink-0 select-none">
        {/* Left: Breadcrumbs and Property Selector */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-neutral-500 font-mono">
            <span className="font-semibold text-neutral-800 dark:text-neutral-200 truncate hidden md:inline">
              {company?.name || "Kore Bench"}
            </span>
            <ChevronRight className="w-3.5 h-3.5 text-neutral-400 hidden md:inline shrink-0" />
          </div>

          <button
            onClick={() => setIsSwitcherOpen(true)}
            className="flex items-center gap-2 px-2.5 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-900 dark:text-neutral-100 text-xs font-medium border border-neutral-300 dark:border-neutral-700 transition-colors"
            title="Click to switch active property or outlet"
          >
            <Building2 className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
            <span className="truncate max-w-[160px] sm:max-w-[240px]">
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
        <div className="flex items-center gap-3">
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
