import type { UserBundle } from "@/lib/db/auth-repository";
import { hasPermission } from "@/lib/auth/require-session";

export const PROPERTY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hasPropertyAssignment(bundle: UserBundle, propertyId: string): boolean {
  return bundle.assignments.some((assignment) => assignment.property_id === propertyId);
}

export function canManagePropertyEmail(bundle: UserBundle, propertyId: string): boolean {
  return hasPropertyAssignment(bundle, propertyId) && hasPermission(bundle, propertyId, "settings:manage");
}

export function canReadPropertyEmailContacts(bundle: UserBundle, propertyId: string): boolean {
  return hasPropertyAssignment(bundle, propertyId) && (
    hasPermission(bundle, propertyId, "settings:manage") ||
    hasPermission(bundle, propertyId, "analytics:read") ||
    hasPermission(bundle, propertyId, "inventory:read") ||
    hasPermission(bundle, propertyId, "accounting:read")
  );
}

export function canSendPropertyReport(bundle: UserBundle, propertyId: string, reportType: string): boolean {
  if (!hasPropertyAssignment(bundle, propertyId)) return false;
  if (reportType === "purchases") return hasPermission(bundle, propertyId, "inventory:read");
  if (!hasPermission(bundle, propertyId, "analytics:read")) return false;
  return reportType !== "financials" || hasPermission(bundle, propertyId, "accounting:read");
}
