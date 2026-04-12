import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {findFuzzyMatches} from "../lib/search";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";

function wikiUrl(name: string): string {
    return `https://wiki.warframe.com/w/${name.replace(/\s+/g, "_")}`;
}

interface ItemEntry {
    slug: string;
    name: string;
}

const GROUP_META = {
    enemy: {
        title: "Enemies",
        icon: "🗡️",
    },
    mission: {
        title: "Missions",
        icon: "🎯",
    },
    bounty: {
        title: "Bounties",
        icon: "🏆",
    },
    special: {
        title: "Special",
        icon: "⭐",
    },
    relic: {
        title: "Relics",
        icon: "💠",
    },
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

function groupResults(results: FarmResult[]) {
    return {
        enemy: results.filter((result) => result.source === "enemy"),
        mission: results.filter((result) => result.source === "mission"),
        bounty: results.filter((result) => result.source === "bounty"),
        special: results.filter((result) => result.source === "special"),
        relic: results.filter((result) => result.source === "relic"),
    };
}

interface Props {
    autoSearch?: string | null;
    onAutoSearchDone?: () => void;
}

export default function FarmAdvisorPage({autoSearch, onAutoSearchDone}: Props) {
    const [query, setQuery] = useState("");
    const [allItems, setAllItems] = useState<ItemEntry[]>([]);
    const [allModNames, setAllModNames] = useState<string[]>([]);
    const [allWfcdMods, setAllWfcdMods] = useState<string[]>([]);
    const [suggestions, setSuggestions] = useState<ItemEntry[]>([]);
    const [selectedName, setSelectedName] = useState<string | null>(null);
    const [results, setResults] = useState<FarmResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchedName, setSearchedName] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);
    const deferredQuery = useDeferredValue(query);

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_mod_names")
            .then((raw) => setAllModNames(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_all_mods")
            .then((raw) => setAllWfcdMods(JSON.parse(raw)))
            .catch(() => {
            });
    }, []);

    const searchableItems = useMemo<ItemEntry[]>(() => {
        const seen = new Set(allItems.map((item) => item.name.toLowerCase()));
        const extraNames = [
            ...allModNames.filter((name) => !seen.has(name.toLowerCase())),
            ...allWfcdMods.filter((name) => !seen.has(name.toLowerCase())),
        ];
        const dedupedExtras = Array.from(new Map(extraNames.map((name) => [name.toLowerCase(), name])).values());
        const combined = [...allItems, ...dedupedExtras.map((name) => ({slug: "", name}))];
        const seenFinal = new Set<string>();
        return combined.filter((item) => {
            const key = item.name.toLowerCase();
            if (seenFinal.has(key)) return false;
            seenFinal.add(key);
            return true;
        });
    }, [allItems, allModNames, allWfcdMods]);

    useEffect(() => {
        if (!autoSearch || searchableItems.length === 0) return;
        search(autoSearch);
        onAutoSearchDone?.();
    }, [autoSearch, searchableItems]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (deferredQuery.trim().length < 3 || selectedName !== null) {
            setSuggestions([]);
            return;
        }
        setSuggestions(findFuzzyMatches(searchableItems, deferredQuery, 8));
    }, [deferredQuery, searchableItems, selectedName]);

    useEffect(() => {
        function handleClick(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setSuggestions([]);
            }
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const grouped = useMemo(() => groupResults(results), [results]);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    function isOpen(key: string) {
        return !collapsed[key];
    }

    function toggleGroup(key: string) {
        setCollapsed((prev) => ({...prev, [key]: !prev[key]}));
    }

    async function search(overrideName?: string) {
        const matched = findFuzzyMatches(searchableItems, query, 1)[0];
        const itemName = overrideName ?? selectedName ?? matched?.name ?? query.trim();
        if (!itemName) return;

        setLoading(true);
        setError(null);
        setResults([]);
        setSuggestions([]);

        try {
            const raw = await invoke<string>("search_farm_data", {query: itemName});
            const parsed: FarmResult[] = JSON.parse(raw);
            const specialRules = getSpecialModSources(itemName);
            setResults([...specialRules, ...parsed]);
            setSearchedName(itemName);
            if (overrideName) {
                setQuery(overrideName);
                setSelectedName(overrideName);
            } else if (matched) {
                setQuery(matched.name);
                setSelectedName(matched.name);
            } else {
                setSelectedName(null);
            }
        } catch {
            setError("Error fetching drop data.");
        } finally {
            setLoading(false);
        }
    }

    function selectSuggestion(item: ItemEntry) {
        setQuery(item.name);
        setSelectedName(item.name);
        search(item.name);
    }

    function renderGroup(source: keyof typeof GROUP_META, entries: FarmResult[]) {
        if (entries.length === 0) return null;
        const meta = GROUP_META[source];
        const key = source;
        const expanded = isOpen(key);
        const isEnemy = source === "enemy";
        const isRelic = source === "relic";

        return (
            <div key={source}>
                <button
                    onClick={() => toggleGroup(key)}
                    className={`flex w-full items-center justify-between border border-gray-800 bg-gray-900/60 px-3 py-2 text-left hover:bg-gray-800/60 transition-colors ${expanded ? "rounded-t-lg" : "rounded-lg"}`}
                >
          <span className="flex items-center gap-2 text-sm font-semibold text-gray-200">
            <span>{meta.icon}</span>
              {meta.title}
          </span>
                    <span className="flex items-center gap-2">
            <span className="text-xs text-gray-500">{entries.length}</span>
            <span className="text-xs text-gray-400">{expanded ? "▲" : "▼"}</span>
          </span>
                </button>

                {expanded && (
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
                                                {entry.dropTableChance.toFixed(2)}% table
                                                × {entry.itemChance.toFixed(2)}% item
                                            </p>
                                        )}
                                        {isEnemy && (() => {
                                            const nodes = entry.missionNodes;
                                            const planets = entry.planets ?? [];
                                            if (nodes && nodes.length > 0) {
                                                return (
                                                    <p className="mt-0.5 text-[10px] text-gray-500">
                                                        {nodes.slice(0, 2).map(n => `${n.node} — ${n.planet}`).join(", ")}
                                                    </p>
                                                );
                                            }
                                            if (planets.length === 0) return null;
                                            const shown = planets.slice(0, 3);
                                            const extra = planets.length > 3 ? " ..." : "";
                                            return (
                                                <p className="mt-0.5 text-[10px] text-gray-500">
                                                    {shown.join(" · ")}{extra}
                                                </p>
                                            );
                                        })()}
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
                                                ~{estimatedRuns} {isEnemy ? "kills" : isRelic ? "runs" : "runs"}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    const totalResults = results.length;

    return (
        <div className="flex h-full flex-col gap-4 p-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Farm Advisor</h1>
                <p className="text-sm text-gray-500">
                    Item farm location list.
                </p>
            </div>
            <div className="relative" ref={dropdownRef}>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setSelectedName(null);
                        }}
                        onKeyDown={(event) => event.key === "Enter" && search()}
                        placeholder="Item or mod name (e.g. Creeping Bullseye)"
                        className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                    />
                    <button
                        onClick={() => search()}
                        disabled={loading}
                        className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-purple-400 disabled:opacity-50"
                    >
                        {loading ? "..." : "Search"}
                    </button>
                </div>

                {suggestions.length > 0 && (
                    <div
                        className="absolute left-0 right-12 top-full z-10 mt-1 overflow-hidden rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
                        {suggestions.map((item) => (
                            <button
                                key={item.slug || item.name}
                                onMouseDown={() => selectSuggestion(item)}
                                className="w-full border-b border-gray-700/50 px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 last:border-0"
                            >
                                {item.name}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {searchedName && (
                <p className="text-xs text-gray-500 flex items-center gap-1 flex-wrap">
                    Search for
                    <span className="text-gray-100 font-semibold">{searchedName}</span>
                    <button
                        onClick={() => open(wikiUrl(searchedName))}
                        className="text-gray-500 hover:text-purple-400 transition-colors"
                        title="View on wiki"
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M7 1h4v4M11 1L5 7M3 2H1v9h9V9" stroke="currentColor" strokeWidth="1.5"
                                  strokeLinecap="round"/>
                        </svg>
                    </button>
                    {totalResults > 0 && <span>· {totalResults} drops found</span>}
                </p>
            )}

            {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

            {totalResults > 0 && (
                <div className="space-y-6 pb-6">
                    {renderGroup("enemy", grouped.enemy)}
                    {renderGroup("mission", grouped.mission)}
                    {renderGroup("bounty", grouped.bounty)}
                    {renderGroup("relic", grouped.relic)}
                    {renderGroup("special", grouped.special)}
                </div>
            )}

            {!loading && searchedName && totalResults === 0 && !error && (
                <p className="text-sm text-gray-500">No drops found for this item.</p>
            )}
        </div>
    );
}
