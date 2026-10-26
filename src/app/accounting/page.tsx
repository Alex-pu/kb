"use client";

import React, { useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { JournalLine } from "@/lib/types/database";
import { BarChart3, BookOpen, Check, FileText, Plus, RotateCcw, Wallet } from "lucide-react";

export default function AccountingPage() {
  const { chartOfAccounts, journalEntries, expenses, recordExpense, postManualJournalEntry, reverseJournalEntry, hasPermission } = useTenantStore();
  const canWriteAccounting = hasPermission("accounting:write");
  const [tab, setTab] = useState<"overview" | "journal" | "accounts" | "reports">("overview");
  const [message, setMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [expense, setExpense] = useState({ description: "", amount: "", accountId: "acct-5000", category: "Operating expense" });
  const [manual, setManual] = useState({ description: "", debitAccount: "acct-5000", creditAccount: "acct-1000", amount: "" });

  const accountName = (id: string) => chartOfAccounts.find((account) => account.id === id)?.name || id;
  const reportEntries = useMemo(() => journalEntries.filter((entry) => {
    const entryDate = entry.date.slice(0, 10);
    return (!fromDate || entryDate >= fromDate) && (!toDate || entryDate <= toDate);
  }), [fromDate, journalEntries, toDate]);
  const balances = useMemo(() => {
    const result = Object.fromEntries(chartOfAccounts.map((account) => [account.id, 0]));
    reportEntries.forEach((entry) => entry.lines.forEach((line) => {
      result[line.account_id] = (result[line.account_id] || 0) + line.debit - line.credit;
    }));
    return result;
  }, [chartOfAccounts, reportEntries]);
  const revenue = chartOfAccounts.filter((account) => account.type === "revenue").reduce((sum, account) => sum - (balances[account.id] || 0), 0);
  const expensesTotal = chartOfAccounts.filter((account) => account.type === "expense").reduce((sum, account) => sum + (balances[account.id] || 0), 0);
  const assets = chartOfAccounts.filter((account) => account.type === "asset").reduce((sum, account) => sum + (balances[account.id] || 0), 0);
  const liabilities = chartOfAccounts.filter((account) => account.type === "liability").reduce((sum, account) => sum - (balances[account.id] || 0), 0);
  const equity = chartOfAccounts.filter((account) => account.type === "equity").reduce((sum, account) => sum - (balances[account.id] || 0), 0);
  const netProfit = revenue - expensesTotal;
  const trialBalance = chartOfAccounts.map((account) => {
    const debit = reportEntries.reduce((sum, entry) => sum + entry.lines.filter((line) => line.account_id === account.id).reduce((lineSum, line) => lineSum + line.debit, 0), 0);
    const credit = reportEntries.reduce((sum, entry) => sum + entry.lines.filter((line) => line.account_id === account.id).reduce((lineSum, line) => lineSum + line.credit, 0), 0);
    return { account, debit, credit };
  });
  const cashFlow = ["acct-1000", "acct-1010", "acct-1020"].reduce((sum, accountId) => sum + (balances[accountId] || 0), 0);
  const selectedEntry = journalEntries.find((entry) => entry.id === selectedEntryId) || null;

  const submitExpense = () => {
    const result = recordExpense(expense.description, Number(expense.amount), expense.accountId, expense.category);
    setMessage(result.message);
    if (result.success) setExpense({ ...expense, description: "", amount: "" });
  };

  const submitManual = () => {
    const amount = Number(manual.amount);
    const lines: JournalLine[] = [
      { account_id: manual.debitAccount, debit: amount, credit: 0 },
      { account_id: manual.creditAccount, debit: 0, credit: amount },
    ];
    const result = postManualJournalEntry(manual.description, lines);
    setMessage(result.message);
    if (result.success) setManual({ ...manual, description: "", amount: "" });
  };

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
          <div><h1 className="text-xl font-bold tracking-tight">Accounting & Ledger</h1><p className="text-xs text-neutral-500 font-mono mt-0.5">Phase 8 • Double-entry accounting with immutable journal postings</p></div>
          <span className="px-2 py-1 text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">BALANCED POSTING ENGINE</span>
        </div>
        {message && <div role="status" className="px-3 py-2 text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}
        <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800 pb-2">
          {([["overview", "Overview", Wallet], ["journal", "Journal entries", BookOpen], ["accounts", "Chart of accounts", FileText], ["reports", "Financial reports", BarChart3]] as const).map(([key, label, Icon]) => <button key={key} onClick={() => setTab(key)} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border ${tab === key ? "bg-black text-white dark:bg-white dark:text-black border-black dark:border-white" : "border-neutral-200 dark:border-neutral-700"}`}><Icon className="w-3.5 h-3.5" />{label}</button>)}
        </div>
        <div className="flex flex-wrap items-end gap-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-3">
          <label className="text-[10px] font-mono text-neutral-500">From<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="block mt-1 p-1.5 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
          <label className="text-[10px] font-mono text-neutral-500">To<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="block mt-1 p-1.5 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
          <button onClick={() => { setFromDate(""); setToDate(""); }} className="px-2.5 py-1.5 text-xs border border-neutral-300 dark:border-neutral-700 rounded">Clear dates</button>
          <span className="text-[10px] font-mono text-neutral-400">{reportEntries.length} posted entr{reportEntries.length === 1 ? "y" : "ies"} in range</span>
        </div>

        {tab === "overview" && <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[["Revenue", revenue], ["Expenses", expensesTotal], ["Assets", assets], ["Liabilities", liabilities]].map(([label, value]) => <div key={label} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4"><div className="text-[10px] font-mono uppercase text-neutral-500">{label}</div><div className="mt-2 text-lg font-bold">KSh {Number(value).toFixed(2)}</div></div>)}
          </div>
          {canWriteAccounting && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3"><h2 className="text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" /> Record operating expense</h2><input value={expense.description} onChange={(event) => setExpense({ ...expense, description: event.target.value })} placeholder="Description" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /><div className="grid grid-cols-2 gap-2"><input type="number" min="0" value={expense.amount} onChange={(event) => setExpense({ ...expense, amount: event.target.value })} placeholder="Amount" className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /><select value={expense.accountId} onChange={(event) => setExpense({ ...expense, accountId: event.target.value })} className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">{chartOfAccounts.filter((account) => account.type === "expense").map((account) => <option key={account.id} value={account.id}>{account.code} {account.name}</option>)}</select></div><button onClick={submitExpense} className="w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold">Post expense</button></div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3"><h2 className="text-sm font-semibold flex items-center gap-2"><Check className="w-4 h-4" /> Manual journal entry</h2><input value={manual.description} onChange={(event) => setManual({ ...manual, description: event.target.value })} placeholder="Description" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /><div className="grid grid-cols-2 gap-2"><select value={manual.debitAccount} onChange={(event) => setManual({ ...manual, debitAccount: event.target.value })} className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">{chartOfAccounts.map((account) => <option key={account.id} value={account.id}>Dr: {account.code} {account.name}</option>)}</select><select value={manual.creditAccount} onChange={(event) => setManual({ ...manual, creditAccount: event.target.value })} className="p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800">{chartOfAccounts.map((account) => <option key={account.id} value={account.id}>Cr: {account.code} {account.name}</option>)}</select></div><input type="number" min="0" value={manual.amount} onChange={(event) => setManual({ ...manual, amount: event.target.value })} placeholder="Amount" className="w-full p-2 text-xs border rounded bg-neutral-50 dark:bg-neutral-800" /><button onClick={submitManual} className="w-full py-2 border border-neutral-300 dark:border-neutral-700 rounded text-xs font-semibold">Post balanced entry</button></div>
          </div>}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4"><h2 className="text-sm font-semibold mb-3">Recent expenses</h2>{expenses.length === 0 ? <div className="text-xs font-mono text-neutral-400">No expenses posted.</div> : expenses.slice(-5).reverse().map((item) => <div key={item.id} className="flex justify-between py-2 border-b last:border-0 text-xs"><span>{item.description}</span><span className="font-mono">KSh {item.amount.toFixed(2)}</span></div>)}</div>
        </>}

        {tab === "journal" && <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden"><table className="w-full text-left text-xs"><thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[10px] font-mono uppercase text-neutral-500"><tr><th className="p-3">Entry</th><th className="p-3">Description</th><th className="p-3">Source</th><th className="p-3">Debit</th><th className="p-3">Credit</th><th className="p-3">Action</th></tr></thead><tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">{reportEntries.map((entry) => { const debit = entry.lines.reduce((sum, line) => sum + line.debit, 0); const credit = entry.lines.reduce((sum, line) => sum + line.credit, 0); return <tr key={entry.id}><td className="p-3 font-mono"><button onClick={() => setSelectedEntryId(entry.id)} className="underline">{entry.entry_number}</button></td><td className="p-3">{entry.description}</td><td className="p-3 font-mono text-neutral-500">{entry.source_type}</td><td className="p-3 font-mono">KSh {debit.toFixed(2)}</td><td className="p-3 font-mono">KSh {credit.toFixed(2)}</td><td className="p-3">{entry.is_reversed ? <span className="text-neutral-400 text-[10px]">REVERSED</span> : canWriteAccounting && <button onClick={() => setMessage(reverseJournalEntry(entry.id).message)} className="flex items-center gap-1 text-[10px] font-semibold"><RotateCcw className="w-3 h-3" /> Reverse</button>}</td></tr>; })}</tbody></table>{reportEntries.length === 0 && <div className="p-8 text-center text-xs font-mono text-neutral-400">No journal entries match this date range.</div>}</div>}

        {tab === "accounts" && <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden"><table className="w-full text-left text-xs"><thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[10px] font-mono uppercase text-neutral-500"><tr><th className="p-3">Code</th><th className="p-3">Account</th><th className="p-3">Type</th><th className="p-3">Balance</th></tr></thead><tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">{chartOfAccounts.map((account) => <tr key={account.id}><td className="p-3 font-mono">{account.code}</td><td className="p-3 font-semibold">{account.name}</td><td className="p-3 capitalize">{account.type}</td><td className="p-3 font-mono">KSh {(balances[account.id] || 0).toFixed(2)}</td></tr>)}</tbody></table></div>}

        {tab === "reports" && <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[["Net profit", netProfit], ["Cash & equivalents", cashFlow], ["Balance sheet assets", assets], ["Liabilities + equity", liabilities + equity + netProfit]].map(([label, value]) => <div key={label} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4"><div className="text-[10px] font-mono uppercase text-neutral-500">{label}</div><div className="mt-2 text-lg font-bold">KSh {Number(value).toFixed(2)}</div></div>)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4"><h2 className="text-sm font-semibold mb-3">Profit & Loss</h2><div className="space-y-2 text-xs"><div className="flex justify-between"><span>Revenue</span><span className="font-mono">KSh {revenue.toFixed(2)}</span></div><div className="flex justify-between"><span>Operating expenses</span><span className="font-mono">KSh {expensesTotal.toFixed(2)}</span></div><div className="flex justify-between border-t pt-2 font-bold"><span>Net profit</span><span className="font-mono">KSh {netProfit.toFixed(2)}</span></div></div></div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-4"><h2 className="text-sm font-semibold mb-3">Balance Sheet</h2><div className="space-y-2 text-xs"><div className="flex justify-between"><span>Assets</span><span className="font-mono">KSh {assets.toFixed(2)}</span></div><div className="flex justify-between"><span>Liabilities</span><span className="font-mono">KSh {liabilities.toFixed(2)}</span></div><div className="flex justify-between"><span>Equity</span><span className="font-mono">KSh {(equity + netProfit).toFixed(2)}</span></div><div className="flex justify-between border-t pt-2 font-bold"><span>Liabilities + equity</span><span className="font-mono">KSh {(liabilities + equity + netProfit).toFixed(2)}</span></div></div></div>
          </div>
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden"><div className="p-4"><h2 className="text-sm font-semibold">Trial Balance</h2><p className="text-[10px] font-mono text-neutral-500 mt-1">All posted journal lines, including linked reversals.</p></div><table className="w-full text-left text-xs"><thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[10px] font-mono uppercase text-neutral-500"><tr><th className="p-3">Account</th><th className="p-3">Debit</th><th className="p-3">Credit</th></tr></thead><tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">{trialBalance.map(({ account, debit, credit }) => <tr key={account.id}><td className="p-3">{account.code} {account.name}</td><td className="p-3 font-mono">KSh {debit.toFixed(2)}</td><td className="p-3 font-mono">KSh {credit.toFixed(2)}</td></tr>)}<tr className="font-bold border-t"><td className="p-3">Total</td><td className="p-3 font-mono">KSh {trialBalance.reduce((sum, row) => sum + row.debit, 0).toFixed(2)}</td><td className="p-3 font-mono">KSh {trialBalance.reduce((sum, row) => sum + row.credit, 0).toFixed(2)}</td></tr></tbody></table></div>
        </div>}

        {selectedEntry && <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 shadow-xl space-y-4">
            <div className="flex items-start justify-between border-b border-neutral-200 dark:border-neutral-800 pb-3">
              <div><h2 className="font-bold text-sm">{selectedEntry.entry_number}</h2><p className="text-[10px] font-mono text-neutral-500">{selectedEntry.description}</p></div>
              <button onClick={() => setSelectedEntryId(null)} className="text-xs text-neutral-500">Close</button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs"><div><div className="text-[10px] font-mono text-neutral-500">Source</div><div>{selectedEntry.source_type}</div></div><div><div className="text-[10px] font-mono text-neutral-500">Source ID</div><div className="font-mono truncate">{selectedEntry.source_id || "MANUAL"}</div></div><div><div className="text-[10px] font-mono text-neutral-500">Date</div><div>{selectedEntry.date.slice(0, 10)}</div></div></div>
            <table className="w-full text-left text-xs"><thead className="text-[10px] font-mono uppercase text-neutral-500"><tr><th className="py-2">Account</th><th className="py-2">Debit</th><th className="py-2">Credit</th></tr></thead><tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">{selectedEntry.lines.map((line, index) => <tr key={`${line.account_id}-${index}`}><td className="py-2">{accountName(line.account_id)}</td><td className="py-2 font-mono">KSh {line.debit.toFixed(2)}</td><td className="py-2 font-mono">KSh {line.credit.toFixed(2)}</td></tr>)}</tbody></table>
          </div>
        </div>}
      </div>
    </DashboardShell>
  );
}
