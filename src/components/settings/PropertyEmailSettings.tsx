"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Check, Mail, Pencil, Plus, Send, Trash2 } from "lucide-react";

interface PropertyEmailConfig {
  smtp_host: string;
  smtp_port: 465 | 587;
  smtp_username: string;
  from_address: string;
  has_password: boolean;
}

interface EmailContact {
  id: string;
  full_name: string;
  email: string;
  group_name: string;
}

interface ApiResponse {
  success: boolean;
  message?: string;
  config?: PropertyEmailConfig;
  contacts?: EmailContact[];
  contact?: EmailContact;
  has_password?: boolean;
}

const EMPTY_CONFIG: PropertyEmailConfig = {
  smtp_host: "",
  smtp_port: 465,
  smtp_username: "",
  from_address: "",
  has_password: false,
};

const inputClass = "block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white";

export function PropertyEmailSettings({ propertyId }: { propertyId: string }) {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [password, setPassword] = useState("");
  const [contacts, setContacts] = useState<EmailContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [contactMessage, setContactMessage] = useState<string | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState({ full_name: "", email: "", group_name: "General" });

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [settingsResponse, contactsResponse] = await Promise.all([
        fetch(`/api/email/settings?property_id=${encodeURIComponent(propertyId)}`, { credentials: "include", signal }),
        fetch(`/api/email/contacts?property_id=${encodeURIComponent(propertyId)}`, { credentials: "include", signal }),
      ]);
      const [settingsData, contactsData] = await Promise.all([
        settingsResponse.json() as Promise<ApiResponse>,
        contactsResponse.json() as Promise<ApiResponse>,
      ]);
      if (!settingsResponse.ok || !settingsData.success) {
        throw new Error(settingsData.message || "Email settings could not be loaded.");
      }
      if (!contactsResponse.ok || !contactsData.success || !Array.isArray(contactsData.contacts)) {
        throw new Error(contactsData.message || "Email contacts could not be loaded.");
      }
      setConfig(settingsData.config || EMPTY_CONFIG);
      setContacts(contactsData.contacts);
      setMessage(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage(error instanceof Error ? error.message : "Email settings could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    const controller = new AbortController();
    setConfig(EMPTY_CONFIG);
    setPassword("");
    setContacts([]);
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/email/settings", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: propertyId,
          smtp_host: config.smtp_host,
          smtp_port: config.smtp_port,
          smtp_username: config.smtp_username,
          from_address: config.from_address,
          password,
        }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.message || "Email settings could not be saved.");
      setPassword("");
      setConfig((current) => ({ ...current, has_password: true }));
      setMessage(result.message || "Email settings saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    if (testing) return;
    setTesting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/email/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId, recipient: testRecipient }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.message || "The test email could not be sent.");
      setMessage(result.message || "Test email sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The test email could not be sent.");
    } finally {
      setTesting(false);
    }
  };

  const saveContact = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (contactBusy) return;
    setContactBusy(true);
    setContactMessage(null);
    try {
      const response = await fetch("/api/email/contacts", {
        method: editingContactId ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: propertyId,
          ...(editingContactId ? { contact_id: editingContactId } : {}),
          ...contactForm,
        }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success || !result.contact) {
        throw new Error(result.message || "The email contact could not be saved.");
      }
      const savedContact = result.contact;
      setContacts((current) => {
        const next = current.filter((contact) => contact.id !== savedContact.id);
        return [...next, savedContact].sort((a, b) =>
          a.group_name.localeCompare(b.group_name) || a.full_name.localeCompare(b.full_name)
        );
      });
      setContactForm({ full_name: "", email: "", group_name: "General" });
      setEditingContactId(null);
      setContactMessage(editingContactId ? "Contact updated." : "Contact added.");
    } catch (error) {
      setContactMessage(error instanceof Error ? error.message : "The email contact could not be saved.");
    } finally {
      setContactBusy(false);
    }
  };

  const removeContact = async (contact: EmailContact) => {
    if (contactBusy || !window.confirm(`Remove ${contact.full_name} from this property's email contacts?`)) return;
    setContactBusy(true);
    setContactMessage(null);
    try {
      const response = await fetch("/api/email/contacts", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_id: propertyId, contact_id: contact.id }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.message || "The contact could not be removed.");
      setContacts((current) => current.filter((item) => item.id !== contact.id));
      if (editingContactId === contact.id) {
        setEditingContactId(null);
        setContactForm({ full_name: "", email: "", group_name: "General" });
      }
      setContactMessage(result.message || "Contact removed.");
    } catch (error) {
      setContactMessage(error instanceof Error ? error.message : "The contact could not be removed.");
    } finally {
      setContactBusy(false);
    }
  };

  return (
    <section className="space-y-5 rounded border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Mail className="h-4 w-4" />Report email</h2>
        <p className="mt-1 text-[10px] text-neutral-500">
          Configure this property's authenticated SMTP mailbox. The password is encrypted at rest and never shown after saving.
          Port 465 uses SSL/TLS; port 587 uses STARTTLS.
        </p>
      </div>
      {loading ? <p className="text-xs text-neutral-500">Loading email settings…</p> : <>
        <form onSubmit={saveSettings} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-neutral-500">SMTP server
              <input required maxLength={253} autoComplete="url" placeholder="mail.example.com" value={config.smtp_host} onChange={(event) => setConfig((current) => ({ ...current, smtp_host: event.target.value }))} className={inputClass} />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">SMTP port
              <select value={config.smtp_port} onChange={(event) => setConfig((current) => ({ ...current, smtp_port: Number(event.target.value) as 465 | 587 }))} className={inputClass}>
                <option value={465}>465 — SSL/TLS</option>
                <option value={587}>587 — STARTTLS</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-neutral-500">SMTP username
              <input required type="email" maxLength={320} autoComplete="username" value={config.smtp_username} onChange={(event) => setConfig((current) => ({ ...current, smtp_username: event.target.value }))} className={inputClass} />
            </label>
            <label className="space-y-1 text-xs text-neutral-500">From email address
              <input required type="email" maxLength={320} autoComplete="email" value={config.from_address} onChange={(event) => setConfig((current) => ({ ...current, from_address: event.target.value }))} className={inputClass} />
            </label>
            <label className="space-y-1 text-xs text-neutral-500 sm:col-span-2">Mailbox password
              <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={config.has_password ? "Saved securely; leave blank to keep" : "Enter the mailbox password"} className={inputClass} />
            </label>
          </div>
          <button type="submit" disabled={saving} className="rounded bg-black px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black">
            {saving ? "Saving…" : "Save email settings"}
          </button>
        </form>

        <div className="flex flex-wrap items-end gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <label className="min-w-64 flex-1 space-y-1 text-xs text-neutral-500">Send test email to
            <input required type="email" maxLength={320} value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} className={inputClass} />
          </label>
          <button type="button" onClick={() => void sendTest()} disabled={testing || !config.has_password || !testRecipient} className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-40 dark:border-neutral-700">
            <Send className="h-3.5 w-3.5" />{testing ? "Sending…" : "Send test"}
          </button>
        </div>
      </>}
      {message && <p role="status" className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">{message}</p>}

      <div className="space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <h3 className="text-xs font-semibold">Property contacts and groups</h3>
          <p className="mt-1 text-[10px] text-neutral-500">Contacts are private to this property. Use the same group name to select several people together when emailing a report.</p>
        </div>
        <form onSubmit={saveContact} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input required maxLength={160} placeholder="Contact name" value={contactForm.full_name} onChange={(event) => setContactForm((current) => ({ ...current, full_name: event.target.value }))} className={inputClass} />
          <input required type="email" maxLength={320} placeholder="Email address" value={contactForm.email} onChange={(event) => setContactForm((current) => ({ ...current, email: event.target.value }))} className={inputClass} />
          <input required maxLength={120} placeholder="Group (e.g. Managers)" value={contactForm.group_name} onChange={(event) => setContactForm((current) => ({ ...current, group_name: event.target.value }))} className={inputClass} />
          <button type="submit" disabled={contactBusy} className="inline-flex items-center justify-center gap-1 rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black">
            {editingContactId ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}{editingContactId ? "Update" : "Add"}
          </button>
        </form>
        {editingContactId && <button type="button" onClick={() => { setEditingContactId(null); setContactForm({ full_name: "", email: "", group_name: "General" }); }} className="text-[10px] text-neutral-500 underline">Cancel edit</button>}
        {contactMessage && <p role="status" className="text-xs">{contactMessage}</p>}
        {contacts.length === 0 ? <p className="text-xs text-neutral-500">No email contacts added yet.</p> : (
          <div className="divide-y divide-neutral-100 rounded border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {contacts.map((contact) => <div key={contact.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-xs">
              <div><div className="font-medium">{contact.full_name}</div><div className="text-[10px] text-neutral-500">{contact.email} · {contact.group_name}</div></div>
              <div className="flex gap-1">
                <button type="button" aria-label={`Edit ${contact.full_name}`} onClick={() => { setEditingContactId(contact.id); setContactForm({ full_name: contact.full_name, email: contact.email, group_name: contact.group_name }); }} className="rounded p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label={`Remove ${contact.full_name}`} disabled={contactBusy} onClick={() => void removeContact(contact)} className="rounded p-2 text-red-600 hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-950/30"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>)}
          </div>
        )}
      </div>
    </section>
  );
}
