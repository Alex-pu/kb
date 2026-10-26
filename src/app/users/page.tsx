"use client";

import React, { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { Loader2, Mail, Phone, ShieldCheck, UserPlus, UserRoundPen, UserRoundX, X } from "lucide-react";

interface StaffAssignment {
  id: string;
  property_id: string;
  property_code: string;
  role_id: string;
  role_name: string;
  is_active: boolean;
  outlet_id: string | null;
  station_id: string | null;
  max_discount_percent: number;
  max_void_amount: number;
  can_override_approval: boolean;
}

interface StaffMember {
  id: string;
  full_name: string;
  email: string | null;
  phone_number: string | null;
  is_active: boolean;
  pin_enabled: boolean;
  account_management_allowed: boolean;
  assignments: StaffAssignment[];
}

interface UserOption {
  id: string;
  name: string;
}

interface UserDirectory {
  success: boolean;
  message?: string;
  users?: StaffMember[];
  properties?: UserOption[];
  roles?: UserOption[];
}

interface UserForm {
  full_name: string;
  email: string;
  phone_number: string;
  password: string;
  pin: string;
  property_id: string;
  role_id: string;
  max_discount_percent: string;
  max_void_amount: string;
  can_override_approval: boolean;
}

interface EditForm {
  user: StaffMember;
  assignment_id: string;
  role_id: string;
  max_discount_percent: string;
  max_void_amount: string;
  can_override_approval: boolean;
  pin: string;
  clear_pin: boolean;
}

const emptyUserForm: UserForm = {
  full_name: "",
  email: "",
  phone_number: "",
  password: "",
  pin: "",
  property_id: "",
  role_id: "",
  max_discount_percent: "0",
  max_void_amount: "0",
  can_override_approval: false,
};

function fieldClassName() {
  return "w-full p-2 border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 text-xs";
}

export default function UsersPage() {
  const { activeProperty, currentUser } = useTenantStore();
  const [searchTerm, setSearchTerm] = useState("");
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [properties, setProperties] = useState<UserOption[]>([]);
  const [roles, setRoles] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<UserForm>(emptyUserForm);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/users", { credentials: "include" });
      const data: UserDirectory = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not load staff accounts.");
      setStaff(data.users ?? []);
      setProperties(data.properties ?? []);
      setRoles(data.roles ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const filteredUsers = staff.filter((user) => {
    const term = searchTerm.toLowerCase();
    return (
      user.full_name.toLowerCase().includes(term) ||
      user.email?.toLowerCase().includes(term) ||
      user.phone_number?.includes(searchTerm)
    );
  });

  function openCreateForm() {
    setError(null);
    setNotice(null);
    setCreateForm({
      ...emptyUserForm,
      property_id: properties.some((property) => property.id === activeProperty?.id)
        ? activeProperty!.id
        : properties[0]?.id ?? "",
      role_id: roles[0]?.id ?? "",
    });
    setShowCreate(true);
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...createForm,
          max_discount_percent: Number(createForm.max_discount_percent),
          max_void_amount: Number(createForm.max_void_amount),
        }),
      });
      const data: { success: boolean; message?: string } = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not create the staff account.");
      setShowCreate(false);
      setNotice("Staff account created.");
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  function openEditForm(user: StaffMember) {
    const assignment = user.assignments.find((item) => item.property_id === activeProperty?.id) ?? user.assignments[0];
    if (!assignment) {
      setError("This user has no assignment in a property you manage.");
      return;
    }
    setError(null);
    setNotice(null);
    setEditForm({
      user,
      assignment_id: assignment.id,
      role_id: assignment.role_id,
      max_discount_percent: String(assignment.max_discount_percent),
      max_void_amount: String(assignment.max_void_amount),
      can_override_approval: assignment.can_override_approval,
      pin: "",
      clear_pin: false,
    });
  }

  function selectAssignment(assignmentId: string) {
    if (!editForm) return;
    const assignment = editForm.user.assignments.find((item) => item.id === assignmentId);
    if (!assignment) return;
    setEditForm({
      ...editForm,
      assignment_id: assignment.id,
      role_id: assignment.role_id,
      max_discount_percent: String(assignment.max_discount_percent),
      max_void_amount: String(assignment.max_void_amount),
      can_override_approval: assignment.can_override_approval,
      pin: "",
      clear_pin: false,
    });
  }

  async function submitEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editForm) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/users", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: editForm.user.id,
          action: "update_assignment",
          assignment_id: editForm.assignment_id,
          role_id: editForm.role_id,
          max_discount_percent: Number(editForm.max_discount_percent),
          max_void_amount: Number(editForm.max_void_amount),
          can_override_approval: editForm.can_override_approval,
          pin: editForm.pin,
          clear_pin: editForm.clear_pin,
        }),
      });
      const data: { success: boolean; message?: string } = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not update privileges.");
      setEditForm(null);
      setNotice("User privileges updated.");
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(user: StaffMember) {
    const action = user.is_active ? "suspend" : "activate";
    const prompt = user.is_active
      ? `Suspend ${user.full_name}? Their active sessions will be revoked.`
      : `Reactivate ${user.full_name}?`;
    if (!window.confirm(prompt)) return;
    setPendingUserId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/users", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: user.id, action }),
      });
      const data: { success: boolean; message?: string } = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not change the account status.");
      setNotice(user.is_active ? "User suspended and sessions revoked." : "User reactivated.");
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setPendingUserId(null);
    }
  }

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              User Management &amp; Access Control
            </h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">
              Property Scope: {activeProperty?.name ?? "—"} • Role Matrix &amp; Approval Limits
            </p>
          </div>
          <button
            onClick={openCreateForm}
            disabled={properties.length === 0 || roles.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-black text-white dark:bg-white dark:text-black text-xs font-semibold rounded hover:opacity-90 transition-opacity w-fit disabled:opacity-40"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Create User</span>
          </button>
        </div>

        <div className="flex items-center gap-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-2.5 rounded">
          <input
            type="text"
            placeholder="Search users by name, email, or phone..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="flex-1 bg-transparent text-xs outline-none px-2 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 font-mono"
          />
        </div>

        {error && (
          <div role="alert" className="p-2.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-800 dark:text-red-200 rounded">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="p-2.5 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-200 rounded">
            {notice}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-neutral-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 font-mono text-neutral-500 text-[11px] uppercase">
                    <th className="py-2.5 px-4 font-semibold">User / Staff Name</th>
                    <th className="py-2.5 px-4 font-semibold">Contact</th>
                    <th className="py-2.5 px-4 font-semibold">Role</th>
                    <th className="py-2.5 px-4 font-semibold">Assigned Properties</th>
                    <th className="py-2.5 px-4 font-semibold">Max Discount</th>
                    <th className="py-2.5 px-4 font-semibold">Override Authority</th>
                    <th className="py-2.5 px-4 font-semibold">Status</th>
                    <th className="py-2.5 px-4 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800 font-mono">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-neutral-400">No staff accounts found.</td>
                    </tr>
                  ) : filteredUsers.map((user) => {
                    const currentAssignment = user.assignments.find((assignment) => assignment.property_id === activeProperty?.id) ?? user.assignments[0];
                    const isSelf = user.id === currentUser?.id;
                    return (
                      <tr key={user.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-sans font-semibold text-neutral-900 dark:text-neutral-100">{user.full_name}</div>
                          <div className="text-[10px] text-neutral-400 mt-0.5">ID: {user.id.slice(0, 8)}...</div>
                          <div className="text-[10px] text-neutral-500 mt-0.5">{user.pin_enabled ? "4-digit PIN enabled" : "Password sign-in only"}</div>
                          <div className="text-[10px] text-neutral-500 mt-0.5">{user.pin_enabled ? "4-digit PIN enabled" : "Password sign-in only"}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                            <Mail className="w-3 h-3 text-neutral-400" />
                            <span>{user.email || "N/A"}</span>
                          </div>
                          <div className="text-[10px] text-neutral-500 flex items-center gap-1.5 mt-0.5">
                            <Phone className="w-3 h-3 text-neutral-400" />
                            <span>{user.phone_number || "N/A"}</span>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded text-[10px] font-semibold text-neutral-800 dark:text-neutral-200">
                            {currentAssignment?.role_name || "Unassigned"}
                          </span>
                          {currentAssignment && !currentAssignment.is_active && <div className="mt-1 text-[10px] text-amber-600">Assignment inactive</div>}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-1">
                            {user.assignments.map((assignment) => (
                              <span
                                key={assignment.id}
                                className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  assignment.property_id === activeProperty?.id
                                    ? "bg-neutral-900 text-white dark:bg-white dark:text-black font-semibold"
                                    : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
                                }`}
                              >
                                {assignment.property_code}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-neutral-700 dark:text-neutral-300">
                          {currentAssignment ? `${currentAssignment.max_discount_percent}%` : "0%"}
                        </td>
                        <td className="py-3 px-4">
                          {currentAssignment?.can_override_approval ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold text-[10px]">
                              <ShieldCheck className="w-3.5 h-3.5" /> YES
                            </span>
                          ) : (
                            <span className="text-neutral-400 text-[10px]">NO</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center gap-1 text-[10px] ${user.is_active ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-400"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? "bg-emerald-500" : "bg-neutral-400"}`} />
                            {user.is_active ? "ACTIVE" : "SUSPENDED"}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditForm(user)}
                              disabled={!user.is_active || isSelf}
                              className="inline-flex items-center gap-1 text-[10px] text-neutral-700 dark:text-neutral-300 hover:underline disabled:opacity-40"
                              aria-label={`Edit privileges for ${user.full_name}`}
                            >
                              <UserRoundPen className="w-3.5 h-3.5" /> Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => void changeStatus(user)}
                              disabled={pendingUserId === user.id || isSelf || !user.account_management_allowed}
                              title={!user.account_management_allowed ? "This account also has assignments outside your managed properties." : undefined}
                              className="inline-flex items-center gap-1 text-[10px] text-neutral-600 dark:text-neutral-400 hover:underline disabled:opacity-40"
                              aria-label={`${user.is_active ? "Suspend" : "Reactivate"} ${user.full_name}`}
                            >
                              {pendingUserId === user.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserRoundX className="w-3.5 h-3.5" />}
                              {user.is_active ? "Suspend" : "Reactivate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form onSubmit={submitCreate} className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold text-sm">Create staff account</h2>
              <button type="button" onClick={() => setShowCreate(false)} aria-label="Close create user form"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-neutral-500">The account will be assigned to a property and role you manage.</p>
            <label className="block text-xs space-y-1">Full name
              <input required maxLength={255} value={createForm.full_name} onChange={(event) => setCreateForm({ ...createForm, full_name: event.target.value })} className={fieldClassName()} />
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs space-y-1">Email (or phone required)
                <input type="email" maxLength={255} value={createForm.email} onChange={(event) => setCreateForm({ ...createForm, email: event.target.value })} className={fieldClassName()} />
              </label>
              <label className="block text-xs space-y-1">Phone (or email required)
                <input type="tel" maxLength={50} value={createForm.phone_number} onChange={(event) => setCreateForm({ ...createForm, phone_number: event.target.value })} className={fieldClassName()} />
              </label>
            </div>
            <label className="block text-xs space-y-1">Temporary password (minimum 12 characters)
              <input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={createForm.password} onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })} className={fieldClassName()} />
            </label>
            <label className="block text-xs space-y-1">Quick-login PIN (optional, exactly 4 digits)
              <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={createForm.pin} onChange={(event) => setCreateForm({ ...createForm, pin: event.target.value.replace(/\D/g, "") })} className={fieldClassName()} />
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs space-y-1">Property
                <select required value={createForm.property_id} onChange={(event) => setCreateForm({ ...createForm, property_id: event.target.value })} className={fieldClassName()}>
                  {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
                </select>
              </label>
              <label className="block text-xs space-y-1">Role
                <select required value={createForm.role_id} onChange={(event) => setCreateForm({ ...createForm, role_id: event.target.value })} className={fieldClassName()}>
                  {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </label>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs space-y-1">Maximum discount (%)
                <input type="number" min="0" max="100" step="0.01" value={createForm.max_discount_percent} onChange={(event) => setCreateForm({ ...createForm, max_discount_percent: event.target.value })} className={fieldClassName()} />
              </label>
              <label className="block text-xs space-y-1">Maximum void amount
                <input type="number" min="0" step="0.01" value={createForm.max_void_amount} onChange={(event) => setCreateForm({ ...createForm, max_void_amount: event.target.value })} className={fieldClassName()} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={createForm.can_override_approval} onChange={(event) => setCreateForm({ ...createForm, can_override_approval: event.target.checked })} />
              Can override approval limits
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 border rounded text-xs">Cancel</button>
              <button type="submit" disabled={saving} className="px-3 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">
                {saving ? "Creating..." : "Create user"}
              </button>
            </div>
          </form>
        </div>
      )}

      {editForm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form onSubmit={submitEdit} className="w-full max-w-lg bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold text-sm">Edit privileges: {editForm.user.full_name}</h2>
              <button type="button" onClick={() => setEditForm(null)} aria-label="Close edit privileges form"><X className="w-4 h-4" /></button>
            </div>
            <label className="block text-xs space-y-1">Property assignment
              <select value={editForm.assignment_id} onChange={(event) => selectAssignment(event.target.value)} className={fieldClassName()}>
                {editForm.user.assignments.map((assignment) => (
                  <option key={assignment.id} value={assignment.id}>{assignment.property_code} {assignment.is_active ? "" : "(inactive)"}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs space-y-1">Role
              <select required value={editForm.role_id} onChange={(event) => setEditForm({ ...editForm, role_id: event.target.value })} className={fieldClassName()}>
                {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
            </label>
            <label className="block text-xs space-y-1">New 4-digit quick-login PIN
              <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" disabled={editForm.clear_pin} value={editForm.pin} onChange={(event) => setEditForm({ ...editForm, pin: event.target.value.replace(/\D/g, "") })} className={fieldClassName()} />
              <span className="text-[10px] text-neutral-500">{editForm.user.pin_enabled ? "Leave blank to keep the current PIN." : "Leave blank to keep password-only sign-in."}</span>
            </label>
            {editForm.user.pin_enabled && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={editForm.clear_pin} onChange={(event) => setEditForm({ ...editForm, clear_pin: event.target.checked, pin: "" })} />
                Disable quick PIN sign-in
              </label>
            )}
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs space-y-1">Maximum discount (%)
                <input type="number" min="0" max="100" step="0.01" value={editForm.max_discount_percent} onChange={(event) => setEditForm({ ...editForm, max_discount_percent: event.target.value })} className={fieldClassName()} />
              </label>
              <label className="block text-xs space-y-1">Maximum void amount
                <input type="number" min="0" step="0.01" value={editForm.max_void_amount} onChange={(event) => setEditForm({ ...editForm, max_void_amount: event.target.value })} className={fieldClassName()} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={editForm.can_override_approval} onChange={(event) => setEditForm({ ...editForm, can_override_approval: event.target.checked })} />
              Can override approval limits
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditForm(null)} className="px-3 py-2 border rounded text-xs">Cancel</button>
              <button type="submit" disabled={saving} className="px-3 py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">
                {saving ? "Saving..." : "Save privileges"}
              </button>
            </div>
          </form>
        </div>
      )}
    </DashboardShell>
  );
}
