"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { PERMISSION_GROUPS } from "@/lib/auth/permissions";
import { Pencil, Plus, ShieldCheck } from "lucide-react";

interface RoleRecord {
  id: string;
  name: string;
  role_key: string;
  description: string | null;
  permissions: string[];
  is_system_role: boolean;
  editable?: boolean;
}

interface RoleResponse {
  success: boolean;
  message?: string;
  roles?: RoleRecord[];
  role?: RoleRecord;
}

interface RoleForm {
  name: string;
  description: string;
  permissions: string[];
}

const emptyForm: RoleForm = { name: "", description: "", permissions: [] };

function fieldClassName() {
  return "w-full p-2 border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 text-xs";
}

export default function RolesPage() {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<RoleRecord | null>(null);
  const [form, setForm] = useState<RoleForm>(emptyForm);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/roles", { credentials: "include" });
      const data: RoleResponse = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not load roles.");
      setRoles(data.roles ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  function startCreate() {
    setEditingRole(null);
    setForm(emptyForm);
    setError(null);
    setNotice(null);
  }

  function startEdit(role: RoleRecord) {
    if (role.is_system_role) return;
    setEditingRole(role);
    setForm({
      name: role.name,
      description: role.description ?? "",
      permissions: role.permissions,
    });
    setError(null);
    setNotice(null);
  }

  function togglePermission(permission: string) {
    setForm((current) => ({
      ...current,
      permissions: current.permissions.includes(permission)
        ? current.permissions.filter((item) => item !== permission)
        : [...current.permissions, permission],
    }));
  }

  async function saveRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/roles", {
        method: editingRole ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editingRole ? { role_id: editingRole.id } : {}),
          ...form,
        }),
      });
      const data: RoleResponse = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not save the role.");
      setNotice(editingRole
        ? "Role updated. Assigned users must sign in again for the new permissions."
        : "Role created and ready to assign to staff.");
      setEditingRole(null);
      setForm(emptyForm);
      await loadRoles();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  const selectedRoleId = editingRole?.id ?? null;

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Roles & Permissions</h1>
            <p className="text-xs text-neutral-500 mt-1">Create work-area roles and grant only the permissions each job needs.</p>
          </div>
          <button type="button" onClick={startCreate} className="inline-flex items-center gap-2 px-3 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">
            <Plus className="h-3.5 w-3.5" /> New role
          </button>
        </header>

        {error && <div role="alert" className="p-3 border border-red-300 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200 rounded text-xs">{error}</div>}
        {notice && <div role="status" className="p-3 border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200 rounded text-xs">{notice}</div>}

        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)] gap-4 items-start">
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Available roles</h2>
            {loading ? (
              <div className="p-6 text-xs text-neutral-500">Loading roles…</div>
            ) : roles.length === 0 ? (
              <div className="p-6 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded text-xs text-neutral-500">No roles are configured.</div>
            ) : roles.map((role) => (
              <article key={role.id} className={`p-4 bg-white dark:bg-neutral-900 border rounded ${selectedRoleId === role.id ? "border-neutral-900 dark:border-white" : "border-neutral-200 dark:border-neutral-800"}`}>
                <div className="flex justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold truncate">{role.name}</h3>
                    <p className="text-[10px] font-mono text-neutral-500 mt-0.5">{role.role_key}{role.is_system_role ? " • Built-in" : " • Custom"}</p>
                    {role.description && <p className="text-xs text-neutral-500 mt-2">{role.description}</p>}
                  </div>
                  {!role.is_system_role && role.editable !== false && (
                    <button type="button" onClick={() => startEdit(role)} className="h-fit inline-flex items-center gap-1 px-2 py-1 border border-neutral-300 dark:border-neutral-700 rounded text-[10px]">
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mt-3">
                  {role.permissions.map((permission) => (
                    <span key={permission} className="px-1.5 py-1 bg-neutral-100 dark:bg-neutral-800 rounded text-[9px] font-mono">{permission}</span>
                  ))}
                </div>
              </article>
            ))}
          </section>

          <form onSubmit={saveRole} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-neutral-500" />
              <h2 className="text-sm font-semibold">{editingRole ? `Edit ${editingRole.name}` : "Create a role"}</h2>
            </div>
            <label className="block text-xs space-y-1">
              Role name
              <input required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={fieldClassName()} />
            </label>
            <label className="block text-xs space-y-1">
              Description
              <textarea maxLength={500} rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className={fieldClassName()} />
            </label>

            <div className="space-y-3">
              <h3 className="text-xs font-semibold">Permissions</h3>
              {PERMISSION_GROUPS.map((group) => (
                <fieldset key={group.name} className="border border-neutral-200 dark:border-neutral-800 rounded p-3 space-y-2">
                  <legend className="px-1 text-[10px] font-mono uppercase text-neutral-500">{group.name}</legend>
                  {group.permissions.map((permission) => (
                    <label key={permission.key} className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={form.permissions.includes(permission.key)}
                        onChange={() => togglePermission(permission.key)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">{permission.label}</span>
                        <span className="block text-[10px] text-neutral-500">{permission.description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            <p className="text-[10px] text-neutral-500">Catalog permissions control item definitions. Stock permissions separately control balances, receipts, transfers, and adjustments. Role changes sign assigned users out so the new access takes effect.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={startCreate} className="px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs">Clear</button>
              <button type="submit" disabled={saving || form.permissions.length === 0} className="px-3 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">
                {saving ? "Saving…" : editingRole ? "Save role" : "Create role"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </DashboardShell>
  );
}
