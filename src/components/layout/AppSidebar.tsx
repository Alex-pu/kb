"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTenantStore } from "@/lib/store/tenant-store";
import { 
  LayoutDashboard, 
  Users, 
  ShoppingCart,
  BedDouble, 
  UtensilsCrossed, 
  ChefHat,
  Package, 
  Boxes, 
  ClipboardList,
  Calculator, 
  BarChart3, 
  History, 
  SlidersHorizontal,
  Building2,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";

interface NavItem {
  title: string;
  href: string;
  icon: React.ElementType;
  permission: string;
}

const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Front Office",
    items: [
      { title: "Touch POS Station", href: "/pos", icon: ShoppingCart, permission: "pos:read" },
      { title: "Restaurant & Bar", href: "/dining", icon: UtensilsCrossed, permission: "restaurant:read" },
      { title: "Front Desk & Rooms", href: "/rooms", icon: BedDouble, permission: "frontdesk:read" },
      { title: "Housekeeping", href: "/housekeeping", icon: Sparkles, permission: "housekeeping:write" },
      { title: "Kitchen Display (KDS)", href: "/kds", icon: ChefHat, permission: "kds:read" },
      { title: "Store Requests", href: "/store-requests", icon: ClipboardList, permission: "inventory:request" },
    ],
  },
  {
    title: "Back Office",
    items: [
      { title: "Dashboard", href: "/", icon: LayoutDashboard, permission: "dashboard:read" },
      { title: "Products & Menu", href: "/catalog", icon: Package, permission: "catalog:read" },
      { title: "Stock & Supplies", href: "/stock", icon: Boxes, permission: "inventory:read" },
      { title: "Accounting & Ledger", href: "/accounting", icon: Calculator, permission: "accounting:read" },
      { title: "Reports & Analytics", href: "/reports", icon: BarChart3, permission: "analytics:read" },
      { title: "Activity Logs", href: "/audit-logs", icon: History, permission: "audit:read" },
      { title: "User Management", href: "/users", icon: Users, permission: "users:manage" },
      { title: "Roles & Permissions", href: "/roles", icon: ShieldCheck, permission: "roles:manage" },
      { title: "Property Settings", href: "/settings", icon: SlidersHorizontal, permission: "settings:manage" },
      { title: "My Account", href: "/account", icon: UserRound, permission: "" },
    ],
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const { activeProperty, activeOutlet, activeRole, hasPermission } = useTenantStore();
  const canAccessRooms = hasPermission("frontdesk:read") ||
    hasPermission("housekeeping:write") || hasPermission("rooms:manage");

  return (
    <aside className="w-64 bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col h-screen shrink-0 select-none">
      {/* Brand Header */}
      <div className="h-14 border-b border-neutral-200 dark:border-neutral-800 flex items-center px-4 gap-2.5">
        <div className="w-7 h-7 bg-black dark:bg-white text-white dark:text-black flex items-center justify-center font-bold text-sm rounded">
          K
        </div>
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-sm leading-tight truncate">KORE BENCH</span>
          <span className="text-[10px] text-neutral-500 font-mono tracking-wider uppercase">SME Operations</span>
        </div>
      </div>

      {/* Active Tenant Context Snippet */}
      <div className="p-3 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-800 dark:text-neutral-200 truncate">
          <Building2 className="w-3.5 h-3.5 shrink-0 text-neutral-500" />
          <span className="truncate">{activeProperty?.name || "No Property Selected"}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-500 font-mono">
          <span className="truncate">{activeOutlet?.name || "All Outlets"}</span>
          <span className="px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded text-[9px] uppercase">
            {activeRole?.role_key || "Role"}
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {NAV_SECTIONS.map((section) => {
          const visibleItems = section.items.filter((item) =>
            item.href === "/rooms" ? canAccessRooms : item.href === "/account" || hasPermission(item.permission)
          );
          if (visibleItems.length === 0) return null;

          return (
            <section key={section.title} className="mb-4">
              <h2 className="px-2 py-1.5 text-[10px] font-mono font-semibold uppercase tracking-wider text-neutral-400">
                {section.title}
              </h2>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const itemPath = item.href.split("#")[0];
                  const isActive = pathname === itemPath || (itemPath !== "/" && pathname.startsWith(`${itemPath}/`));
                  return (
                    <Link
                      key={item.title}
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`flex items-center gap-2.5 px-2.5 py-2 rounded text-xs font-medium transition-colors ${
                        isActive
                          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          );
        })}
      </nav>

      {/* System Phase Status Footer */}
      <div className="p-3 border-t border-neutral-200 dark:border-neutral-800 text-[11px] font-mono text-neutral-500 flex items-center justify-between bg-neutral-50/50 dark:bg-neutral-900">
        <span>Build Stage:</span>
        <span className="font-semibold text-neutral-800 dark:text-neutral-200 bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded">
          Phase 2 Active
        </span>
      </div>
    </aside>
  );
}
