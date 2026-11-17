"use client";

import React, { useEffect, useMemo, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { Mail, Send, X } from "lucide-react";

interface EmailContact {
  id: string;
  full_name: string;
  email: string;
  group_name: string;
}

interface ContactsResponse {
  success: boolean;
  message?: string;
  contacts?: EmailContact[];
}

interface SendResponse {
  success: boolean;
  message?: string;
}

interface EmailReportButtonProps {
  propertyId: string;
  propertyName: string;
  reportType: string;
  reportTitle: string;
  period: string;
  rows: Array<Array<string | number>>;
  disabled?: boolean;
}

export function EmailReportButton({
  propertyId,
  propertyName,
  reportType,
  reportTitle,
  period,
  rows,
  disabled = false,
}: EmailReportButtonProps) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<EmailContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const groups = useMemo(() => Array.from(new Set(contacts.map((contact) => contact.group_name))), [contacts]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadingContacts(true);
    setMessage(null);
    void fetch(`/api/email/contacts?property_id=${encodeURIComponent(propertyId)}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json() as ContactsResponse;
        if (!response.ok || !result.success || !Array.isArray(result.contacts)) {
          throw new Error(result.message || "Property email contacts could not be loaded.");
        }
        if (controller.signal.aborted) return;
        setContacts(result.contacts);
        setSelectedIds([]);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : "Property email contacts could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingContacts(false);
      });
    return () => controller.abort();
  }, [open, propertyId]);

  const toggleContact = (contactId: string) => {
    setSelectedIds((current) => current.includes(contactId)
      ? current.filter((id) => id !== contactId)
      : [...current, contactId]);
  };

  const toggleGroup = (groupName: string) => {
    const ids = contacts.filter((contact) => contact.group_name === groupName).map((contact) => contact.id);
    const allSelected = ids.every((id) => selectedIds.includes(id));
    setSelectedIds((current) => allSelected
      ? current.filter((id) => !ids.includes(id))
      : Array.from(new Set([...current, ...ids])));
  };

  const sendReport = async () => {
    if (sending || selectedIds.length === 0 || rows.length < 2) return;
    setSending(true);
    setMessage(null);
    try {
      const pdf = new jsPDF({
        orientation: rows[0].length > 5 ? "landscape" : "portrait",
        unit: "pt",
      });
      pdf.setProperties({ title: `${reportTitle} - ${period}`, author: propertyName });
      pdf.setFontSize(15);
      pdf.text(propertyName, 36, 36);
      pdf.setFontSize(10);
      pdf.text(reportTitle, 36, 54);
      pdf.text(period, 36, 69);
      autoTable(pdf, {
        startY: 82,
        head: [rows[0].map(String)],
        body: rows.slice(1).map((row) => row.map(String)),
        margin: { left: 36, right: 36, bottom: 36 },
        styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
        headStyles: { fillColor: [35, 35, 35] },
        theme: "grid",
      });
      const dataUri = pdf.output("datauristring");
      const separator = dataUri.indexOf(",");
      if (separator < 0) throw new Error("The report PDF could not be prepared.");
      const response = await fetch("/api/email/send-report", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          property_id: propertyId,
          report_type: reportType,
          report_title: reportTitle,
          period,
          recipient_ids: selectedIds,
          pdf_base64: dataUri.slice(separator + 1),
        }),
      });
      const result = await response.json() as SendResponse;
      if (!response.ok || !result.success) throw new Error(result.message || "The report email could not be sent.");
      setMessage(result.message || "Report email sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The report email could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      disabled={disabled || rows.length < 2}
      className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700"
    >
      <Mail className="h-3.5 w-3.5" /> Email PDF
    </button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !sending) setOpen(false);
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="email-report-title" className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="email-report-title" className="text-sm font-semibold">Email report PDF</h2>
            <p className="mt-1 text-[10px] text-neutral-500">{reportTitle} · {period}</p>
          </div>
          <button type="button" aria-label="Close" disabled={sending} onClick={() => setOpen(false)} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"><X className="h-4 w-4" /></button>
        </header>
        {loadingContacts ? <p className="text-xs text-neutral-500">Loading property contacts…</p> : contacts.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-4 text-xs text-neutral-500 dark:border-neutral-700">No contacts are available. Add contacts in Property Settings → Report email.</p>
        ) : <div className="max-h-72 space-y-3 overflow-y-auto rounded border border-neutral-200 p-3 dark:border-neutral-700">
          {groups.map((groupName) => {
            const groupContacts = contacts.filter((contact) => contact.group_name === groupName);
            const groupSelected = groupContacts.length > 0 && groupContacts.every((contact) => selectedIds.includes(contact.id));
            return <fieldset key={groupName} className="space-y-1">
              <label className="flex items-center gap-2 border-b border-neutral-100 pb-1 text-xs font-semibold dark:border-neutral-800">
                <input type="checkbox" checked={groupSelected} onChange={() => toggleGroup(groupName)} />
                {groupName} <span className="font-normal text-neutral-500">({groupContacts.length})</span>
              </label>
              {groupContacts.map((contact) => <label key={contact.id} className="flex items-start gap-2 py-1 pl-4 text-xs">
                <input type="checkbox" checked={selectedIds.includes(contact.id)} onChange={() => toggleContact(contact.id)} />
                <span>{contact.full_name}<span className="ml-1 text-[10px] text-neutral-500">{contact.email}</span></span>
              </label>)}
            </fieldset>;
          })}
        </div>}
        {message && <p role="status" className="rounded border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-800">{message}</p>}
        <footer className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-neutral-500">{selectedIds.length} recipient(s) selected</span>
          <div className="flex gap-2">
            <button type="button" disabled={sending} onClick={() => setOpen(false)} className="rounded border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700">Close</button>
            <button type="button" disabled={sending || loadingContacts || selectedIds.length === 0 || rows.length < 2} onClick={() => void sendReport()} className="inline-flex items-center gap-1.5 rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black">
              <Send className="h-3.5 w-3.5" />{sending ? "Sending…" : "Send PDF"}
            </button>
          </div>
        </footer>
      </section>
    </div>}
  </>;
}
