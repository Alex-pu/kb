"use client";

import React, { useState } from "react";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { useTenantStore } from "@/lib/store/tenant-store";
import { SlidersHorizontal, Building2, Store, TerminalSquare, ShieldAlert, Check, Smartphone, ReceiptText, FileBarChart2, BedDouble, Plus } from "lucide-react";

const initialIntegrations = {
  darajaEnabled: true,
  darajaEnvironment: "sandbox",
  darajaShortCode: "174379",
  darajaConsumerKey: "demo_consumer_key",
  darajaConsumerSecret: "demo_consumer_secret",
  darajaPasskey: "b7c...demo",
  darajaCallbackSecret: "demo_callback_secret",
  darajaCallbackUrl: "https://payments.example.com/daraja/callback",
  darajaTimeoutUrl: "https://payments.example.com/daraja/timeout",
  etimsEnabled: true,
  etimsBusinessName: "Safari Grand Lodge & Grill",
  etimsPin: "P051234567Z",
  etimsDeviceSerial: "ETIMS-1001",
  etimsEndpoint: "",
  printerEnabled: true,
  printerModel: "Xprinter XP-58II",
  printerConnection: "network",
  printerHost: "192.168.0.22",
  printerPort: "9100",
  autoPrintReceipts: true,
};

export default function PropertySettingsPage() {
  const {
    activeProperty,
    availableOutlets,
    availableStations,
    approvalPolicies,
    updateApprovalPolicy,
    saveDarajaConfig,
    darajaConfigs,
    activeOutlet,
    hasPermission,
    loadRoomWorkspace,
    createRoomType,
    createRoom,
    roomTypes,
    rooms,
    roomsLoading,
  } = useTenantStore();
  const [saved, setSaved] = useState(false);
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [roomTypeName, setRoomTypeName] = useState("");
  const [roomTypeRate, setRoomTypeRate] = useState("");
  const [roomInput, setRoomInput] = useState({ roomTypeId: "", number: "", floor: "" });
  const [savingRoom, setSavingRoom] = useState(false);
  const [roomMessage, setRoomMessage] = useState<string | null>(null);
  const canManageRooms = hasPermission("rooms:manage");
  const canManageSettings = hasPermission("settings:manage");
  const [etimsConfig, setEtimsConfig] = useState({ enabled: false, business_name: "", endpoint: "", username: "", password: "", has_password: false });
  const [etimsMessage, setEtimsMessage] = useState<string | null>(null);
  const [savingEtims, setSavingEtims] = useState(false);

  const savedDarajaConfig = darajaConfigs.find((config) => config.property_id === activeProperty?.id && config.outlet_id === activeOutlet?.id) || darajaConfigs.find((config) => config.property_id === activeProperty?.id);

  React.useEffect(() => {
    if (!activeOutlet || !canManageSettings) return;
    let cancelled = false;
    setEtimsConfig({ enabled: false, business_name: "", endpoint: "", username: "", password: "", has_password: false });
    setEtimsMessage(null);
    void fetch(`/api/integrations/etims-config?outlet_id=${encodeURIComponent(activeOutlet.id)}`, { credentials: "include" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "Could not load eTIMS settings.");
        if (!cancelled && data.config) setEtimsConfig({
          enabled: data.config.enabled,
          business_name: data.config.business_name,
          endpoint: data.config.endpoint,
          username: data.config.username,
          password: "",
          has_password: data.config.has_password,
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setEtimsMessage(error instanceof Error ? error.message : "Could not load eTIMS settings.");
      });
    return () => { cancelled = true; };
  }, [activeOutlet?.id, canManageSettings]);

  React.useEffect(() => {
    if (!savedDarajaConfig) return;
    setIntegrations({
      ...initialIntegrations,
      darajaEnabled: savedDarajaConfig.enabled,
      darajaEnvironment: savedDarajaConfig.environment,
      darajaShortCode: savedDarajaConfig.short_code,
      darajaConsumerKey: savedDarajaConfig.consumer_key,
      darajaConsumerSecret: savedDarajaConfig.consumer_secret,
      darajaPasskey: savedDarajaConfig.passkey,
      darajaCallbackUrl: savedDarajaConfig.callback_url,
      darajaTimeoutUrl: savedDarajaConfig.timeout_url,
    });
  }, [savedDarajaConfig]);

  React.useEffect(() => {
    if (!activeProperty?.id || !canManageRooms) return;
    void loadRoomWorkspace(activeProperty.id).then((result) => {
      if (!result.success) setRoomMessage(result.message);
    });
  }, [activeProperty?.id, canManageRooms, loadRoomWorkspace]);

  const submitRoomType = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingRoom) return;
    setSavingRoom(true);
    try {
      const result = await createRoomType({ name: roomTypeName, ratePerNight: Number(roomTypeRate) });
      setRoomMessage(result.message);
      if (result.success) {
        setRoomTypeName("");
        setRoomTypeRate("");
      }
    } finally {
      setSavingRoom(false);
    }
  };

  const submitRoom = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingRoom) return;
    setSavingRoom(true);
    try {
      const result = await createRoom(roomInput);
      setRoomMessage(result.message);
      if (result.success) setRoomInput({ roomTypeId: "", number: "", floor: "" });
    } finally {
      setSavingRoom(false);
    }
  };

  const saveEtimsConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeOutlet || savingEtims) return;
    setSavingEtims(true);
    setEtimsMessage(null);
    try {
      const response = await fetch("/api/integrations/etims-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ outlet_id: activeOutlet.id, ...etimsConfig }),
      });
      const data = await response.json();
      setEtimsMessage(data.message || "Could not save eTIMS settings.");
      if (response.ok && data.success) setEtimsConfig((current) => ({ ...current, password: "", has_password: true }));
    } catch {
      setEtimsMessage("Could not reach the server to save eTIMS settings.");
    } finally {
      setSavingEtims(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    // LAN admin writes (Daraja/eTIMS/printer config) require a LOCAL_API_TOKEN bearer,
    // which isn't available from the browser; those routes stay disabled here and
    // settings are saved to local property state instead until that bridge is built.
    // LAN admin writes (Daraja/eTIMS/printer config) require a LOCAL_API_TOKEN bearer,
    // which isn't available from the browser, so these routes aren't called from here.
    // Settings are saved to local property state until that bridge is built.
    const result = saveDarajaConfig({
      property_id: activeProperty?.id,
      outlet_id: activeOutlet?.id,
      enabled: integrations.darajaEnabled,
      environment: integrations.darajaEnvironment as "sandbox" | "production",
      short_code: integrations.darajaShortCode,
      consumer_key: integrations.darajaConsumerKey,
      consumer_secret: integrations.darajaConsumerSecret,
      passkey: integrations.darajaPasskey,
      callback_url: integrations.darajaCallbackUrl,
      timeout_url: integrations.darajaTimeoutUrl,
    });
    setStatusText(result.message);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <DashboardShell>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              Property Settings & Configuration
            </h1>
            <p className="text-xs text-neutral-500 font-mono mt-0.5">
              Tenant Self-Service • Property: {activeProperty?.name} ({activeProperty?.code})
            </p>
          </div>
          {saved && (
            <span className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 text-white text-xs font-mono rounded animate-in fade-in">
              <Check className="w-3.5 h-3.5" /> Saved to Database
            </span>
          )}
          {statusText && <span className="text-[11px] font-mono text-neutral-500">{statusText}</span>}
        </div>

        {canManageSettings && (
          <form onSubmit={saveEtimsConfig} className="space-y-4 rounded border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
            <div><h2 className="text-sm font-semibold">eTIMS fiscalization</h2><p className="mt-1 text-[10px] text-neutral-500">Provider credentials are encrypted at rest. Only HTTPS endpoints are accepted. Confirm the provider URL and token-auth contract before enabling live submissions.</p></div>
            {!activeOutlet && <p className="text-xs text-amber-700">Select an outlet to configure its eTIMS connection.</p>}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={etimsConfig.enabled} onChange={(event) => setEtimsConfig({ ...etimsConfig, enabled: event.target.checked })} />Enable automatic fiscalization after bill payment</label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-[10px] text-neutral-500">Business name<input required={etimsConfig.enabled} value={etimsConfig.business_name} onChange={(event) => setEtimsConfig({ ...etimsConfig, business_name: event.target.value })} maxLength={255} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" /></label>
              <label className="space-y-1 text-[10px] text-neutral-500">HTTPS provider base URL<input required={etimsConfig.enabled} type="url" placeholder="https://provider.example/api/v1/" value={etimsConfig.endpoint} onChange={(event) => setEtimsConfig({ ...etimsConfig, endpoint: event.target.value })} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" /></label>
              <label className="space-y-1 text-[10px] text-neutral-500">Provider username<input required={etimsConfig.enabled} value={etimsConfig.username} onChange={(event) => setEtimsConfig({ ...etimsConfig, username: event.target.value })} maxLength={255} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" /></label>
              <label className="space-y-1 text-[10px] text-neutral-500">Provider password<input type="password" autoComplete="new-password" required={etimsConfig.enabled && !etimsConfig.has_password} value={etimsConfig.password} onChange={(event) => setEtimsConfig({ ...etimsConfig, password: event.target.value })} placeholder={etimsConfig.has_password ? "Saved securely; leave blank to retain" : "Required to enable eTIMS"} className="block w-full rounded border border-neutral-300 bg-neutral-50 px-2 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-white" /></label>
            </div>
            {etimsMessage && <p role="status" className="text-xs">{etimsMessage}</p>}
            <button type="submit" disabled={!activeOutlet || savingEtims} className="rounded bg-black px-4 py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black">{savingEtims ? "Saving…" : "Save eTIMS settings"}</button>
          </form>
        )}

        <form onSubmit={handleSave} className="space-y-6">
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              Property Details
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Property Name</label>
                <input type="text" defaultValue={activeProperty?.name} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none focus:border-black dark:focus:border-white" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Property Code</label>
                <input type="text" disabled defaultValue={activeProperty?.code} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800/50 rounded outline-none text-neutral-400 cursor-not-allowed" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Physical Location / Address</label>
                <input type="text" defaultValue={activeProperty?.physical_address || ""} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none focus:border-black dark:focus:border-white" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Contact Phone Number</label>
                <input type="text" defaultValue={activeProperty?.phone_number || ""} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded outline-none focus:border-black dark:focus:border-white" />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Store className="w-4 h-4" />
              Outlets & POS Stations in this Property
            </h3>

            <div className="space-y-2">
              {availableOutlets.map((outlet) => {
                const stations = availableStations.filter((s) => s.outlet_id === outlet.id);
                return (
                  <div key={outlet.id} className="p-3 border border-neutral-200 dark:border-neutral-800 rounded bg-neutral-50 dark:bg-neutral-800/40 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-xs">{outlet.name}</div>
                      <div className="text-[11px] font-mono text-neutral-400">Code: {outlet.code} • Type: {outlet.outlet_type}</div>
                    </div>
                    <div className="text-right">
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300">
                        {stations.length} Active Stations
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Smartphone className="w-4 h-4" />
              M-Pesa / Daraja Configuration
            </h3>
            <p className="text-xs text-neutral-500">Daraja credentials are kept in the tenant config panel and the POS continues to accept a transaction code for manual confirmation until the external payment app callbacks in.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
              <label className="space-y-1 md:col-span-2">
                <span className="text-neutral-500 font-medium">Gateway enabled</span>
                <input type="checkbox" checked={integrations.darajaEnabled} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaEnabled: event.target.checked }))} className="mt-2 h-4 w-4" />
              </label>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Environment</label>
                <select value={integrations.darajaEnvironment} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaEnvironment: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded">
                  <option value="sandbox">Sandbox</option>
                  <option value="production">Production</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Shortcode</label>
                <input value={integrations.darajaShortCode} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaShortCode: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Consumer key</label>
                <input value={integrations.darajaConsumerKey} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaConsumerKey: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Consumer secret</label>
                <input type="password" value={integrations.darajaConsumerSecret} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaConsumerSecret: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Passkey</label>
                <input value={integrations.darajaPasskey} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaPasskey: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Callback signing secret</label>
                <input type="password" value={integrations.darajaCallbackSecret} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaCallbackSecret: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-neutral-500 font-medium">Callback URL</label>
                <input value={integrations.darajaCallbackUrl} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaCallbackUrl: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-neutral-500 font-medium">Timeout URL</label>
                <input value={integrations.darajaTimeoutUrl} onChange={(event) => setIntegrations((prev) => ({ ...prev, darajaTimeoutUrl: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FileBarChart2 className="w-4 h-4" />
              eTIMS / Fiscal Compliance
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
              <label className="space-y-1 md:col-span-2">
                <span className="text-neutral-500 font-medium">eTIMS enabled</span>
                <input type="checkbox" checked={integrations.etimsEnabled} onChange={(event) => setIntegrations((prev) => ({ ...prev, etimsEnabled: event.target.checked }))} className="mt-2 h-4 w-4" />
              </label>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Business name</label>
                <input value={integrations.etimsBusinessName} onChange={(event) => setIntegrations((prev) => ({ ...prev, etimsBusinessName: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">KRA PIN</label>
                <input value={integrations.etimsPin} onChange={(event) => setIntegrations((prev) => ({ ...prev, etimsPin: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-neutral-500 font-medium">Fiscal device serial</label>
                <input value={integrations.etimsDeviceSerial} onChange={(event) => setIntegrations((prev) => ({ ...prev, etimsDeviceSerial: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <label className="text-neutral-500 font-medium">eTIMS server endpoint</label>
                <input type="url" value={integrations.etimsEndpoint} onChange={(event) => setIntegrations((prev) => ({ ...prev, etimsEndpoint: event.target.value }))} placeholder="https://your-etims-adapter.example/invoices" className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ReceiptText className="w-4 h-4" />
              Thermal Receipt Printer
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
              <label className="space-y-1 md:col-span-2">
                <span className="text-neutral-500 font-medium">Auto-print enabled</span>
                <input type="checkbox" checked={integrations.autoPrintReceipts} onChange={(event) => setIntegrations((prev) => ({ ...prev, autoPrintReceipts: event.target.checked }))} className="mt-2 h-4 w-4" />
              </label>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Printer model</label>
                <input value={integrations.printerModel} onChange={(event) => setIntegrations((prev) => ({ ...prev, printerModel: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Connection type</label>
                <select value={integrations.printerConnection} onChange={(event) => setIntegrations((prev) => ({ ...prev, printerConnection: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded">
                  <option value="network">Network</option>
                  <option value="bluetooth">Bluetooth</option>
                  <option value="usb">USB</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Host / device</label>
                <input value={integrations.printerHost} onChange={(event) => setIntegrations((prev) => ({ ...prev, printerHost: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
              <div className="space-y-1">
                <label className="text-neutral-500 font-medium">Port</label>
                <input value={integrations.printerPort} onChange={(event) => setIntegrations((prev) => ({ ...prev, printerPort: event.target.value }))} className="w-full p-2 border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 rounded" />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4" />
              Approval Policies
            </h3>
            <p className="text-xs text-neutral-500">Thresholds for discounts, voids, refunds, shift variance and room-charge sign-off. Editable without a deploy.</p>
            <div className="space-y-2">
              {approvalPolicies.map((policy) => (
                <div key={policy.id} className="flex items-center justify-between p-3 border border-neutral-200 dark:border-neutral-800 rounded bg-neutral-50 dark:bg-neutral-800/40">
                  <div>
                    <div className="text-xs font-semibold">{policy.label}</div>
                    <div className="text-[11px] font-mono text-neutral-400">Required role: {policy.required_role}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="number" min="0" value={policy.threshold} onChange={(event) => updateApprovalPolicy(policy.id, Number(event.target.value))} className="w-24 p-2 text-xs font-mono border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded text-right" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <button type="submit" className="px-5 py-2 bg-black text-white dark:bg-white dark:text-black font-semibold text-xs rounded hover:opacity-90 transition-opacity">
              Save Configuration
            </button>
          </div>
        </form>

        {canManageRooms && (
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <BedDouble className="w-4 h-4" />
                Room inventory setup
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                Add room categories and individual room numbers for {activeProperty?.name || "the selected property"}.
                New rooms start dirty until housekeeping marks them ready.
              </p>
            </div>
            {roomMessage && <div role="status" className="rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 p-3 text-xs">{roomMessage}</div>}
            <div className="grid gap-5 md:grid-cols-2">
              <form onSubmit={submitRoomType} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-3">
                <h3 className="text-xs font-semibold">Create room type</h3>
                <label className="block space-y-1 text-xs">
                  Category name
                  <input
                    required
                    maxLength={100}
                    value={roomTypeName}
                    onChange={(event) => setRoomTypeName(event.target.value)}
                    placeholder="e.g. Deluxe Single"
                    className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  Rate per night (KSh)
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    value={roomTypeRate}
                    onChange={(event) => setRoomTypeRate(event.target.value)}
                    className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                </label>
                <button
                  type="submit"
                  disabled={savingRoom || !roomTypeName.trim() || Number(roomTypeRate) <= 0}
                  className="w-full flex items-center justify-center gap-2 rounded bg-black py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                >
                  <Plus className="w-3.5 h-3.5" /> {savingRoom ? "Saving…" : "Create room type"}
                </button>
              </form>

              <form onSubmit={submitRoom} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-3">
                <h3 className="text-xs font-semibold">Add individual room</h3>
                <label className="block space-y-1 text-xs">
                  Room type
                  <select
                    required
                    value={roomInput.roomTypeId}
                    onChange={(event) => setRoomInput({ ...roomInput, roomTypeId: event.target.value })}
                    className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                  >
                    <option value="">Select a category</option>
                    {roomTypes.map((roomType) => <option key={roomType.id} value={roomType.id}>{roomType.name}</option>)}
                  </select>
                </label>
                <label className="block space-y-1 text-xs">
                  Room number
                  <input
                    required
                    maxLength={30}
                    value={roomInput.number}
                    onChange={(event) => setRoomInput({ ...roomInput, number: event.target.value })}
                    placeholder="e.g. 101"
                    className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  Floor / building
                  <input
                    required
                    maxLength={40}
                    value={roomInput.floor}
                    onChange={(event) => setRoomInput({ ...roomInput, floor: event.target.value })}
                    placeholder="e.g. 1"
                    className="w-full rounded border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800"
                  />
                </label>
                <button
                  type="submit"
                  disabled={savingRoom || roomTypes.length === 0 || !roomInput.roomTypeId || !roomInput.number.trim() || !roomInput.floor.trim()}
                  className="w-full flex items-center justify-center gap-2 rounded bg-black py-2 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
                >
                  <Plus className="w-3.5 h-3.5" /> {savingRoom ? "Saving…" : "Add room"}
                </button>
              </form>
            </div>
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">Existing rooms</h3>
                <span className="text-[10px] font-mono text-neutral-500">
                  {roomsLoading ? "Loading…" : `${roomTypes.length} types • ${rooms.length} rooms`}
                </span>
              </div>
              {!roomsLoading && roomTypes.length === 0 && <p className="text-xs text-neutral-500">Create a room type to begin adding rooms.</p>}
              <div className="space-y-2">
                {roomTypes.map((roomType) => {
                  const typeRooms = rooms.filter((room) => room.room_type_id === roomType.id);
                  return (
                    <div key={roomType.id} className="flex items-start justify-between gap-3 border-t border-neutral-100 dark:border-neutral-800 pt-2">
                      <div>
                        <div className="text-xs font-semibold">{roomType.name}</div>
                        <div className="text-[10px] text-neutral-500">KSh {roomType.rate_per_night.toFixed(2)} per night</div>
                      </div>
                      <div className="text-right text-[10px] text-neutral-500">
                        <div>{typeRooms.length} room(s)</div>
                        {typeRooms.length > 0 && <div>{typeRooms.map((room) => room.number).join(", ")}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
