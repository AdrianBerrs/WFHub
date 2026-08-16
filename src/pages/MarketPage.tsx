import {useDeferredValue, useEffect, useRef, useState} from "react";
import {useLocation, useNavigate} from "react-router-dom";
import {invoke} from "@tauri-apps/api/core";
import {DollarSign, PlusCircle, Search, ShoppingCart} from "lucide-react";
import {findFuzzyMatches} from "../lib/search";
import {MarketResults, type MarketGroup} from "../components/MarketResults";
import type {Order, TopOrders} from "../components/OrderRow";

interface ItemEntry {
    slug: string;
    name: string;
}

function toSlug(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

const ONLINE_STATUSES = new Set(["ingame", "online"]);

function onlyOnline(orders: TopOrders | null): TopOrders | null {
    if (!orders) return null;
    const keep = (list?: Order[]) => (list ?? []).filter((o) => ONLINE_STATUSES.has(o.user?.status));
    return {sell: keep(orders.sell), buy: keep(orders.buy)};
}

interface Props {
    autoSearch?: string | null;
    onAutoSearchDone?: () => void;
}

export default function MarketPage({autoSearch, onAutoSearchDone}: Props) {
    const location = useLocation();
    const navigate = useNavigate();
    const navAutoSearch = (location.state as { autoSearch?: string } | null)?.autoSearch;
    const effectiveAutoSearch = autoSearch ?? navAutoSearch;
    const [query, setQuery] = useState("");
    const [allItems, setAllItems] = useState<ItemEntry[]>([]);
    const [suggestions, setSuggestions] = useState<ItemEntry[]>([]);
    const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
    const [baseOrders, setBaseOrders] = useState<TopOrders | null>(null);
    const [rankedOrders, setRankedOrders] = useState<TopOrders | null>(null);
    const [maxRank, setMaxRank] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [itemName, setItemName] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);
    const deferredQuery = useDeferredValue(query);

    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [showSellModal, setShowSellModal] = useState(false);
    const [sellPrice, setSellPrice] = useState(0);
    const [sellQuantity, setSellQuantity] = useState(1);
    const [sellRank, setSellRank] = useState<number | null>(null);
    const [sellSubmitting, setSellSubmitting] = useState(false);
    const [sellError, setSellError] = useState<string | null>(null);

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {}); // without items_list.json, autocomplete is silently disabled
        invoke<string>("wfmarket_read_auth")
            .then((raw) => setIsLoggedIn(!!JSON.parse(raw).jwt))
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!effectiveAutoSearch) return;
        const matched = allItems.length > 0 ? findFuzzyMatches(allItems, effectiveAutoSearch, 1)[0] : undefined;
        const slug = matched?.slug ?? toSlug(effectiveAutoSearch);
        const name = matched?.name ?? effectiveAutoSearch;
        setQuery(name);
        setSelectedSlug(slug);
        searchWithSlug(slug, name);
        onAutoSearchDone?.();
        if (navAutoSearch) {
            window.history.replaceState({}, "");
        }
    }, [effectiveAutoSearch, allItems]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (deferredQuery.trim().length < 3 || selectedSlug !== null) {
            setSuggestions([]);
            return;
        }
        setSuggestions(findFuzzyMatches(allItems, deferredQuery, 8));
    }, [deferredQuery, allItems, selectedSlug]);

    // Fecha dropdown ao clicar fora
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setSuggestions([]);
            }
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    async function searchWithSlug(slug: string, name: string) {
        setLoading(true);
        setError(null);
        setBaseOrders(null);
        setRankedOrders(null);
        setMaxRank(null);
        setItemName(name);
        setSellQuantity(1);
        setSuggestions([]);
        try {
            const infoRaw = await invoke<string>("fetch_item_info", {slug});
            const info = JSON.parse(infoRaw);
            const rank: number | null = info?.data?.maxRank ?? null;
            setMaxRank(rank);

            if (rank !== null) {
                const [baseRaw, rankedRaw] = await Promise.all([
                    invoke<string>("fetch_market_top", {slug, rank: null}),
                    invoke<string>("fetch_market_top", {slug, rank}),
                ]);
                const baseData = JSON.parse(baseRaw);
                const rankedData = JSON.parse(rankedRaw);
                if (baseData.error && rankedData.error) {
                    setError("Item not found");
                    return;
                }
                const baseOrdersOnline = onlyOnline(baseData.data ?? null);
                const rankedOrdersOnline = onlyOnline(rankedData.data ?? null);
                setBaseOrders(baseOrdersOnline);
                setRankedOrders(rankedOrdersOnline);
                setSellPrice((baseOrdersOnline?.sell ?? [])[0]?.platinum ?? 1);
                setSellRank(rank);
                const baseBuy = baseData.data?.buy?.[0]?.platinum ?? null;
                const baseSell = baseData.data?.sell?.[0]?.platinum ?? null;
                if (baseBuy !== null || baseSell !== null) {
                    invoke("save_item_price", {name, buy: baseBuy, sell: baseSell}).catch(() => {});
                }
            } else {
                const raw = await invoke<string>("fetch_market_top", {slug, rank: null});
                const data = JSON.parse(raw);
                if (data.error) {
                    setError("Item not found");
                    return;
                }
                const ordersOnline = onlyOnline(data.data);
                setBaseOrders(ordersOnline);
                setSellPrice((ordersOnline?.sell ?? [])[0]?.platinum ?? 1);
                setSellRank(null);
                const buy = data.data?.buy?.[0]?.platinum ?? null;
                const sell = data.data?.sell?.[0]?.platinum ?? null;
                if (buy !== null || sell !== null) {
                    invoke("save_item_price", {name, buy, sell}).catch(() => {});
                }
            }
        } catch {
            setError("Error fetching orders.");
        } finally {
            setLoading(false);
        }
    }

    function selectSuggestion(item: ItemEntry) {
        setQuery(item.name);
        setSelectedSlug(item.slug);
        searchWithSlug(item.slug, item.name);
    }

    function search(overrideSlug?: string) {
        const matched = findFuzzyMatches(allItems, query, 1)[0];
        const slug = overrideSlug ?? selectedSlug ?? matched?.slug ?? toSlug(query);
        const name = matched?.name ?? query.trim();
        if (!slug) return;
        searchWithSlug(slug, name);
        setSelectedSlug(slug);
    }

    const hasResults = baseOrders || rankedOrders;
    const canCreateSellOrder =
        !!selectedSlug &&
        sellPrice >= 1 &&
        sellQuantity >= 1 &&
        (maxRank === null || (sellRank !== null && sellRank >= 0 && sellRank <= maxRank));

    async function handleCreateSellOrder() {
        if (!selectedSlug) return;
        setSellSubmitting(true);
        setSellError(null);
        try {
            const quantity = Math.max(1, Math.floor(sellQuantity));
            const rank = maxRank === null
                ? null
                : Math.min(maxRank, Math.max(0, Math.floor(sellRank ?? maxRank)));

            await invoke("wfmarket_create_sell_order", {
                itemSlug: selectedSlug,
                platinum: sellPrice,
                quantity,
                rank,
            });
            setShowSellModal(false);
        } catch (e) {
            setSellError(String(e));
        } finally {
            setSellSubmitting(false);
        }
    }

    return (
        <div className="wf-page space-y-6">

            <div className="wf-panel p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                            <DollarSign size={20} className="text-green-700" />
                            Market Prices
                        </h1>
                        <p className="mt-1 text-xs text-slate-400">
                            Check online warframe.market orders while keeping the app workflow intact.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <span className="rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5 font-mono text-[10px] text-slate-400">
                            PLATAFORM: PC
                        </span>
                        <span className="flex items-center gap-1.5 rounded border border-emerald-500/10 bg-[#14231b] px-2.5 py-1.5 font-mono text-[10px] font-bold text-emerald-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            API MARKET
                        </span>
                        <button
                            onClick={() => navigate("/my-orders")}
                            className="flex items-center gap-1.5 rounded border border-cyan-500/30 bg-cyan-950/40 px-2.5 py-1.5 font-mono text-[10px] font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60"
                        >
                            <ShoppingCart size={12} />
                            MY ORDERS
                        </button>
                    </div>
                </div>
            </div>

            <div className="wf-card relative p-4" ref={dropdownRef}>
                <label className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Search Active Market Item
                </label>
                <div className="flex flex-col gap-2 lg:flex-row">
                    <div className="relative flex-1">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" size={15} />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value);
                                setSelectedSlug(null);
                            }}
                            onKeyDown={(e) => e.key === "Enter" && search()}
                            placeholder="Item name (e.g. Soma Prime Barrel)"
                            className="w-full rounded-lg border border-slate-800 bg-slate-950/80 py-2.5 pl-9 pr-4 text-xs font-semibold text-slate-100 placeholder-slate-500 transition-all focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/30"
                        />
                        {suggestions.length > 0 && (
                            <div
                                className="custom-scrollbar absolute left-0 right-0 top-full z-10 mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-[#12121a] shadow-2xl">
                                {suggestions.map((item) => (
                                    <button
                                        key={item.slug}
                                        onMouseDown={() => selectSuggestion(item)}
                                        className="flex w-full items-center justify-between border-b border-slate-900/70 px-4 py-2.5 text-left text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-900/50 hover:text-cyan-300 last:border-0"
                                    >
                                        <span>{item.name}</span>
                                        <span className="font-mono text-[10px] text-slate-500">Select</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={() => search()}
                        disabled={loading}
                        className="rounded-lg border border-cyan-500/30 bg-cyan-950/40 px-4 py-2.5 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60 disabled:opacity-50"
                    >
                        {loading ? "..." : "Search"}
                    </button>
                    {hasResults && isLoggedIn && selectedSlug && (
                        <button
                            onClick={() => { setSellError(null); setShowSellModal(true); }}
                            className="flex shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-950/40 px-4 py-2.5 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60"
                        >
                            <PlusCircle size={15} />
                            Create Sell Order
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-sm text-red-300">
                    {error}
                </div>
            )}

            {hasResults && (
                <MarketResults
                    groups={
                        rankedOrders
                            ? [
                                {id: "base", title: "Cheapest (online, any rank)", orders: baseOrders},
                                {id: "full", title: `Full rank (online, r${maxRank})`, orders: rankedOrders},
                            ] as MarketGroup[]
                            : [{id: "base", title: "Selling (online)", orders: baseOrders}] as MarketGroup[]
                    }
                    itemName={itemName}
                    containerClass={`grid gap-3 ${rankedOrders ? "md:grid-cols-2" : "grid-cols-1"}`}
                />
            )}
        {showSellModal && (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSellModal(false); }}
                onKeyDown={(e) => e.key === "Escape" && setShowSellModal(false)}
            >
                <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-2xl">
                    <div className="flex items-start justify-between gap-4 border-b border-slate-900 pb-4">
                        <div>
                            <h2 className="flex items-center gap-2 text-base font-bold text-slate-100">
                                <PlusCircle size={16} className="text-cyan-400" />
                                Create Sell Order
                            </h2>
                            <p className="mt-1 text-xs text-slate-400">
                                Configure the order details for <span className="font-semibold text-slate-200">{itemName}</span>.
                            </p>
                        </div>
                        <button onClick={() => setShowSellModal(false)} className="text-lg leading-none text-slate-500 hover:text-slate-200">✕</button>
                    </div>

                    <div className="rounded-lg border border-slate-900 bg-slate-950/50 px-3 py-2">
                        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-slate-500">Selling Item</p>
                        <p className="mt-1 text-sm font-semibold text-slate-100">{itemName}</p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-semibold text-slate-400">Price (platinum)</label>
                            <input
                                type="number"
                                min={1}
                                value={sellPrice}
                                onChange={(e) => setSellPrice(Number(e.target.value))}
                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs font-semibold text-slate-100 focus:border-cyan-500 focus:outline-none"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-semibold text-slate-400">Quantity</label>
                            <input
                                type="number"
                                min={1}
                                step={1}
                                value={sellQuantity}
                                onChange={(e) => setSellQuantity(Number(e.target.value))}
                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs font-semibold text-slate-100 focus:border-cyan-500 focus:outline-none"
                            />
                        </div>
                    </div>

                    {maxRank !== null && (
                        <div className="rounded-lg border border-amber-500/10 bg-amber-950/10 p-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <label className="text-xs font-semibold text-amber-300">Rank</label>
                                    <p className="mt-0.5 text-[11px] text-slate-400">
                                        Required for ranked mods and arcanes. Range: R0–R{maxRank}.
                                    </p>
                                </div>
                                <input
                                    type="number"
                                    min={0}
                                    max={maxRank}
                                    step={1}
                                    value={sellRank ?? maxRank}
                                    onChange={(e) => setSellRank(Number(e.target.value))}
                                    className="w-24 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-center text-xs font-bold text-slate-100 focus:border-amber-500 focus:outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {sellError && <p className="text-xs text-red-400">{sellError}</p>}

                    <div className="flex justify-end gap-2">
                        <button
                            onClick={() => setShowSellModal(false)}
                            className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreateSellOrder}
                            disabled={sellSubmitting || !canCreateSellOrder}
                            className="rounded-lg bg-cyan-400 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-300 disabled:opacity-50"
                        >
                            {sellSubmitting ? "Posting..." : "Post Order"}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </div>
    );
}
