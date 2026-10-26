"use client";

import React, { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { KeyRound, Loader2, LockKeyhole } from "lucide-react";

interface CredentialSettings {
  success: boolean;
  message?: string;
  pin_enabled?: boolean;
}

export default function AccountPage() {
  const [pinEnabled, setPinEnabled] = useState(false);
  const [currentMethod, setCurrentMethod] = useState<"password" | "pin">("password");
  const [currentCredential, setCurrentCredential] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [clearPin, setClearPin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/credentials", { credentials: "include" })
      .then(async (response) => {
        const data: CredentialSettings = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "Account settings could not be loaded.");
        if (!cancelled) setPinEnabled(data.pin_enabled === true);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Account settings could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function submitCredentials(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!newPassword && !newPin && !clearPin) {
      setError("Enter a new password or PIN, or choose to remove your current PIN.");
      return;
    }
    if (newPassword && newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPin && !/^\d{4}$/.test(newPin)) {
      setError("Your new PIN must contain exactly four digits.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/auth/credentials", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [currentMethod === "password" ? "current_password" : "current_pin"]: currentCredential,
          ...(newPassword ? { new_password: newPassword } : {}),
          ...(newPin ? { new_pin: newPin } : {}),
          ...(clearPin ? { clear_pin: true } : {}),
        }),
      });
      const data: CredentialSettings = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Credentials could not be updated.");
      setPinEnabled(data.pin_enabled === true);
      setCurrentCredential("");
      setNewPassword("");
      setConfirmPassword("");
      setNewPin("");
      setClearPin(false);
      setNotice(data.message || "Credentials updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DashboardShell>
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">My Account</h1>
          <p className="mt-1 text-xs text-neutral-500">Change your password or quick-login PIN while signed in.</p>
        </header>

        {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</div>}
        {notice && <div role="status" className="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div>}

        <form onSubmit={submitCredentials} className="space-y-5 rounded border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="h-4 w-4" />Confirm it’s you</h2>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button type="button" onClick={() => { setCurrentMethod("password"); setCurrentCredential(""); }} aria-pressed={currentMethod === "password"} className={`rounded border px-3 py-2 ${currentMethod === "password" ? "border-black font-semibold dark:border-white" : "border-neutral-300 text-neutral-500 dark:border-neutral-700"}`}>Current password</button>
              <button type="button" onClick={() => { setCurrentMethod("pin"); setCurrentCredential(""); }} aria-pressed={currentMethod === "pin"} disabled={!pinEnabled} className={`rounded border px-3 py-2 disabled:opacity-40 ${currentMethod === "pin" ? "border-black font-semibold dark:border-white" : "border-neutral-300 text-neutral-500 dark:border-neutral-700"}`}>Current PIN</button>
            </div>
            <label className="block space-y-1 text-xs">
              <span>{currentMethod === "pin" ? "Current four-digit PIN" : "Current password"}</span>
              <input required type="password" inputMode={currentMethod === "pin" ? "numeric" : undefined} maxLength={currentMethod === "pin" ? 4 : 128} autoComplete="off" value={currentCredential} onChange={(event) => setCurrentCredential(currentMethod === "pin" ? event.target.value.replace(/\D/g, "") : event.target.value)} className="w-full rounded border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800" />
            </label>
          </section>

          <section className="space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4" />New credentials</h2>
            <label className="block space-y-1 text-xs">
              <span>New password (at least 12 characters)</span>
              <input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="w-full rounded border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800" />
            </label>
            <label className="block space-y-1 text-xs">
              <span>Confirm new password</span>
              <input type="password" minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="w-full rounded border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800" />
            </label>
            <label className="block space-y-1 text-xs">
              <span>{pinEnabled ? "New four-digit PIN (leave blank to keep it)" : "Set a four-digit quick-login PIN (optional)"}</span>
              <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" disabled={clearPin} value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ""))} className="w-full rounded border border-neutral-300 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800 disabled:opacity-50" />
            </label>
            {pinEnabled && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={clearPin} onChange={(event) => { setClearPin(event.target.checked); setNewPin(""); }} />
                Remove my quick-login PIN
              </label>
            )}
          </section>

          <p className="text-[11px] text-neutral-500">For your security, we’ll sign out your other active sessions after a credential change. This session stays active.</p>
          <button type="submit" disabled={loading || saving} className="inline-flex items-center gap-2 rounded bg-black px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? "Saving..." : "Update credentials"}
          </button>
        </form>
      </div>
    </DashboardShell>
  );
}
