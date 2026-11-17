import { NextResponse } from "next/server";
import type { QueryResultRow } from "pg";
import { getAuthContext } from "@/lib/auth/require-session";
import { databaseReady, withUserContext } from "@/lib/db/postgres";
import {
  canManagePropertyEmail,
  canReadPropertyEmailContacts,
  PROPERTY_ID_PATTERN,
} from "@/lib/email/property-access";

export const runtime = "nodejs";

interface ContactRow extends QueryResultRow {
  id: string;
  full_name: string;
  email: string;
  group_name: string;
}

function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

export async function GET(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const propertyId = new URL(request.url).searchParams.get("property_id") ?? "";
  if (!PROPERTY_ID_PATTERN.test(propertyId)) return errorResponse("A valid property is required.");
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  if (!canReadPropertyEmailContacts(auth.bundle, propertyId)) {
    return errorResponse("You do not have permission to view this property's email contacts.", 403);
  }

  try {
    const result = await withUserContext(auth.userId, (run) => run<ContactRow>(
      `SELECT id, full_name, email, group_name
       FROM property_email_contacts
       WHERE property_id = $1
       ORDER BY LOWER(group_name), LOWER(full_name), LOWER(email)`,
      [propertyId],
    ));
    return NextResponse.json({ success: true, contacts: result.rows });
  } catch (error) {
    console.error("Failed to load property email contacts.", error);
    return errorResponse("Email contacts could not be loaded.", 500);
  }
}

export async function POST(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");
  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  if (!PROPERTY_ID_PATTERN.test(propertyId)) return errorResponse("A valid property is required.");
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  if (!canManagePropertyEmail(auth.bundle, propertyId)) {
    return errorResponse("You do not have permission to manage email contacts for this property.", 403);
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "General";
  if (!fullName || fullName.length > 160 || !validEmail(email) ||
      !groupName || groupName.length > 120 || /[\r\n\0]/.test(fullName + groupName)) {
    return errorResponse("Enter a contact name, valid email address, and group (up to 120 characters).");
  }

  try {
    const result = await withUserContext(auth.userId, (run) => run<ContactRow>(
      `INSERT INTO property_email_contacts (property_id, full_name, email, group_name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, group_name`,
      [propertyId, fullName, email, groupName, auth.userId],
    ));
    return NextResponse.json({ success: true, contact: result.rows[0] }, { status: 201 });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return errorResponse("That email address is already in this property's contact list.", 409);
    }
    console.error("Failed to create property email contact.", error);
    return errorResponse("The email contact could not be saved.", 500);
  }
}

export async function PATCH(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");
  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const contactId = typeof body.contact_id === "string" ? body.contact_id : "";
  if (!PROPERTY_ID_PATTERN.test(propertyId) || !PROPERTY_ID_PATTERN.test(contactId)) {
    return errorResponse("A valid property and contact are required.");
  }
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  if (!canManagePropertyEmail(auth.bundle, propertyId)) {
    return errorResponse("You do not have permission to manage email contacts for this property.", 403);
  }

  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "";
  if (!fullName || fullName.length > 160 || !validEmail(email) ||
      !groupName || groupName.length > 120 || /[\r\n\0]/.test(fullName + groupName)) {
    return errorResponse("Enter a contact name, valid email address, and group (up to 120 characters).");
  }

  try {
    const result = await withUserContext(auth.userId, (run) => run<ContactRow>(
      `UPDATE property_email_contacts
       SET full_name = $3, email = $4, group_name = $5, updated_at = NOW()
       WHERE property_id = $1 AND id = $2
       RETURNING id, full_name, email, group_name`,
      [propertyId, contactId, fullName, email, groupName],
    ));
    if (!result.rows[0]) return errorResponse("The contact was not found for this property.", 404);
    return NextResponse.json({ success: true, contact: result.rows[0] });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return errorResponse("That email address is already in this property's contact list.", 409);
    }
    console.error("Failed to update property email contact.", error);
    return errorResponse("The email contact could not be updated.", 500);
  }
}

export async function DELETE(request: Request) {
  if (!databaseReady()) return errorResponse("DATABASE_URL is not configured.", 503);
  const body = await readBody(request);
  if (!body) return errorResponse("Request body must be a valid JSON object.");
  const propertyId = typeof body.property_id === "string" ? body.property_id : "";
  const contactId = typeof body.contact_id === "string" ? body.contact_id : "";
  if (!PROPERTY_ID_PATTERN.test(propertyId) || !PROPERTY_ID_PATTERN.test(contactId)) {
    return errorResponse("A valid property and contact are required.");
  }
  const auth = await getAuthContext();
  if (!auth) return errorResponse("Not signed in.", 401);
  if (!canManagePropertyEmail(auth.bundle, propertyId)) {
    return errorResponse("You do not have permission to manage email contacts for this property.", 403);
  }

  try {
    const result = await withUserContext(auth.userId, (run) => run(
      `DELETE FROM property_email_contacts WHERE property_id = $1 AND id = $2 RETURNING id`,
      [propertyId, contactId],
    ));
    if (!result.rowCount) return errorResponse("The contact was not found for this property.", 404);
    return NextResponse.json({ success: true, message: "Email contact removed." });
  } catch (error) {
    console.error("Failed to remove property email contact.", error);
    return errorResponse("The email contact could not be removed.", 500);
  }
}
