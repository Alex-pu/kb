import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { permissionGranted } from "@/lib/auth/permissions";
import { cashierOutletIdsForUser, getUserBundle, hasCashierOutletReservations, resolveSessionUserId, type UserBundle } from "@/lib/db/auth-repository";

export interface AuthContext {
  userId: string;
  bundle: UserBundle;
}

/**
 * Reads the session cookie, verifies its signature, checks it against the
 * `sessions` table (not expired/revoked), and loads the user's full
 * company/property/outlet/role bundle. Returns null if any step fails — every
 * API route that touches tenant data must call this and reject with 401 on
 * null rather than trusting anything the client sends.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const sessionId = verifySessionToken(cookieValue);
  if (!sessionId) return null;

  const userId = await resolveSessionUserId(sessionId);
  if (!userId) return null;

  const bundle = await getUserBundle(userId);
  if (!bundle) return null;
  const cashierOutletIds = cashierOutletIdsForUser(bundle);
  if (!await hasCashierOutletReservations(sessionId, userId, cashierOutletIds)) return null;

  return { userId, bundle };
}

/** Returns the permission set granted to `userId` for the given property, or an empty array if they have no active assignment there. */
export function permissionsForProperty(bundle: UserBundle, propertyId: string): string[] {
  return Array.from(new Set(
    bundle.assignments
      .filter((assignment) => assignment.property_id === propertyId)
      .flatMap((assignment) => assignment.role?.permissions ?? [])
  ));
}

export function hasPermission(bundle: UserBundle, propertyId: string, permission: string): boolean {
  const perms = permissionsForProperty(bundle, propertyId);
  return permissionGranted(perms, permission);
}

/**
 * Confirms the signed-in user is allowed to operate on `outletId` (the outlet
 * must belong to one of their assigned properties) and returns the resolved
 * property id, or null if they have no business touching that outlet at all.
 * Route handlers must call this before trusting any outlet_id a client sends.
 */
export function assertOutletAccess(bundle: UserBundle, outletId: string): { propertyId: string } | null {
  const outlet = bundle.outlets.find((o) => o.id === outletId);
  if (!outlet) return null;
  const hasPropertyAssignment = bundle.assignments.some((a) => a.property_id === outlet.property_id);
  if (!hasPropertyAssignment) return null;
  return { propertyId: outlet.property_id };
}
