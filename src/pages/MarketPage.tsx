import {useDeferredValue, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {findFuzzyMatches} from "../lib/search";
import {MarketResults, type MarketGroup} from "../components/MarketResults";
import type {TopOrders} from "../components/OrderRow";

interface ItemEntry {
    slug: string;
    name: string;
}

function toSlug(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
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
    const dropdownRef = useRef<HTMLDivElement>(null);
    const deferredQuery = useDeferredValue(query);

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {
            }); // without items_list.json, autocomplete is silently disabled
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
                    setError("Item not found");
                    return;
                }
                setBaseOrders(baseData.data ?? null);
                setRankedOrders(rankedData.data ?? null);
            } else {
                const raw = await invoke<string>("fetch_market_top", {slug, rank: null});
                const data = JSON.parse(raw);
                if (data.error) {
                    setError("Item not found");
                    return;
                }
                setBaseOrders(data.data);
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
        setSelectedSlug(null);
    }

    const hasResults = baseOrders || rankedOrders;

    return (
        <div className="flex h-full flex-col gap-4 p-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Warframe Market</h1>
                <p className="text-sm text-gray-500">
                    Real-time item price lookup.
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
                        placeholder="Item name (e.g. Soma Prime Barrel)"
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
                    />
                    <button
                        onClick={() => search()}
                        disabled={loading}
                        className="px-4 py-2 bg-purple-500 hover:bg-purple-400 disabled:opacity-50 text-gray-950 font-semibold text-sm rounded-lg"
                    >
                        {loading ? "..." : "Search"}
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
                <MarketResults
                    groups={
                        rankedOrders
                            ? [
                                {id: "base", title: "Cheapest (any rank)", orders: baseOrders},
                                {id: "full", title: `Full rank (r${maxRank})`, orders: rankedOrders},
                            ] as MarketGroup[]
                            : [{id: "base", title: "Selling (online)", orders: baseOrders}] as MarketGroup[]
                    }
                    itemName={itemName}
                    containerClass={`grid gap-3 ${rankedOrders ? "md:grid-cols-2" : "grid-cols-1"}`}
                />
            )}
        </div>
    );
}
