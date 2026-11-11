"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2, LogOut, Plus } from "lucide-react";
import { useTenantStore } from "@/lib/store/tenant-store";

interface CreatePropertyResponse {
  success: boolean;
  message: string;
  property_id?: string;
  admin_email?: string;
}

const fieldClassName = "w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-white";
const labelClassName = "mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300";

export default function SuperAdminPage() {
  const router = useRouter();
  const { currentUser, logout } = useTenantStore();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [form, setForm] = useState({
    company_name: "",
    tax_pin: "",
    country_code: "KE",
    currency: "KES",
    property_name: "",
    property_code: "",
    property_type: "hotel",
    property_address: "",
    property_phone: "",
    property_email: "",
    outlet_name: "Main Outlet",
    outlet_code: "MAIN",
    outlet_type: "front_desk",
    station_name: "Front Desk",
    station_type: "reception_terminal",
    admin_name: "",
    admin_email: "",
    admin_phone: "",
    admin_password: "",
  });

  function updateField(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/properties", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const result: CreatePropertyResponse = await response.json();
      if (!response.ok || !result.success) {
        setError(result.message || "Property creation failed.");
        return;
      }
      setSuccess(`${result.message} The property admin can sign in with ${result.admin_email}.`);
      setForm((current) => ({
        ...current,
        company_name: "",
        tax_pin: "",
        property_name: "",
        property_code: "",
        property_address: "",
        property_phone: "",
        property_email: "",
        admin_name: "",
        admin_email: "",
        admin_phone: "",
        admin_password: "",
      }));
    } catch {
      setError("Could not reach the server. No property was confirmed as created.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-100 px-4 py-8 dark:bg-neutral-950 sm:px-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-col gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-neutral-500">
              <Building2 className="h-4 w-4" /> Platform administration
            </div>
            <h1 className="text-2xl font-bold">Create a property</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Signed in as {currentUser?.email || currentUser?.full_name}. This creates a company, its first property and outlet, and a property administrator.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logout().then(() => router.replace("/login"))}
            className="inline-flex items-center gap-2 self-start rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 sm:self-auto"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </header>

        {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</p>}
        {success && <p role="status" className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">{success}</p>}

        <form onSubmit={handleSubmit} className="space-y-6 rounded border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 sm:p-7">
          <section className="grid gap-4 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-semibold">Company</h2>
            <label><span className={labelClassName}>Company name</span><input className={fieldClassName} required maxLength={255} value={form.company_name} onChange={(event) => updateField("company_name", event.target.value)} /></label>
            <label><span className={labelClassName}>KRA PIN (optional)</span><input className={fieldClassName} maxLength={50} value={form.tax_pin} onChange={(event) => updateField("tax_pin", event.target.value)} /></label>
            <label><span className={labelClassName}>Country code</span><input className={fieldClassName} required minLength={2} maxLength={2} value={form.country_code} onChange={(event) => updateField("country_code", event.target.value)} /></label>
            <label><span className={labelClassName}>Currency</span><input className={fieldClassName} required minLength={3} maxLength={3} value={form.currency} onChange={(event) => updateField("currency", event.target.value)} /></label>
          </section>

          <section className="grid gap-4 border-t border-neutral-200 pt-5 dark:border-neutral-800 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-semibold">First property</h2>
            <label><span className={labelClassName}>Property name</span><input className={fieldClassName} required maxLength={255} value={form.property_name} onChange={(event) => updateField("property_name", event.target.value)} /></label>
            <label><span className={labelClassName}>Property code</span><input className={fieldClassName} required maxLength={50} value={form.property_code} onChange={(event) => updateField("property_code", event.target.value)} /></label>
            <label><span className={labelClassName}>Property type</span><select className={fieldClassName} value={form.property_type} onChange={(event) => updateField("property_type", event.target.value)}><option value="hotel">Hotel</option><option value="restaurant">Restaurant</option><option value="retail">Retail</option><option value="hybrid">Hybrid</option></select></label>
            <label><span className={labelClassName}>Property email (optional)</span><input className={fieldClassName} type="email" maxLength={255} value={form.property_email} onChange={(event) => updateField("property_email", event.target.value)} /></label>
            <label><span className={labelClassName}>Phone (optional)</span><input className={fieldClassName} maxLength={50} value={form.property_phone} onChange={(event) => updateField("property_phone", event.target.value)} /></label>
            <label><span className={labelClassName}>Address (optional)</span><input className={fieldClassName} maxLength={2000} value={form.property_address} onChange={(event) => updateField("property_address", event.target.value)} /></label>
          </section>

          <section className="grid gap-4 border-t border-neutral-200 pt-5 dark:border-neutral-800 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-semibold">First outlet and station</h2>
            <label><span className={labelClassName}>Outlet name</span><input className={fieldClassName} required maxLength={255} value={form.outlet_name} onChange={(event) => updateField("outlet_name", event.target.value)} /></label>
            <label><span className={labelClassName}>Outlet code</span><input className={fieldClassName} required maxLength={50} value={form.outlet_code} onChange={(event) => updateField("outlet_code", event.target.value)} /></label>
            <label><span className={labelClassName}>Outlet type</span><select className={fieldClassName} value={form.outlet_type} onChange={(event) => updateField("outlet_type", event.target.value)}><option value="front_desk">Front desk</option><option value="retail_counter">Retail counter</option><option value="restaurant">Restaurant</option><option value="bar">Bar</option><option value="kitchen">Kitchen</option><option value="store">Store</option></select></label>
            <label><span className={labelClassName}>Station name</span><input className={fieldClassName} required maxLength={255} value={form.station_name} onChange={(event) => updateField("station_name", event.target.value)} /></label>
            <label><span className={labelClassName}>Station type</span><select className={fieldClassName} value={form.station_type} onChange={(event) => updateField("station_type", event.target.value)}><option value="pos_till">POS till</option><option value="kds_screen">Kitchen display</option><option value="reception_terminal">Reception terminal</option><option value="store_terminal">Store terminal</option></select></label>
          </section>

          <section className="grid gap-4 border-t border-neutral-200 pt-5 dark:border-neutral-800 sm:grid-cols-2">
            <h2 className="sm:col-span-2 text-sm font-semibold">Initial property administrator</h2>
            <label><span className={labelClassName}>Full name</span><input className={fieldClassName} required maxLength={255} autoComplete="name" value={form.admin_name} onChange={(event) => updateField("admin_name", event.target.value)} /></label>
            <label><span className={labelClassName}>Sign-in email</span><input className={fieldClassName} type="email" required maxLength={255} autoComplete="username" value={form.admin_email} onChange={(event) => updateField("admin_email", event.target.value)} /></label>
            <label><span className={labelClassName}>Phone (optional)</span><input className={fieldClassName} maxLength={50} autoComplete="tel" value={form.admin_phone} onChange={(event) => updateField("admin_phone", event.target.value)} /></label>
            <label><span className={labelClassName}>Temporary password (12–128 characters)</span><input className={fieldClassName} type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={form.admin_password} onChange={(event) => updateField("admin_password", event.target.value)} /></label>
          </section>

          <div className="flex justify-end border-t border-neutral-200 pt-5 dark:border-neutral-800">
            <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {submitting ? "Creating property…" : "Create property"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
