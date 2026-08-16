import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useNavigate} from "react-router-dom";

interface HubVoidTraderItem {
    name: string;
    ducats: number;
    credits: number;
}

interface HubVoidTraderInventoryResponse {
    source: string;
    generated_at_ms: number;
    active: boolean;
    location: string;
    starts_at_ms: number;
    ends_at_ms: number;
    stale: boolean;
    message: string | null;
    items: HubVoidTraderItem[];
}

type ItemCategory = "Mod" | "Weapon" | "Relic" | "Blueprint" | "Cosmetic" | "Other";
type Hub = "MercuryHUB" | "EarthHUB" | "SaturnHUB" | "PlutoHUB";

const CATEGORY_ORDER: ItemCategory[] = ["Mod", "Weapon", "Relic", "Blueprint", "Cosmetic", "Other"];

const CATEGORY_LABELS: Record<ItemCategory, string> = {
    Mod: "Mods",
    Weapon: "Weapons",
    Relic: "Relics",
    Blueprint: "Blueprints",
    Cosmetic: "Cosmetics",
    Other: "Other",
};

const CATEGORY_ICONS: Record<ItemCategory, string> = {
    Mod: "🧩",
    Weapon: "⚔️",
    Relic: "💠",
    Blueprint: "📄",
    Cosmetic: "✨",
    Other: "📦",
};

const HUBS: Record<Hub, string> = {
    MercuryHUB: "Mercury/Relay Larunda",
    EarthHUB: "Earth/Relay Strata",
    SaturnHUB: "Saturn/Relay Kronia",
    PlutoHUB: "Pluto/Relay Orcus",
}

function formatHubLocation(location: string): string {
    return HUBS[location as Hub] ?? location;
}

