import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {findFuzzyMatches} from "../lib/search";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";
import {MarketResults, type MarketGroup} from "../components/MarketResults";
import {FarmResults} from "../components/FarmResults";
import type {TopOrders} from "../components/OrderRow";

interface ItemEntry {
    slug: string;
    name: string;
}

interface Props {
    autoSearch?: string | null;
    onAutoSearchDone?: () => void;
}

function toSlug(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

function groupResults(results: FarmResult[]) {
    return {
        enemy: results.filter((result) => result.source === "enemy"),
        mission: results.filter((result) => result.source === "mission"),
        bounty: results.filter((result) => result.source === "bounty"),
        special: results.filter((result) => result.source === "special"),
        relic: results.filter((result) => result.source === "relic"),
    };
}

export default function QuickSearchPage({autoSearch, onAutoSearchDone}: Props) {
    const [allItems, setAllItems] = useState<ItemEntry[]>([]);
    const [primeParts, setPrimeParts] = useState<Set<string>>(new Set());
    const [inventoryParts, setInventoryParts] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [capturedName, setCapturedName] = useState<string>("");
    const [baseOrders, setBaseOrders] = useState<TopOrders | null>(null);
    const [rankedOrders, setRankedOrders] = useState<TopOrders | null>(null);
    const [maxRank, setMaxRank] = useState<number | null>(null);
    const [farmResults, setFarmResults] = useState<FarmResult[]>([]);

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_prime_parts")
            .then((raw) => setPrimeParts(new Set<string>(JSON.parse(raw))))
            .catch(() => {
            });
        invoke<string>("read_inventory")
            .then((raw) => setInventoryParts(JSON.parse(raw).prime_parts ?? []))
            .catch(() => {
            });
    }, []);

    useEffect(() => {
        if (!autoSearch) return;
        runSearch(autoSearch).finally(() => onAutoSearchDone?.());
    }, [autoSearch, allItems]); // eslint-disable-line react-hooks/exhaustive-deps

    const grouped = useMemo(() => groupResults(farmResults), [farmResults]);

    async function runSearch(name: string) {
        const cleanName = name.trim();
        if (!cleanName) return;

        setLoading(true);
        setError(null);
        setCapturedName(cleanName);
        setBaseOrders(null);
        setRankedOrders(null);
        setMaxRank(null);
        setFarmResults([]);

        try {
            const matched = allItems.length > 0 ? findFuzzyMatches(allItems, cleanName, 1)[0] : undefined;
            const slug = matched?.slug ?? toSlug(cleanName);
            const displayName = matched?.name ?? cleanName;
            setCapturedName(displayName);

            // Auto-add to inventory if it's a prime part not yet registered
            if (primeParts.has(displayName) && !inventoryParts.includes(displayName)) {
                const updated = [...inventoryParts, displayName];
                setInventoryParts(updated);
                invoke("save_prime_parts", {parts: updated}).catch(() => {
                });
            }

            const [infoRaw, farmRaw] = await Promise.all([
                invoke<string>("fetch_item_info", {slug}),
                invoke<string>("search_farm_data", {query: displayName}),
            ]);

            const info = JSON.parse(infoRaw);
            const rank: number | null = info?.data?.maxRank ?? null;
            setMaxRank(rank);

            const marketCalls: Promise<string>[] = [
                invoke<string>("fetch_market_top", {slug, rank: null}),
            ];
            if (rank !== null) {
                marketCalls.push(invoke<string>("fetch_market_top", {slug, rank}));
            }

            const marketRaw = await Promise.all(marketCalls);
            const baseData = JSON.parse(marketRaw[0]);
            if (baseData.error) {
                setError("Item not found on market.");
            } else {
                setBaseOrders(baseData.data ?? null);
            }

            if (rank !== null && marketRaw[1]) {
                const rankedData = JSON.parse(marketRaw[1]);
                setRankedOrders(rankedData.data ?? null);
            }

            const parsedFarm: FarmResult[] = JSON.parse(farmRaw);
            const specialRules = getSpecialModSources(displayName);
            setFarmResults([...specialRules, ...parsedFarm]);
        } catch {
            setError("Error fetching market/farm results.");
        } finally {
            setLoading(false);
        }
    }

    const hasMarket = Boolean(baseOrders || rankedOrders);
    const hasFarm = farmResults.length > 0;

    return (
        <div className="flex h-full flex-col gap-4 p-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Quick Search</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Capture via shortcut (`Cmd+Shift+3`) and display consolidated Market + Farm results.
                </p>
            </div>

            {capturedName && (
                <p className="text-sm text-gray-300">
                    Detected item: <span className="font-semibold text-purple-300">{capturedName}</span>
                </p>
            )}

            {loading && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">
                    Processing results...
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-4 py-3 text-sm text-red-300">
                    {error}
                </div>
            )}

            {!loading && (hasMarket || hasFarm) && (
                <div className="grid gap-6 lg:grid-cols-2">
                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold text-purple-400">Market</h2>
                        {!hasMarket && (
                            <p className="text-sm text-gray-500">No market results for this item.</p>
                        )}
                        {hasMarket && (
                            <MarketResults
                                groups={[
                                    {id: "market-base", title: maxRank !== null ? "Cheapest (any rank)" : "Cheapest", orders: baseOrders},
                                    ...(rankedOrders ? [{id: "market-full", title: `Full rank (r${maxRank})`, orders: rankedOrders}] : []),
                                ] as MarketGroup[]}
                                itemName={capturedName}
                                containerClass="space-y-3"
                                headerBgClass="bg-gray-850"
                            />
                        )}
                    </section>

                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold text-purple-400">Farm Advisor</h2>
                        {!hasFarm && (
                            <p className="text-sm text-gray-500">No farm sources found for this item.</p>
                        )}
                        {hasFarm && (
                            <div className="space-y-3">
                                <FarmResults source="enemy" entries={grouped.enemy} showHeader />
                                <FarmResults source="mission" entries={grouped.mission} showHeader />
                                <FarmResults source="bounty" entries={grouped.bounty} showHeader />
                                <FarmResults source="relic" entries={grouped.relic} showHeader />
                                <FarmResults source="special" entries={grouped.special} showHeader />
                            </div>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}
