export const PERMISSION_GROUPS = [
  {
    name: "Front Office",
    permissions: [
      { key: "pos:read", label: "View POS", description: "Open the point-of-sale workspace." },
      { key: "pos:write", label: "Operate POS", description: "Build carts and complete sales." },
      { key: "shift:open", label: "Open shifts", description: "Start an authorized cashier shift." },
      { key: "shift:close", label: "Close own shifts", description: "Close shifts opened by this user." },
      { key: "restaurant:read", label: "View restaurant", description: "View tables, orders, and kitchen status." },
      { key: "restaurant:write", label: "Operate restaurant", description: "Create and edit orders, send kitchen rounds, and request room charges." },
      { key: "restaurant:settle", label: "Clear waiter bills", description: "Record payment and clear open bills created by waiters." },
      { key: "frontdesk:read", label: "View front desk", description: "View rooms, bookings, and folios." },
      { key: "frontdesk:write", label: "Operate front desk", description: "Manage bookings, room status, and folios." },
      { key: "housekeeping:write", label: "Update housekeeping status", description: "Move vacant or reserved rooms through cleaning to ready." },
      { key: "housekeeping:manage", label: "Manage housekeeping assignments", description: "Assign room cleaning jobs to housekeeping staff." },
      { key: "kds:read", label: "View KDS", description: "Open kitchen tickets in read-only mode." },
      { key: "kds:manage", label: "Manage KDS", description: "Advance and cancel kitchen tickets." },
    ],
  },
  {
    name: "Store Requests",
    permissions: [
      { key: "inventory:request", label: "Request supplies", description: "Request non-sale supplies from Central Store and track fulfillment." },
    ],
  },
  {
    name: "Room Setup",
    permissions: [
      { key: "rooms:manage", label: "Manage room inventory", description: "Create room categories and add physical rooms." },
    ],
  },
  {
    name: "Back Office",
    permissions: [
      { key: "catalog:read", label: "View item catalog", description: "View products and menu definitions." },
      { key: "catalog:manage", label: "Manage item catalog", description: "Create and edit products, prices, and categories." },
      { key: "inventory:read", label: "View stock and supplies", description: "View stock balances and supply records." },
      { key: "inventory:manage", label: "Manage stock and supplies", description: "Receive, transfer, and adjust stock." },
      { key: "accounting:read", label: "View accounting", description: "View the ledger and financial records." },
      { key: "accounting:write", label: "Post accounting entries", description: "Record expenses and post or reverse journal entries." },
      { key: "dashboard:read", label: "View dashboard", description: "Open the operations dashboard." },
      { key: "analytics:read", label: "View analytics", description: "Open operational reports and analytics." },
      { key: "audit:read", label: "View activity logs", description: "Read the company audit trail." },
      { key: "settings:manage", label: "Manage settings", description: "Change property and integration settings." },
      { key: "users:manage", label: "Manage staff accounts", description: "Create, suspend, and update staff assignments." },
      { key: "roles:manage", label: "Manage roles", description: "Create custom roles and edit their permissions." },
    ],
  },
] as const;

export type PermissionKey = (typeof PERMISSION_GROUPS)[number]["permissions"][number]["key"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key)
);

const IMPLIED_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  "pos:write": ["pos:read"],
  "restaurant:write": ["restaurant:read"],
  "restaurant:settle": ["restaurant:read"],
  "frontdesk:write": ["frontdesk:read"],
  "housekeeping:manage": ["housekeeping:write"],
  "rooms:manage": ["frontdesk:read"],
  "kds:manage": ["kds:read"],
  "catalog:manage": ["catalog:read"],
  "inventory:manage": ["inventory:read", "inventory:request"],
  "accounting:write": ["accounting:read"],
};

export function permissionGranted(permissions: readonly string[], requested: string): boolean {
  if (permissions.includes("*") || permissions.includes(requested)) return true;
  return Object.entries(IMPLIED_PERMISSIONS).some(
    ([grant, implied]) => permissions.includes(grant) && implied.includes(requested)
  );
}

const PAGE_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["/", "dashboard:read"],
  ["/users", "users:manage"],
  ["/roles", "roles:manage"],
  ["/pos", "pos:read"],
  ["/catalog", "catalog:read"],
  ["/dining", "restaurant:read"],
  ["/kds", "kds:read"],
  ["/rooms", "frontdesk:read"],
  ["/housekeeping", "housekeeping:write"],
  ["/stock", "inventory:read"],
  ["/store-requests", "inventory:request"],
  ["/accounting", "accounting:read"],
  ["/reports", "analytics:read"],
  ["/audit-logs", "audit:read"],
  ["/settings", "settings:manage"],
];

export function permissionForPage(pathname: string): string | null {
  return PAGE_PERMISSIONS.find(([path]) =>
    path === "/" ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)
  )?.[1] ?? null;
}

const LANDING_PAGE_CANDIDATES = [
  "/",
  "/pos",
  "/dining",
  "/housekeeping",
  "/rooms",
  "/kds",
  "/store-requests",
  "/stock",
  "/catalog",
  "/accounting",
  "/reports",
  "/audit-logs",
  "/users",
  "/roles",
  "/settings",
];

export function landingPageForUser(hasPermission: (permission: string) => boolean): string | null {
  return LANDING_PAGE_CANDIDATES.find((path) => {
    const permission = permissionForPage(path);
    return permission !== null && hasPermission(permission);
  }) ?? null;
}
