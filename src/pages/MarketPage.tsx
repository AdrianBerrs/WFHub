import {useDeferredValue, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {findFuzzyMatches} from "../lib/search";

interface ItemEntry {
    slug: string;
    name: string;
}

interface OrderUser {
    ingameName: string;
    reputation: number;
    status: string;
}

interface Order {
    platinum: number;
    quantity: number;
    rank?: number;
    user: OrderUser;
}

interface TopOrders {
    sell: Order[];
    buy: Order[];
}

function toSlug(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

function OrderRow({
                      order,
                      copied,
                      onCopy,
                  }: {
    order: Order;
    copied: string | null;
    onCopy: (name: string, plat: number, rank?: number) => void;
}) {
    return (
        <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200">{order.user.ingameName}</span>
                <span className="text-xs text-gray-500">rep: {order.user.reputation}</span>
                {order.rank !== undefined && (
                    <span className="text-xs px-1.5 py-0.5 bg-indigo-900/60 text-indigo-300 rounded">
            r{order.rank}
          </span>
                )}
            </div>
            <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">x{order.quantity}</span>
                <span className="font-bold text-purple-400 text-sm">{order.platinum}p</span>
                <button
                    onClick={() => onCopy(order.user.ingameName, order.platinum, order.rank)}
                    className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
                >
                    {copied === order.user.ingameName ? "✓ Copiado" : "📋 Whisper"}
                </button>
            </div>
        </div>
    );
}

interface Props {
    autoSearch?: string | null;
    onAutoSearchDone?: () => void;
}

export default function MarketPage({autoSearch, onAutoSearchDone}: Props) {
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
    const [copied, setCopied] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const dropdownRef = useRef<HTMLDivElement>(null);
    const deferredQuery = useDeferredValue(query);

    function isOpen(key: string) {
        return collapsed[key] !== true;
    }

    function toggleGroup(key: string) {
        setCollapsed((prev) => ({...prev, [key]: prev[key] !== true}));
    }

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {
            }); // sem items_list.json, autocomplete fica desabilitado silenciosamente
    }, []);

    useEffect(() => {
        if (!autoSearch) return;
        const matched = allItems.length > 0 ? findFuzzyMatches(allItems, autoSearch, 1)[0] : undefined;
        const slug = matched?.slug ?? toSlug(autoSearch);
        const name = matched?.name ?? autoSearch;
        setQuery(name);
        setSelectedSlug(slug);
        searchWithSlug(slug, name);
        onAutoSearchDone?.();
    }, [autoSearch, allItems]); // eslint-disable-line react-hooks/exhaustive-deps

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
                    setError("Item não encontrado");
                    return;
                }
                setBaseOrders(baseData.data ?? null);
                setRankedOrders(rankedData.data ?? null);
            } else {
                const raw = await invoke<string>("fetch_market_top", {slug, rank: null});
                const data = JSON.parse(raw);
                if (data.error) {
                    setError("Item não encontrado");
                    return;
                }
                setBaseOrders(data.data);
            }
        } catch {
            setError("Erro ao buscar ordens.");
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
        setSelectedSlug(null);
    }

    function copyWhisper(ingameName: string, platinum: number, rank?: number) {
        const itemDesc = rank !== undefined ? `${itemName} (rank ${rank})` : itemName;
        const msg = `/w ${ingameName} Hi! I want to buy: ${itemDesc} for ${platinum} platinum. (warframe.market)`;
        navigator.clipboard.writeText(msg);
        setCopied(ingameName);
        setTimeout(() => setCopied(null), 2000);
    }

    const hasResults = baseOrders || rankedOrders;

    return (
        <div className="flex h-full flex-col gap-4 p-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Warframe Market</h1>
                <p className="text-sm text-gray-500">
                    Consulta de preço de itens em tempo real.
                </p>
            </div>

            <div className="relative mb-6" ref={dropdownRef}>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSelectedSlug(null);
                        }}
                        onKeyDown={(e) => e.key === "Enter" && search()}
                        placeholder="Nome do item (ex: Soma Prime Barrel)"
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
                    />
                    <button
                        onClick={() => search()}
                        disabled={loading}
                        className="px-4 py-2 bg-purple-500 hover:bg-purple-400 disabled:opacity-50 text-gray-950 font-semibold text-sm rounded-lg"
                    >
                        {loading ? "..." : "Buscar"}
                    </button>
                </div>

                {suggestions.length > 0 && (
                    <div
                        className="absolute z-10 top-full left-0 right-12 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
                        {suggestions.map((item) => (
                            <button
                                key={item.slug}
                                onMouseDown={() => selectSuggestion(item)}
                                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 border-b border-gray-700/50 last:border-0"
                            >
                                {item.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

            {hasResults && (
                <div className={`grid gap-3 ${rankedOrders ? "md:grid-cols-2" : "grid-cols-1"}`}>
                    {(() => {
                        const groups: Array<{ id: string; title: string; orders: typeof baseOrders }> = rankedOrders
                            ? [
                                {id: "base", title: "Mais barato (qualquer rank)", orders: baseOrders},
                                {id: "full", title: `Full rank (r${maxRank})`, orders: rankedOrders},
                            ]
                            : [{id: "base", title: "Vendendo (online)", orders: baseOrders}];

                        return groups.map(({id, title, orders}) => {
                            const expanded = isOpen(id);
                            const rows = orders?.sell ?? [];
                            return (
                                <div key={id}>
                                    <button
                                        onClick={() => toggleGroup(id)}
                                        className={`flex w-full items-center justify-between border border-gray-800 bg-gray-900/60 px-3 py-2 text-left hover:bg-gray-800/60 transition-colors ${expanded ? "rounded-t-lg" : "rounded-lg"}`}
                                    >
                                        <span className="text-sm font-semibold text-gray-200">{title}</span>
                                        <span className="flex items-center gap-2">
                                            <span className="text-xs text-gray-500">{rows.length}</span>
                                            <span className="text-xs text-gray-400">{expanded ? "▲" : "▼"}</span>
                                        </span>
                                    </button>
                                    {expanded && (
                                        <div
                                            className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
                                            {rows.map((o, i) => (
                                                <OrderRow key={i} order={o} copied={copied} onCopy={copyWhisper}/>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        });
                    })()}
                </div>
            )}
        </div>
    );
}
