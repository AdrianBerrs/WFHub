import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {findFuzzyMatches} from "../lib/search";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";

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

interface Props {
    autoSearch?: string | null;
    onAutoSearchDone?: () => void;
}

const GROUP_META = {
    enemy: {title: "Inimigos", icon: "🗡️"},
    mission: {title: "Missões", icon: "🎯"},
    bounty: {title: "Bounties", icon: "🏆"},
    special: {title: "Especial", icon: "⭐"},
    relic: {title: "Relics", icon: "💠"},
} as const;

const RARITY_BADGE: Record<string, string> = {
    common: "bg-zinc-500/20 text-zinc-300 border-zinc-400/20",
    uncommon: "bg-sky-500/20 text-sky-300 border-sky-400/20",
    rare: "bg-purple-500/20 text-purple-300 border-purple-400/20",
    legendary: "bg-violet-500/20 text-violet-300 border-violet-400/20",
};

function rarityBadgeClass(rarity: string): string {
    return RARITY_BADGE[rarity.toLowerCase()] ?? "bg-gray-500/20 text-gray-300 border-gray-400/20";
}

function toSlug(name: string): string {
    return name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
}

function wikiUrl(name: string): string {
    return `https://wiki.warframe.com/w/${name.replace(/\s+/g, "_")}`;
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

function OrderRow({
                      order,
                      itemName,
                  }: {
    order: Order;
    itemName: string;
}) {
    async function copyWhisper() {
        const itemDesc = order.rank !== undefined ? `${itemName} (rank ${order.rank})` : itemName;
        const msg = `/w ${order.user.ingameName} Hi! I want to buy: ${itemDesc} for ${order.platinum} platinum. (warframe.market)`;
        await navigator.clipboard.writeText(msg);
    }

    return (
        <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200">{order.user.ingameName}</span>
                <span className="text-xs text-gray-500">rep: {order.user.reputation}</span>
                {order.rank !== undefined && (
                    <span className="rounded bg-indigo-900/60 px-1.5 py-0.5 text-xs text-indigo-300">
            r{order.rank}
          </span>
                )}
            </div>
            <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">x{order.quantity}</span>
                <span className="text-sm font-bold text-purple-400">{order.platinum}p</span>
                <button
                    onClick={copyWhisper}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
                >
                    Copiar whisper
                </button>
            </div>
        </div>
    );
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
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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
        setCollapsed({});

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
                setError("Item não encontrado no market.");
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
            setError("Erro ao buscar resultados do market/farm.");
        } finally {
            setLoading(false);
        }
    }

    function renderFarmGroup(source: keyof typeof GROUP_META, entries: FarmResult[]) {
        if (entries.length === 0) return null;
        const isEnemy = source === "enemy";
        const isRelic = source === "relic";

        return (
            <div
                className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
                {entries.map((entry, index) => {
                    const estimatedRuns = entry.chance > 0 ? Math.ceil(100 / entry.chance) : null;
                    return (
                        <div
                            key={`${source}-${entry.itemName}-${entry.location}-${index}`}
                            className="flex items-start justify-between gap-3 px-4 py-3"
                        >
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-100">{entry.itemName}</p>
                                {isEnemy ? (
                                    <button
                                        onClick={() => open(wikiUrl(entry.location))}
                                        className="mt-0.5 flex items-center gap-1 text-xs text-purple-300/90 hover:text-purple-300 hover:underline"
                                    >
                                        {entry.location}
                                        <span
                                            className="mt-0.5 flex items-center gap-1 text-xs text-purple-300/90 hover:text-purple-300 hover:underline truncate">↗</span>
                                    </button>
                                ) : (
                                    <p className="mt-0.5 text-xs text-purple-300/90">{entry.location}</p>
                                )}
                                {isEnemy && entry.dropTableChance !== undefined && entry.itemChance !== undefined && (
                                    <p className="mt-0.5 text-[11px] text-gray-500">
                                        {entry.dropTableChance.toFixed(2)}% tabela × {entry.itemChance.toFixed(2)}% item
                                    </p>
                                )}
                                {!isEnemy && entry.extra && (
                                    <p className="mt-0.5 text-xs text-gray-500">{entry.extra}</p>
                                )}
                            </div>
                            <div className="shrink-0 text-right">
                <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${rarityBadgeClass(entry.rarity)}`}>
                  {entry.rarity || "Unknown"}
                </span>
                                <p className="mt-1.5 text-sm font-bold text-purple-400">
                                    {entry.chance.toFixed(2)}%
                                </p>
                                {estimatedRuns !== null && (
                                    <p className="text-[11px] text-gray-500">
                                        ~{estimatedRuns} {isEnemy ? "kills" : isRelic ? "aberturas" : "runs"}
                                    </p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    const hasMarket = Boolean(baseOrders || rankedOrders);
    const hasFarm = farmResults.length > 0;

    function isOpen(key: string): boolean {
        return collapsed[key] !== true;
    }

    function toggleGroup(key: string) {
        setCollapsed((prev) => ({...prev, [key]: prev[key] !== true}));
    }

    function GroupHeader({
                             id,
                             title,
                             count,
                         }: {
        id: string;
        title: string;
        count: number;
    }) {
        const open = isOpen(id);
        return (
            <button
                onClick={() => toggleGroup(id)}
                className={`flex w-full items-center justify-between border border-gray-800 bg-gray-850 px-3 py-2 text-left hover:bg-gray-800/60 transition-colors ${open ? "rounded-t-lg" : "rounded-lg"}`}
            >
                <span className="text-sm font-semibold text-gray-200">{title}</span>
                <span className="flex items-center gap-2">
          <span className="text-xs text-gray-500">{count}</span>
          <span className="text-xs text-gray-400">{open ? "▲" : "▼"}</span>
        </span>
            </button>
        );
    }

    return (
        <div className="flex h-full flex-col gap-4 p-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Busca Rápida</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Captura por atalho (`Cmd+Shift+3`) e exibe resultado consolidado de Market + Farm.
                </p>
            </div>

            {capturedName && (
                <p className="text-sm text-gray-300">
                    Item detectado: <span className="font-semibold text-purple-300">{capturedName}</span>
                </p>
            )}

            {loading && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">
                    Processando resultado...
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
                            <p className="text-sm text-gray-500">Sem resultado de market para este item.</p>
                        )}
                        {hasMarket && (
                            <div className="space-y-3">
                                <div>
                                    <GroupHeader
                                        id="market-base"
                                        title={maxRank !== null ? "Mais barato (qualquer rank)" : "Mais barato"}
                                        count={(baseOrders?.sell ?? []).length}
                                    />
                                    {isOpen("market-base") && (
                                        <div
                                            className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
                                            {(baseOrders?.sell ?? []).map((order, index) => (
                                                <OrderRow key={`base-${index}`} order={order} itemName={capturedName}/>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {rankedOrders && (
                                    <div>
                                        <GroupHeader
                                            id="market-full"
                                            title={`Full rank (r${maxRank})`}
                                            count={rankedOrders.sell.length}
                                        />
                                        {isOpen("market-full") && (
                                            <div
                                                className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
                                                {rankedOrders.sell.map((order, index) => (
                                                    <OrderRow key={`ranked-${index}`} order={order}
                                                              itemName={capturedName}/>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </section>

                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold text-purple-400">Farm Advisor</h2>
                        {!hasFarm && (
                            <p className="text-sm text-gray-500">Sem fontes de farm encontradas para este item.</p>
                        )}
                        {hasFarm && (
                            <div className="space-y-3">
                                {(
                                    [
                                        ["enemy", grouped.enemy],
                                        ["mission", grouped.mission],
                                        ["bounty", grouped.bounty],
                                        ["relic", grouped.relic],
                                        ["special", grouped.special],
                                    ] as Array<[keyof typeof GROUP_META, FarmResult[]]>
                                ).map(([source, entries]) => {
                                    if (entries.length === 0) return null;
                                    const meta = GROUP_META[source];
                                    const key = `farm-${source}`;
                                    return (
                                        <div key={key}>
                                            <GroupHeader
                                                id={key}
                                                title={`${meta.icon} ${meta.title}`}
                                                count={entries.length}
                                            />
                                            {isOpen(key) && renderFarmGroup(source, entries)}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}