function classifyItem(name: string): ItemCategory {
    const n = name.toLowerCase();

    if (n.includes("relic")) return "Relic";
    if (n.endsWith("blueprint")) return "Blueprint";

    // Weapons: Vandal / Wraith suffix, or Prisma prefix on known weapon types, or Prova prefix
    if (n.endsWith(" vandal") || n.endsWith(" wraith")) return "Weapon";
    if (n.startsWith("prova ")) return "Weapon";
    if (
        n.startsWith("prisma ") &&
        !n.includes("sigil") &&
        !n.includes("skin") &&
        !n.includes("glyph")
    )
        return "Weapon";

    // Mods: Primed prefix (covers almost all Baro mods) plus known standalone mods
    if (n.startsWith("primed ")) return "Mod";
    if (n === "collision force") return "Mod";

    // Cosmetics: broad keyword coverage for what Baro typically sells
    const cosmeticKws = [
        "glyph", "floof", "sugatra", "earpiece", "scene", "poster",
        "sigil", "ephemera", "crewsuit", "hood", "leggings", "sleeves",
        "noggle", "skin", "plate", "decoration", "gene-masking",
        "archwing", "color", "colour", "bobblehead",
    ];
    if (cosmeticKws.some((kw) => n.includes(kw))) return "Cosmetic";

    return "Other";
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

function formatCountdown(targetMs: number, nowMs: number): string {
    const delta = Math.max(0, targetMs - nowMs);
    const totalSeconds = Math.floor(delta / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function ItemRow({item}: { item: HubVoidTraderItem }) {
    return (
        <div className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-950/35">
            <p className="min-w-0 truncate text-sm font-semibold text-slate-100">{item.name}</p>
            <div className="grid shrink-0 grid-cols-2 gap-6 text-right">
                <span className="text-sm font-semibold text-amber-300">
                    {item.ducats > 0 ? formatNumber(item.ducats) : "—"}
                </span>
                <span className="text-sm font-semibold text-primary-300">{formatNumber(item.credits)}</span>
            </div>
        </div>
    );
}

export default function VoidTraderInventoryPage() {
    const navigate = useNavigate();
    const [payload, setPayload] = useState<HubVoidTraderInventoryResponse | null>(null);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [nowMs, setNowMs] = useState(Date.now());

    function isOpen(key: string) {
        return !collapsed[key];
    }

    function toggleGroup(key: string) {
        setCollapsed((prev) => ({
            ...prev,
            [key]: !prev[key]
        }));
    }

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            setError(null);
            try {
                const raw = await invoke<string>("fetch_hub_void_trader_inventory");
                if (cancelled) return;
                const parsed: HubVoidTraderInventoryResponse = JSON.parse(raw);
                setPayload(parsed);
            } catch (e) {
                if (cancelled) return;
                setError(String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, []);

    const grouped = useMemo<Map<ItemCategory, HubVoidTraderItem[]>>(() => {
        const map = new Map<ItemCategory, HubVoidTraderItem[]>();
        for (const cat of CATEGORY_ORDER) map.set(cat, []);
        for (const item of payload?.items ?? []) {
            const cat = classifyItem(item.name);
            map.get(cat)!.push(item);
        }
        for (const items of map.values()) {
            items.sort((a, b) => a.name.localeCompare(b.name));
        }
        return map;
    }, [payload]);

    const activeCategories = CATEGORY_ORDER.filter((cat) => (grouped.get(cat)?.length ?? 0) > 0);
    const locationLabel = payload ? formatHubLocation(payload.location) : "";
    const showingCachedCatalog = !!payload && !payload.active && payload.stale && activeCategories.length > 0;

    return (
        <div className="wf-page flex min-h-full flex-col gap-5">
            <div className="wf-panel flex items-center justify-between gap-2 p-5">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-slate-100">Void Trader</h1>
                </div>
                <button
                    type="button"
                    onClick={() => navigate("/hub")}
                    className="rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-950/60"
                >
                    Back to Hub
                </button>
            </div>

            {payload?.stale && payload.message && (
                <div
                    className="rounded-lg border border-yellow-700/40 bg-yellow-900/10 px-3 py-2 text-xs text-yellow-300">
                    Showing fallback: {payload.message}
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
                    {error}
                </div>
            )}

            {loading ? (
                <p className="text-sm text-slate-500">Loading Void Trader inventory...</p>
            ) : !payload ? (
                <p className="text-sm text-slate-500">No Void Trader data at the moment.</p>
            ) : (
                <>
                    <div className="wf-card p-5">
                        <p className="text-sm font-semibold text-slate-200">
                            {payload.active
                                ? `Baro Ki'Teer active at ${locationLabel}`
                                : showingCachedCatalog
                                    ? `Baro Ki'Teer away — showing last saved catalog`
                                    : `Baro Ki'Teer away — ${locationLabel}`}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                            {payload.active
                                ? `Leaves in ${formatCountdown(payload.ends_at_ms, nowMs)}`
                                : payload.starts_at_ms > nowMs
                                    ? `Arrives in ${formatCountdown(payload.starts_at_ms, nowMs)}`
                                    : "Next cycle time unavailable"}
                        </p>
                        {!payload.active && activeCategories.length > 0 && (
                            <p className="mt-2 text-xs text-yellow-500/80">
                                {showingCachedCatalog ? "Showing locally saved inventory from the last catalog captured by WFHUB." : "Showing inventory from last cycle."}
                            </p>
                        )}
                    </div>

                    {activeCategories.length === 0 ? (
                        <p className="text-sm text-slate-500">No items listed for this cycle.</p>
                    ) : (
                        <div className="space-y-4">
                            {activeCategories.map((cat) => {
                                const items = grouped.get(cat)!;
                                const expanded = isOpen(cat);
                                return (
                                    <div key={cat}>
                                        <button
                                            onClick={() => toggleGroup(cat)}
                                            className={`flex w-full items-center justify-between border border-[#1e1e2d] bg-[#14141e]/40 px-4 py-3 text-left transition-colors hover:bg-slate-950/70 ${expanded ? "rounded-t-xl" : "rounded-xl"}`}
                                        >
                                            <span
                                                className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                                                <span>{CATEGORY_ICONS[cat]}</span>
                                                <span>{CATEGORY_LABELS[cat]}</span>
                                            </span>
                                            <span className="flex items-center gap-2">
                                                <span className="text-xs text-zinc-500">{items.length}</span>
                                                <span className="text-xs text-zinc-400">{expanded ? "▲" : "▼"}</span>
                                            </span>
                                        </button>
                                        {expanded && (
                                            <div
                                                className="overflow-hidden rounded-b-xl border-x border-b border-[#1e1e2d]">
                                                <div
                                                    className="grid grid-cols-[1fr_auto] items-center bg-slate-950/70 px-4 py-2 text-[11px] uppercase tracking-wide text-slate-500">
                                                    <span>Item</span>
                                                    <div className="grid grid-cols-2 gap-6 text-right">
                                                        <span>Ducats</span>
                                                        <span>Credits</span>
                                                    </div>
                                                </div>
                                                <div
                                                    className="divide-y divide-slate-900/80 bg-[#111119]">
                                                    {items.map((item) => (
                                                        <ItemRow
                                                            key={`${item.name}-${item.ducats}-${item.credits}`}
                                                            item={item}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
