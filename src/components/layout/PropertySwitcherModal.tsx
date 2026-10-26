"use client";

import React from "react";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Building2, Store, Check, X } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function PropertySwitcherModal({ isOpen, onClose }: Props) {
  const { 
    availableProperties, 
    activeProperty, 
    availableOutlets, 
    activeOutlet, 
    switchProperty, 
    switchOutlet 
  } = useTenantStore();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 w-full max-w-lg rounded shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
          <div>
            <h3 className="font-semibold text-sm">Select Operating Property & Outlet</h3>
            <p className="text-[11px] text-neutral-500 font-mono">
              Row-Level Security: Only assigned properties for current user are visible
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Property List */}
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <div className="text-[11px] font-mono font-semibold text-neutral-400 uppercase tracking-wider mb-2">
              Assigned Properties ({availableProperties.length})
            </div>
            <div className="space-y-1.5">
              {availableProperties.map((prop) => {
                const isSelected = activeProperty?.id === prop.id;
                return (
                  <button
                    key={prop.id}
                    onClick={() => switchProperty(prop.id)}
                    className={`w-full flex items-start justify-between p-3 rounded border text-left transition-colors ${
                      isSelected
                        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-black"
                        : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 bg-white dark:bg-neutral-900"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Building2 className={`w-4 h-4 mt-0.5 ${isSelected ? "text-white dark:text-black" : "text-neutral-500"}`} />
                      <div>
                        <div className="font-medium text-xs leading-tight">{prop.name}</div>
                        <div className={`text-[11px] font-mono mt-0.5 ${isSelected ? "text-neutral-300 dark:text-neutral-600" : "text-neutral-500"}`}>
                          Code: {prop.code} • Type: {prop.property_type.toUpperCase()}
                        </div>
                        {prop.physical_address && (
                          <div className={`text-[10px] mt-0.5 ${isSelected ? "text-neutral-400 dark:text-neutral-500" : "text-neutral-400"}`}>
                            {prop.physical_address}
                          </div>
                        )}
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Outlets List within selected property */}
          {activeProperty && (
            <div>
              <div className="text-[11px] font-mono font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                Outlets in {activeProperty.name} ({availableOutlets.length})
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {availableOutlets.map((outlet) => {
                  const isSelected = activeOutlet?.id === outlet.id;
                  return (
                    <button
                      key={outlet.id}
                      onClick={() => switchOutlet(outlet.id)}
                      className={`flex items-center justify-between p-2.5 rounded border text-left transition-colors ${
                        isSelected
                          ? "border-neutral-800 bg-neutral-100 dark:bg-neutral-800 font-semibold"
                          : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 text-neutral-600 dark:text-neutral-400"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Store className="w-3.5 h-3.5 shrink-0 text-neutral-400" />
                        <div className="min-w-0">
                          <div className="text-xs truncate">{outlet.name}</div>
                          <div className="text-[10px] font-mono text-neutral-400">{outlet.outlet_type}</div>
                        </div>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-neutral-900 dark:text-white" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-4 py-3 bg-neutral-50 dark:bg-neutral-800/50 border-t border-neutral-200 dark:border-neutral-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-black text-white dark:bg-white dark:text-black font-medium text-xs rounded hover:opacity-90 transition-opacity"
          >
            Confirm & Apply Scope
          </button>
        </div>
      </div>
    </div>
  );
}
