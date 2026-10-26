"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useTenantStore } from "@/lib/store/tenant-store";
import { KeyRound, Mail, ArrowRight, Loader2 } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { login, authLoading } = useTenantStore();
  const [identifier, setIdentifier] = useState("");
  const [credential, setCredential] = useState("");
  const [method, setMethod] = useState<"password" | "pin">("password");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(identifier, credential, method);
      if (result.success) {
        router.push("/");
      } else {
        setError(result.message || "Invalid credentials.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || authLoading;

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-neutral-100 dark:bg-neutral-950 p-4 select-none font-sans">
      <div className="w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-800 rounded shadow-xl overflow-hidden">
        {/* Header Banner */}
        <div className="p-6 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/80">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-8 h-8 bg-black dark:bg-white text-white dark:text-black flex items-center justify-center font-bold text-sm rounded">
              K
            </div>
            <div>
              <div className="font-bold text-sm leading-tight text-neutral-900 dark:text-neutral-100">
                KORE BENCH
              </div>
              <div className="text-[10px] text-neutral-500 font-mono tracking-wider uppercase">
                Hospitality & Retail Suite
              </div>
            </div>
          </div>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
            Sign in to access your assigned property workstation and till register.
          </p>
        </div>

        {/* Main Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-2.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-xs font-mono text-neutral-800 dark:text-neutral-200 rounded">
              {error}
            </div>
          )}

          {/* Identifier Input */}
          <div className="space-y-1 text-xs font-mono">
            <label className="text-neutral-600 dark:text-neutral-400">Email or Staff Username</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-neutral-400">
                <Mail className="w-3.5 h-3.5" />
              </div>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete="username"
                className="w-full pl-8 pr-3 py-2 border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none focus:border-black dark:focus:border-white font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <button
              type="button"
              onClick={() => { setMethod("password"); setCredential(""); }}
              aria-pressed={method === "password"}
              className={`py-2 border rounded ${method === "password" ? "border-black dark:border-white font-semibold" : "border-neutral-300 dark:border-neutral-700 text-neutral-500"}`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => { setMethod("pin"); setCredential(""); }}
              aria-pressed={method === "pin"}
              className={`py-2 border rounded ${method === "pin" ? "border-black dark:border-white font-semibold" : "border-neutral-300 dark:border-neutral-700 text-neutral-500"}`}
            >
              4-digit staff PIN
            </button>
          </div>

          <div className="space-y-1 text-xs font-mono">
            <label className="text-neutral-600 dark:text-neutral-400">{method === "pin" ? "Staff PIN" : "Password"}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-neutral-400">
                <KeyRound className="w-3.5 h-3.5" />
              </div>
              <input
                type="password"
                inputMode={method === "pin" ? "numeric" : undefined}
                maxLength={method === "pin" ? 4 : 128}
                value={credential}
                onChange={(e) => setCredential(method === "pin" ? e.target.value.replace(/\D/g, "") : e.target.value)}
                required
                autoComplete={method === "pin" ? "off" : "current-password"}
                className="w-full pl-8 pr-3 py-2 border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none focus:border-black dark:focus:border-white font-mono text-xs"
              />
            </div>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2 bg-black text-white dark:bg-white dark:text-black font-semibold text-xs rounded hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            <span>{busy ? "Signing in…" : "Authenticate Session"}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
