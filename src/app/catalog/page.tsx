"use client";

import React, { useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import type { ProductCategory } from "@/lib/types/database";
import { Plus, Search, X } from "lucide-react";

interface DigiTaxCatalogItem {
  id: string;
  item_name: string;
  item_bar_code?: string;
  item_class_code: string | number;
  tax_type_code: string;
  active: boolean;
  status?: string;
}

export default function CatalogPage() {
  const { catalog, activeProperty, activeOutlet, addCatalogItem, loadCatalog, hasPermission } = useTenantStore();
  const canManageCatalog = hasPermission("catalog:manage");
  const canReadInventory = hasPermission("inventory:read");
  const canManageInventory = hasPermission("inventory:manage");
  const [query, setQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<ProductCategory>("grocery");
  const [itemType, setItemType] = useState<"retail" | "supply">("retail");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("each");
  const [price, setPrice] = useState("");
  const [kitchenStock, setKitchenStock] = useState("0");
  const [barStock, setBarStock] = useState("0");
  const [reorderLevel, setReorderLevel] = useState("0");
  const [stockTracked, setStockTracked] = useState(true);
  const [prepStation, setPrepStation] = useState<"kitchen" | "bar">("kitchen");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mappingItemId, setMappingItemId] = useState<string | null>(null);
  const [mapping, setMapping] = useState({ etims_item_code: "", etims_tax_code: "", etims_item_class_code: "" });
  const [digitaxItems, setDigitaxItems] = useState<DigiTaxCatalogItem[]>([]);
  const [digitaxItemsNext, setDigitaxItemsNext] = useState<string | null>(null);
  const [digitaxItemsLoaded, setDigitaxItemsLoaded] = useState(false);
  const [digitaxItemsLoading, setDigitaxItemsLoading] = useState(false);
  const [digitaxSyncing, setDigitaxSyncing] = useState(false);
  const [autoMapping, setAutoMapping] = useState(false);
  const [digitaxItemsMessage, setDigitaxItemsMessage] = useState<string | null>(null);
  const [digitaxItemQuery, setDigitaxItemQuery] = useState("");
  const [selectedDigitaxItemId, setSelectedDigitaxItemId] = useState("");

  React.useEffect(() => {
    setDigitaxItems([]);
    setDigitaxItemsNext(null);
    setDigitaxItemsLoaded(false);
    setDigitaxItemsMessage(null);
    setSelectedDigitaxItemId("");
  }, [activeOutlet?.id]);

  const visibleItems = catalog.filter((item) =>
    `${item.name} ${item.sku} ${item.barcode || ""}`.toLowerCase().includes(query.toLowerCase())
  );

  function changeItemType(nextType: "retail" | "supply") {
    setItemType(nextType);
    if (nextType === "supply") {
      setStockTracked(true);
      setPrice("0");
      setPrepStation("kitchen");
      setKitchenStock("0");
      setBarStock("0");
    } else if (price === "0") {
      setPrice("");
    }
  }

  async function submitItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const result = await addCatalogItem({
        name,
        item_type: itemType,
        unit,
        price: Number(price),
        category,
        initial_stock_kitchen: itemType === "retail" && canManageInventory && stockTracked ? Number(kitchenStock) : 0,
        initial_stock_bar: itemType === "retail" && canManageInventory && stockTracked ? Number(barStock) : 0,
        reorder_level: canManageInventory && (itemType === "supply" || stockTracked) ? Number(reorderLevel) : 0,
        stock_tracked: itemType === "supply" || stockTracked,
        prep_station: prepStation,
      });
      setMessage(result.message);
      if (!result.success) return;
      setShowForm(false);
      setItemType("retail");
      setName("");
      setUnit("each");
      setPrice("");
      setKitchenStock("0");
      setBarStock("0");
      setReorderLevel("0");
      setStockTracked(true);
      setPrepStation("kitchen");
    } finally {
      setSaving(false);
    }
  }

  async function saveEtimsMapping(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const item = catalog.find((candidate) => candidate.id === mappingItemId);
    if (!item || !activeOutlet) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/pos/catalog", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ outlet_id: activeOutlet.id, item_id: item.id, ...mapping }),
      });
      const result = await response.json();
      setMessage(result.message || "Could not save the DigiTax mapping.");
      if (response.ok && result.success) {
        setMappingItemId(null);
        await loadCatalog();
      }
    } catch {
      setMessage("Could not reach the server to save the DigiTax mapping.");
    } finally {
      setSaving(false);
    }
  }

  async function loadDigitaxItems(after?: string) {
    if (!activeOutlet || digitaxItemsLoading) return;
    setDigitaxItemsLoading(true);
    setDigitaxItemsMessage(null);
    try {
      const params = new URLSearchParams({ outlet_id: activeOutlet.id });
      if (after) params.set("after", after);
      const response = await fetch(`/api/integrations/digitax-items?${params}`, { credentials: "include" });
      const result = await response.json();
      if (!response.ok || !result.success || !Array.isArray(result.items)) {
        setDigitaxItemsMessage(result.message || "Could not load items from DigiTax.");
        return;
      }
      const newItems = result.items as DigiTaxCatalogItem[];
      setDigitaxItems((current) => after ? [...current, ...newItems] : newItems);
      setDigitaxItemsNext(typeof result.next === "string" ? result.next : null);
      setDigitaxItemsLoaded(true);
    } catch {
      setDigitaxItemsMessage("Could not reach DigiTax to load its registered items.");
    } finally {
      setDigitaxItemsLoading(false);
    }
  }

  async function syncDigitaxCatalog() {
    if (!activeOutlet || digitaxSyncing) return;
    setDigitaxSyncing(true);
    setDigitaxItemsMessage(null);
    try {
      const response = await fetch("/api/integrations/digitax-items/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ outlet_id: activeOutlet.id }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setDigitaxItemsMessage(result.message || "Could not sync DigiTax products.");
        return;
      }
      setDigitaxItemsMessage(result.message);
      setDigitaxItemsLoaded(false);
      setDigitaxItems([]);
      setDigitaxItemsNext(null);
      await loadCatalog();
    } catch {
      setDigitaxItemsMessage("Could not reach the server to sync DigiTax products.");
    } finally {
      setDigitaxSyncing(false);
    }
  }

  async function autoMapExactBarcodes() {
    if (!activeOutlet || autoMapping) return;
    setAutoMapping(true);
    setDigitaxItemsMessage(null);
    try {
      const allItems: DigiTaxCatalogItem[] = [];
      let after: string | undefined;
      const seenCursors = new Set<string>();
      for (let page = 0; page < 100; page += 1) {
        const params = new URLSearchParams({ outlet_id: activeOutlet.id });
        if (after) params.set("after", after);
        const response = await fetch(`/api/integrations/digitax-items?${params}`, { credentials: "include" });
        const result = await response.json();
        if (!response.ok || !result.success || !Array.isArray(result.items)) {
          throw new Error(result.message || "Could not load items from DigiTax.");
        }
        allItems.push(...result.items as DigiTaxCatalogItem[]);
        if (typeof result.next !== "string" || !result.next) break;
        if (seenCursors.has(result.next)) throw new Error("DigiTax returned a repeated item page. No mappings were changed.");
        seenCursors.add(result.next);
        after = result.next;
        if (page === 99) throw new Error("More than 2,000 DigiTax items were found. No mappings were changed; use the item selector to map products in pages.");
      }

      const localCounts = new Map<string, number>();
      for (const item of catalog) {
        const barcode = item.item_type === "supply" ? "" : item.barcode?.trim().toUpperCase() ?? "";
        if (barcode) localCounts.set(barcode, (localCounts.get(barcode) ?? 0) + 1);
      }
      const remoteByBarcode = new Map<string, DigiTaxCatalogItem[]>();
      for (const item of allItems) {
        const barcode = item.item_bar_code?.trim().toUpperCase() ?? "";
        if (!barcode) continue;
        const matches = remoteByBarcode.get(barcode) ?? [];
        matches.push(item);
        remoteByBarcode.set(barcode, matches);
      }

      const mappings = catalog.flatMap((item) => {
        const barcode = item.item_type === "supply" ? "" : item.barcode?.trim().toUpperCase() ?? "";
        const matches = remoteByBarcode.get(barcode) ?? [];
        if (!barcode || localCounts.get(barcode) !== 1 || matches.length !== 1) return [];
        const remote = matches[0];
        if (!remote.active || (remote.status && remote.status.toUpperCase() !== "COMPLETE") ||
            !/^[ABCDE]$/.test(remote.tax_type_code) || !remote.item_bar_code) return [];
        return [{
          item_id: item.id,
          etims_item_code: remote.item_bar_code,
          etims_tax_code: remote.tax_type_code,
          etims_item_class_code: String(remote.item_class_code),
        }];
      });

      setDigitaxItems(allItems);
      setDigitaxItemsNext(null);
      setDigitaxItemsLoaded(true);
      if (!mappings.length) {
        setDigitaxItemsMessage(`Loaded ${allItems.length} DigiTax items, but found no unique exact barcode matches. No mappings were changed.`);
        return;
      }
      const response = await fetch("/api/pos/catalog/etims-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ outlet_id: activeOutlet.id, mappings }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setDigitaxItemsMessage(result.message || "Exact barcode matches could not be saved.");
        return;
      }
      setDigitaxItemsMessage(`${result.message} ${catalog.filter((item) => item.item_type !== "supply").length - mappings.length} item(s) were not auto-mapped because they lacked a unique exact barcode match or were not ready in DigiTax.`);
      await loadCatalog();
    } catch (error) {
      setDigitaxItemsMessage(error instanceof Error ? error.message : "Could not match DigiTax items.");
    } finally {
      setAutoMapping(false);
    }
  }

  function applyDigitaxItem(itemId: string) {
    setSelectedDigitaxItemId(itemId);
    const item = digitaxItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setMapping({
      etims_item_code: item.item_bar_code ?? "",
      etims_tax_code: item.tax_type_code,
      etims_item_class_code: String(item.item_class_code),
    });
  }

  return (
    <DashboardShell>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Products & Catalog</h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">Property Settings • {activeProperty?.name} • Catalog, warehouse routing and stock</p>
          </div>
          {canManageCatalog && (
            <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-3 py-1.5 bg-black text-white dark:bg-white dark:text-black text-xs font-semibold rounded">
              <Plus className="w-3.5 h-3.5" /> Add item
            </button>
          )}
        </div>
        {message && <div role="status" className="px-3 py-2 text-xs border border-neutral-200 dark:border-neutral-700 rounded">{message}</div>}
        <div className="flex items-center gap-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-2">
          <Search className="w-4 h-4 text-neutral-400" />
          <input aria-label="Search catalog" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, SKU or barcode" className="flex-1 bg-transparent outline-none text-xs font-mono" />
        </div>
        {canManageCatalog && (
          <section className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="max-w-3xl">
              <h2 className="text-sm font-semibold">Sync DigiTax products</h2>
              <p className="mt-1 text-[10px] text-neutral-500">Manually imports active, completed DigiTax finished products for this outlet. New products use DigiTax name and price, zero opening stock, and a generated KoreBench sale identifier if DigiTax has no barcode. Other item types and ambiguous barcode matches are skipped.</p>
              {digitaxItemsMessage && <p role="status" className="mt-2 text-xs text-neutral-700 dark:text-neutral-300">{digitaxItemsMessage}</p>}
            </div>
            <button type="button" disabled={digitaxSyncing || !activeOutlet} onClick={() => void syncDigitaxCatalog()} className="rounded border border-emerald-700 px-3 py-2 text-xs font-semibold text-emerald-800 disabled:opacity-50 dark:text-emerald-300">
              {digitaxSyncing ? "Syncing DigiTax products…" : "Sync DigiTax products to KoreBench"}
            </button>
          </section>
        )}
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-neutral-50 dark:bg-neutral-800/60 text-[11px] font-mono uppercase text-neutral-500">
                <tr>
                  <th className="p-3">Item</th><th className="p-3">Category</th><th className="p-3">SKU / Barcode</th><th className="p-3">Price</th><th className="p-3">Order destination</th>
                  {canReadInventory && <><th className="p-3">Kitchen stock</th><th className="p-3">Bar stock</th><th className="p-3">Supplies stock</th></>}
                  <th className="p-3">Status</th>{canManageCatalog && <th className="p-3">eTIMS</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {visibleItems.map((item) => (
                  <tr key={item.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30">
                    <td className="p-3"><div className="font-semibold">{item.name}</div><div className="text-[10px] font-mono text-neutral-400">{item.item_type === "supply" ? `Non-sale supply • ${item.unit || "each"}` : item.stock_tracked ? `Stock tracked • ${item.unit || "each"}` : "Non-stock"}</div></td>
                    <td className="p-3 capitalize">{item.category}</td>
                    <td className="p-3 font-mono text-neutral-500">{item.sku}<br />{item.barcode}</td>
                    <td className="p-3 font-mono">KSh {item.price.toFixed(2)}</td>
                    <td className="p-3 capitalize">{item.item_type === "supply" ? "Supplies" : item.prep_station === "bar" ? "Bar" : "Kitchen"}</td>
                    {canReadInventory && (
                      <>
                        <td className="p-3 font-mono">
                          {item.stock_tracked && item.item_type !== "supply" ? <><span className={(item.stock_by_warehouse?.kitchen ?? 0) <= item.reorder_level ? "text-red-600 font-semibold" : ""}>{item.stock_by_warehouse?.kitchen ?? 0}</span><span className="text-neutral-400"> / reorder {item.reorder_level}</span></> : "—"}
                        </td>
                        <td className="p-3 font-mono">
                          {item.stock_tracked && item.item_type !== "supply" ? <><span className={(item.stock_by_warehouse?.bar ?? 0) <= item.reorder_level ? "text-red-600 font-semibold" : ""}>{item.stock_by_warehouse?.bar ?? 0}</span><span className="text-neutral-400"> / reorder {item.reorder_level}</span></> : "—"}
                        </td>
                        <td className="p-3 font-mono">
                          {item.item_type === "supply" ? <><span className={(item.stock_by_warehouse?.supplies ?? 0) <= item.reorder_level ? "text-red-600 font-semibold" : ""}>{item.stock_by_warehouse?.supplies ?? 0}</span><span className="text-neutral-400"> / reorder {item.reorder_level}</span></> : "—"}
                        </td>
                      </>
                    )}
                    <td className="p-3"><span className="text-emerald-600 text-[10px] font-mono">{item.is_active ? "ACTIVE" : "INACTIVE"}</span></td>
                    {canManageCatalog && <td className="p-3">
                      {item.item_type === "supply" ? "—" : <button type="button" onClick={() => {
                        setMappingItemId(mappingItemId === item.id ? null : item.id);
                        setDigitaxItemsMessage(null);
                        setDigitaxItemQuery("");
                        setSelectedDigitaxItemId("");
                        setMapping({
                          etims_item_code: item.etims_item_code ?? "",
                          etims_tax_code: item.etims_tax_code ?? "",
                          etims_item_class_code: item.etims_item_class_code ?? "",
                        });
                      }} className="text-[10px] font-semibold underline">{item.etims_item_code && item.etims_tax_code ? "Edit mapping" : "Map item"}</button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {mappingItemId && canManageCatalog && (
            <form onSubmit={saveEtimsMapping} className="grid gap-3 rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <h2 className="text-sm font-semibold">DigiTax product mapping</h2>
                <p className="text-[10px] text-neutral-500">Load items registered to the configured DigiTax business and select the matching product to copy its official barcode, class code, and tax type. Items are never matched automatically by name.</p>
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
                <button type="button" disabled={digitaxItemsLoading || !activeOutlet} onClick={() => void loadDigitaxItems()} className="rounded border border-neutral-300 px-3 py-2 text-xs font-semibold disabled:opacity-50 dark:border-neutral-700">
                  {digitaxItemsLoading ? "Loading DigiTax items…" : digitaxItemsLoaded ? "Refresh DigiTax items" : "Load DigiTax items"}
                </button>
                <button type="button" disabled={autoMapping || !activeOutlet} onClick={() => void autoMapExactBarcodes()} className="rounded border border-emerald-700 px-3 py-2 text-xs font-semibold text-emerald-800 disabled:opacity-50 dark:text-emerald-300">
                  {autoMapping ? "Matching exact barcodes…" : "Auto-map exact barcode matches"}
                </button>
                {digitaxItemsLoaded && <span className="text-[10px] text-neutral-500">{digitaxItems.length} DigiTax items loaded</span>}
              </div>
              {digitaxItemsLoaded && (
                <>
                  <label className="space-y-1 text-[10px] text-neutral-500 sm:col-span-2">Find a registered DigiTax item
                    <input value={digitaxItemQuery} onChange={(event) => setDigitaxItemQuery(event.target.value)} placeholder="Search DigiTax item name or barcode" className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />
                  </label>
                  <label className="space-y-1 text-[10px] text-neutral-500 sm:col-span-2">Matching DigiTax item
                    <select value={selectedDigitaxItemId} onChange={(event) => applyDigitaxItem(event.target.value)} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white">
                      <option value="">Select the same product from DigiTax</option>
                      {digitaxItems
                        .filter((item) => `${item.item_name} ${item.item_bar_code ?? ""}`.toLowerCase().includes(digitaxItemQuery.toLowerCase()))
                        .map((item) => {
                          const ready = item.active && (!item.status || item.status.toUpperCase() === "COMPLETE") && Boolean(item.item_bar_code);
                          return <option key={item.id} value={item.id} disabled={!ready}>
                            {item.item_name} • {item.item_bar_code || "no barcode"} • tax {item.tax_type_code} • {item.status ?? (item.active ? "ACTIVE" : "INACTIVE")}
                            {!ready ? " (not ready for sale mapping)" : ""}
                          </option>;
                        })}
                    </select>
                    <span className="block">Only active items with a barcode and completed sync (when status is provided) can be selected.</span>
                  </label>
                  {digitaxItemsNext && <div className="sm:col-span-2"><button type="button" disabled={digitaxItemsLoading} onClick={() => void loadDigitaxItems(digitaxItemsNext)} className="rounded border border-neutral-300 px-3 py-2 text-xs disabled:opacity-50 dark:border-neutral-700">{digitaxItemsLoading ? "Loading…" : "Load more DigiTax items"}</button></div>}
                </>
              )}
              {([
                ["etims_item_code", "DigiTax item barcode"],
                ["etims_tax_code", "DigiTax tax type code"],
                ["etims_item_class_code", "DigiTax item class code"],
              ] as const).map(([key, label]) => <label key={key} className="space-y-1 text-[10px] text-neutral-500">{label}{key === "etims_tax_code" ? <select value={mapping[key]} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"><option value="">Select tax code</option>{["A", "B", "C", "D", "E"].map((code) => <option key={code} value={code}>{code}</option>)}</select> : <input value={mapping[key]} onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })} maxLength={key === "etims_item_code" ? 80 : key === "etims_item_class_code" ? 40 : 20} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" />}</label>)}
              <div className="sm:col-span-2 flex gap-2"><button disabled={saving} className="rounded bg-black px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-black">{saving ? "Saving…" : "Save mapping"}</button><button type="button" onClick={() => setMappingItemId(null)} className="rounded border px-3 py-2 text-xs">Cancel</button></div>
            </form>
          )}
        </div>

        {showForm && canManageCatalog && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <form onSubmit={submitItem} className="w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded p-5 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="font-semibold text-sm">Add catalog item</h2>
                <button type="button" onClick={() => setShowForm(false)} aria-label="Close"><X className="w-4 h-4" /></button>
              </div>
              <p className="text-xs text-neutral-500">The catalog is shared across this property. Transfer stock to make a stocked item available at another outlet.</p>
              <p className="text-xs text-neutral-500">A unique SKU is generated automatically when the item is saved and cannot be changed.</p>
              <label className="block text-xs space-y-1">Item type<select value={itemType} onChange={(event) => changeItemType(event.target.value as "retail" | "supply")} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800"><option value="retail">Sale item</option><option value="supply">Non-sale supply</option></select></label>
              <label className="block text-xs space-y-1">Name<input required value={name} onChange={(event) => setName(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              <div className="grid grid-cols-2 gap-2">
                {itemType === "retail"
                  ? <label className="block text-xs space-y-1">Price<input required min="0" step="0.01" type="number" value={price} onChange={(event) => setPrice(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
                  : <p className="self-end pb-2 text-[10px] text-neutral-500">Not sold through POS</p>}
                <label className="block text-xs space-y-1">Stock / sale unit<input required maxLength={40} value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="crate, piece, kg" className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
              </div>
              {itemType === "retail"
                ? <label className="block text-xs space-y-1">Order destination<select value={prepStation} onChange={(event) => setPrepStation(event.target.value as "kitchen" | "bar")} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800"><option value="kitchen">Kitchen</option><option value="bar">Bar</option></select></label>
                : <p className="text-[10px] text-neutral-500">Supply stock is kept in a separate Supplies balance at each outlet.</p>}
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={itemType === "supply" || stockTracked} disabled={itemType === "supply"} onChange={(event) => setStockTracked(event.target.checked)} />
                {itemType === "supply" ? "Track supply quantities" : "Track stock (disable for items sold without quantity limits)"}
              </label>
              {itemType === "retail" && stockTracked && canManageInventory && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs space-y-1">Kitchen opening stock<input required min="0" step="0.001" type="number" value={kitchenStock} onChange={(event) => setKitchenStock(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
                  <label className="block text-xs space-y-1">Bar opening stock<input required min="0" step="0.001" type="number" value={barStock} onChange={(event) => setBarStock(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
                  <label className="block text-xs space-y-1 col-span-2">Reorder level (applies to each warehouse)<input required min="0" step="0.001" type="number" value={reorderLevel} onChange={(event) => setReorderLevel(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>
                </div>
              )}
              {itemType === "supply" && canManageInventory && <label className="block text-xs space-y-1">Low-stock alert level<input required min="0" step="0.001" type="number" value={reorderLevel} onChange={(event) => setReorderLevel(event.target.value)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800" /></label>}
              {itemType === "supply" && !canManageInventory && <p className="text-[10px] text-neutral-500">Supply starts at zero in Central Store; a stock controller records purchases and issues.</p>}
              {stockTracked && !canManageInventory && <p className="text-[10px] text-neutral-500">This item starts with zero stock in both warehouses. Opening balances require stock-management permission.</p>}
              {!stockTracked && <p className="text-[10px] text-neutral-500">This item can be sold without checking or reducing warehouse quantities.</p>}
              <label className="block text-xs space-y-1">Category<select value={category} onChange={(event) => setCategory(event.target.value as ProductCategory)} className="w-full p-2 border rounded bg-neutral-50 dark:bg-neutral-800"><option value="grocery">Grocery</option><option value="beverage">Beverage</option><option value="food">Food</option><option value="household">Household</option><option value="hardware">Hardware</option></select></label>
              {message && <p role="alert" className="text-xs text-red-600">{message}</p>}
              <button type="submit" disabled={saving} className="w-full py-2 bg-black text-white dark:bg-white dark:text-black rounded text-xs font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save item"}</button>
            </form>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
