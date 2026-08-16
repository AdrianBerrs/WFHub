import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {Search, Sprout} from "lucide-react";
import {findFuzzyMatches} from "../lib/search";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";
import {wikiUrl} from "../lib/wikiUrl";
import {FarmResults} from "../components/FarmResults";

interface ItemEntry {
    slug: string;
    name: string;
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

    const totalResults = results.length;

    return (
        <div className="wf-page space-y-6">

            <div className="wf-panel p-5">
                <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                    <Sprout size={20} className="text-green-400" />
                    Farm Advisor
                </h1>
                <p className="mt-1 text-xs text-slate-400">
                    Search mods, resources and parts to find the best drop sources.
                </p>
            </div>

            <div className="wf-card relative p-4" ref={dropdownRef}>
                <label className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Search Farm Item
                </label>
                <div className="flex flex-col gap-2 lg:flex-row">
                    <div className="relative flex-1">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" size={15} />
                        <input
                            type="text"
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setSelectedName(null);
                            }}
                            onKeyDown={(event) => event.key === "Enter" && search()}
                            placeholder="Item or mod name (e.g. Creeping Bullseye)"
                            className="w-full rounded-lg border border-slate-800 bg-slate-950/80 py-2.5 pl-9 pr-4 text-xs font-semibold text-slate-100 placeholder-slate-500 transition-all focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500/30"
                        />
                        {suggestions.length > 0 && (
                            <div
                                className="custom-scrollbar absolute left-0 right-0 top-full z-10 mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-[#12121a] shadow-2xl">
                                {suggestions.map((item) => (
                                    <button
                                        key={item.slug || item.name}
                                        onMouseDown={() => selectSuggestion(item)}
                                        className="flex w-full items-center justify-between border-b border-slate-900/70 px-4 py-2.5 text-left text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-900/50 hover:text-green-300 last:border-0"
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
                        className="rounded-lg border border-green-500/30 bg-green-950/40 px-4 py-2.5 text-xs font-bold text-green-300 transition-colors hover:bg-green-950/60 disabled:opacity-50"
                    >
                        {loading ? "..." : "Search"}
                    </button>
                </div>
            </div>

            {searchedName && (
                <p className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-500">
                    Search for
                    <span className="font-semibold text-slate-100">{searchedName}</span>
                    <button
                        onClick={() => open(wikiUrl(searchedName))}
                        className="text-slate-500 transition-colors hover:text-primary-400"
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

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-sm text-red-300">
                    {error}
                </div>
            )}

            {totalResults > 0 && (
                <div className="space-y-6 pb-6">
                    <FarmResults source="enemy" entries={grouped.enemy} showHeader showMissionNodes variant="grid" />
                    <FarmResults source="mission" entries={grouped.mission} showHeader variant="grid" />
                    <FarmResults source="bounty" entries={grouped.bounty} showHeader variant="grid" />
                    <FarmResults source="relic" entries={grouped.relic} showHeader variant="grid" />
                    <FarmResults source="special" entries={grouped.special} showHeader variant="grid" />
                </div>
            )}

            {!loading && searchedName && totalResults === 0 && !error && (
                <p className="rounded-xl border border-dashed border-[#1e1e2d] bg-[#111119]/50 py-12 text-center text-sm text-slate-500">
                    No drops found for this item.
                </p>
            )}
        </div>
    );
}
