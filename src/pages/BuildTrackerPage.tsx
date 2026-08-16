import {useEffect, useMemo, useState, useCallback, useRef} from "react";
import {useNavigate} from "react-router-dom";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {FolderOpen, Search} from "lucide-react";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";
import {wikiUrl} from "../lib/wikiUrl";
import {sourceLabel} from "../lib/sourceLabel";
import {rarityBadgeClass} from "../lib/rarityBadge";

interface Build {
    id: string;
    name: string;
    items: string[];
    created_at: string;
    related_entity?: string | null;
    related_entity_kind?: "Warframe" | "Weapon" | null;
    screenshot_rel_path?: string | null;
}

interface ItemDetail {
    owned: boolean;
    farm: FarmResult[];
    farmLoading: boolean;
    farmExpanded: boolean;
}

interface BuildDetail {
    itemDetails: Record<string, ItemDetail>;
    loaded: boolean;
}

interface ScreenshotPreviewState {
    loading: boolean;
    src?: string;
    error?: boolean;
}

type QuickFilter = "All" | "Warframe" | "Weapon" | "Other";

interface ItemSlugEntry {
    slug: string;
    name: string;
}

const QUICK_FILTERS: { key: QuickFilter; label: string }[] = [
    {key: "All", label: "All"},
    {key: "Warframe", label: "Warframes"},
    {key: "Weapon", label: "Weapons"},
    {key: "Other", label: "Others"},
];

export default function BuildTrackerPage() {
    const navigate = useNavigate();
    const [builds, setBuilds] = useState<Build[]>([]);
    const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, BuildDetail>>({});
    const [previewByBuildId, setPreviewByBuildId] = useState<Record<string, ScreenshotPreviewState>>({});
    const [search, setSearch] = useState("");
    const [quickFilter, setQuickFilter] = useState<QuickFilter>("All");
    const [pricesMap, setPricesMap] = useState<Record<string, string>>({});
    const [apiPrices, setApiPrices] = useState<Record<string, number | null>>({});
    const [apiPricesLoading, setApiPricesLoading] = useState(false);
    const selectedBuild = builds.find((b) => b.id === selectedBuildId) ?? null;
    const detailsLoadedRef = useRef<Set<string>>(new Set());
    const nameToSlugRef = useRef<Record<string, string>>({});
    const ownedSetRef = useRef<Set<string>>(new Set());

    const loadBuilds = useCallback(async () => {
        try {
            const raw = await invoke<string>("read_builds");
            setBuilds(JSON.parse(raw));
        } catch { /* ignore */
        }
    }, []);

    useEffect(() => {
        loadBuilds();
        invoke<string>("read_prices")
            .then((raw) => {
                const entries: { name: string; custom_avg: string }[] = JSON.parse(raw);
                const map: Record<string, string> = {};
                for (const e of entries) {
                    map[e.name.toLowerCase()] = e.custom_avg;
                }
                setPricesMap(map);
            })
            .catch(() => {
            });
        invoke<string>("read_items_list")
            .then((raw) => {
                const entries: ItemSlugEntry[] = JSON.parse(raw);
                const map: Record<string, string> = {};
                for (const e of entries) {
                    map[e.name.toLowerCase()] = e.slug;
                }
                nameToSlugRef.current = map;
            })
            .catch(() => {
            });
        invoke<string>("read_inventory")
            .then((raw) => {
                const inv = JSON.parse(raw);
                const set = new Set<string>(
                    [...(inv.mods ?? []), ...(inv.arcanes ?? [])].map((n: string) => n.toLowerCase())
                );
                ownedSetRef.current = set;
            })
            .catch(() => {
            });
    }, [loadBuilds]);

    const selectedBuildItems = selectedBuild?.items ?? [];

    const filteredBuilds = useMemo(() => {
        const q = search.trim().toLowerCase();
        return builds.filter((b) => {
            if (quickFilter !== "All" && (b.related_entity_kind ?? "Other") !== quickFilter) return false;
            if (q && !b.name.toLowerCase().includes(q) && !b.related_entity?.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [builds, search, quickFilter]);

    function getPrice(itemName: string): { price: string | null; loading: boolean } {
        const cached = pricesMap[itemName.toLowerCase()];
        if (cached) {
            const num = parseFloat(cached);
            if (!isNaN(num)) return {price: num.toFixed(1), loading: false};
        }
        const apiPrice = apiPrices[itemName];
        if (apiPrice !== undefined) {
            if (apiPrice === null) return {price: null, loading: false};
            return {price: String(apiPrice), loading: false};
        }
        return {price: null, loading: apiPricesLoading};
    }

    async function fetchAllPrices(build: Build, ownedSet: Set<string>) {
        setApiPrices({});
        setApiPricesLoading(true);

        const slugs: { name: string; slug: string }[] = [];
        for (const item of build.items) {
            if (ownedSet.has(item.toLowerCase())) continue;
            if (pricesMap[item.toLowerCase()]) continue;
            const slug = nameToSlugRef.current[item.toLowerCase()];
            if (slug) slugs.push({name: item, slug});
        }
        if (slugs.length === 0) {
            setApiPricesLoading(false);
            return;
        }

        const results = await Promise.allSettled(
            slugs.map(({slug}) =>
                invoke<string>("fetch_market_top", {slug, rank: 0})
                    .then((raw) => JSON.parse(raw))
                    .then((data) => {
                        const sell = data?.data?.sell ?? [];
                        return sell.length > 0 ? sell[0].platinum : null;
                    })
            )
        );
        const newPrices: Record<string, number | null> = {};
        for (let i = 0; i < slugs.length; i++) {
            const result = results[i];
            newPrices[slugs[i].name] = result.status === "fulfilled" ? result.value : null;
        }
        setApiPrices(newPrices);
        setApiPricesLoading(false);
    }

    async function loadBuildDetails(build: Build) {
        if (detailsLoadedRef.current.has(build.id)) return;
        detailsLoadedRef.current.add(build.id);

        if (build.screenshot_rel_path && !previewByBuildId[build.id]) {
            void loadBuildScreenshotPreview(build.id, build.screenshot_rel_path);
        }

        const raw = await invoke<string>("read_inventory").catch(() => '{"mods":[],"arcanes":[]}');
        const inv = JSON.parse(raw);
        const ownedSet = new Set<string>(
            [...(inv.mods ?? []), ...(inv.arcanes ?? [])].map((n: string) => n.toLowerCase())
        );

        const itemDetails: Record<string, ItemDetail> = {};
        for (const item of build.items) {
            itemDetails[item] = {
                owned: ownedSet.has(item.toLowerCase()),
                farm: [],
                farmLoading: false,
                farmExpanded: false,
            };
        }

        setDetails((prev) => ({
            ...prev,
            [build.id]: {itemDetails, loaded: true},
        }));

        fetchAllPrices(build, ownedSet);
    }

    function selectBuild(build: Build) {
        setSelectedBuildId(build.id);
        loadBuildDetails(build);
    }

    async function loadFarm(buildId: string, item: string) {
        setDetails((prev) => ({
            ...prev,
            [buildId]: {
                ...prev[buildId],
                itemDetails: {
                    ...prev[buildId].itemDetails,
                    [item]: {...prev[buildId].itemDetails[item], farmLoading: true, farmExpanded: true},
                },
            },
        }));

        try {
            const raw = await invoke<string>("search_farm_data", {query: item});
            const parsed: FarmResult[] = JSON.parse(raw);
            const special = getSpecialModSources(item);
            setDetails((prev) => ({
                ...prev,
                [buildId]: {
                    ...prev[buildId],
                    itemDetails: {
                        ...prev[buildId].itemDetails,
                        [item]: {
                            ...prev[buildId].itemDetails[item],
                            farm: [...special, ...parsed],
                            farmLoading: false,
                        },
                    },
                },
            }));
        } catch {
            setDetails((prev) => ({
                ...prev,
                [buildId]: {
                    ...prev[buildId],
                    itemDetails: {
                        ...prev[buildId].itemDetails,
                        [item]: {...prev[buildId].itemDetails[item], farmLoading: false},
                    },
                },
            }));
        }
    }

    function toggleFarm(buildId: string, item: string) {
        const detail = details[buildId]?.itemDetails[item];
        if (!detail) return;
        if (!detail.farmExpanded && detail.farm.length === 0 && !detail.farmLoading) {
            loadFarm(buildId, item);
            return;
        }
        setDetails((prev) => ({
            ...prev,
            [buildId]: {
                ...prev[buildId],
                itemDetails: {
                    ...prev[buildId].itemDetails,
                    [item]: {...prev[buildId].itemDetails[item], farmExpanded: !detail.farmExpanded},
                },
            },
        }));
    }

    async function deleteBuild(id: string) {
        await invoke("delete_build", {id});
        setBuilds((prev) => prev.filter((b) => b.id !== id));
        if (selectedBuildId === id) setSelectedBuildId(null);
    }

    async function openBuildScreenshot(screenshotRelPath: string) {
        try {
            const absolutePath = await invoke<string>("resolve_build_screenshot_path", {screenshotRelPath});
            await open(absolutePath);
        } catch { /* ignore */
        }
    }

    async function loadBuildScreenshotPreview(buildId: string, screenshotRelPath: string) {
        setPreviewByBuildId((prev) => {
            if (prev[buildId]) return prev;
            return {...prev, [buildId]: {loading: true}};
        });

        try {
            const dataUrl = await invoke<string>("read_build_screenshot_preview", {screenshotRelPath});
            setPreviewByBuildId((prev) => ({
                ...prev,
                [buildId]: {loading: false, src: dataUrl},
            }));
        } catch {
            setPreviewByBuildId((prev) => ({
                ...prev,
                [buildId]: {loading: false, error: true},
            }));
        }
    }

    const renderFarmCard = (entry: FarmResult, index: number) => {
        const isEnemy = entry.source === "enemy";
        const isRelic = entry.source === "relic";
        const estimatedRuns = entry.chance > 0 ? Math.ceil(100 / entry.chance) : null;

        return (
            <div
                key={`${entry.itemName}-${entry.location}-${index}`}
                className="flex flex-col gap-2 rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2.5 transition-colors hover:border-slate-800"
            >
                <span className="self-start rounded-full border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-400">
                    {sourceLabel(entry.source)}
                </span>
                {isEnemy ? (
                    <button
                        onClick={() => open(wikiUrl(entry.location))}
                        className="flex items-center gap-1 truncate text-[11px] font-semibold text-accents-350/90 hover:text-primary-300 hover:underline"
                    >
                        {entry.location} ↗
                    </button>
                ) : (
                    <p className="truncate text-[11px] text-primary-300/90">{entry.location}</p>
                )}
                {isEnemy && entry.dropTableChance !== undefined && entry.itemChance !== undefined && (
                    <p className="text-[10px] text-slate-500">
                        {entry.dropTableChance.toFixed(2)}% table × {entry.itemChance.toFixed(2)}% item
                    </p>
                )}
                {isEnemy && (() => {
                    const nodes = entry.missionNodes;
                    const planets = entry.planets ?? [];
                    if (nodes && nodes.length > 0) {
                        return (
                            <p className="text-[10px] text-slate-500">
                                {nodes.slice(0, 2).map(n => `${n.node} — ${n.planet}`).join(", ")}
                            </p>
                        );
                    }
                    if (planets.length === 0) return null;
                    const shown = planets.slice(0, 3);
                    const extra = planets.length > 3 ? " ..." : "";
                    return <p className="text-[10px] text-slate-500">{shown.join(" · ")}{extra}</p>;
                })()}
                {!isEnemy && entry.extra && (
                    <p className="text-[11px] text-slate-500">{entry.extra}</p>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${rarityBadgeClass(entry.rarity)}`}>
                        {entry.rarity || "Unknown"}
                    </span>
                    <div className="text-right">
                        <p className="font-mono text-xs font-black text-primary-400">{entry.chance.toFixed(2)}%</p>
                        {estimatedRuns !== null && (
                            <p className="text-[10px] text-slate-500">
                                ~{estimatedRuns} {isEnemy ? "kills" : isRelic ? "runs" : "runs"}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderBuildItem = (item: string, buildId: string) => {
        const d = details[buildId]?.itemDetails[item];
        if (!d) return null;
        const {price, loading} = getPrice(item);

        return (
            <div key={item} className="border-b border-zinc-800/50 last:border-b-0">
                <div
                    className={`flex items-center gap-2 px-4 py-2.5 ${!d.owned ? "cursor-pointer hover:bg-zinc-800/40" : ""}`}
                    onClick={() => !d.owned && toggleFarm(buildId, item)}
                >
          <span className={d.owned ? "text-green-400 text-sm shrink-0" : "text-red-500/70 text-sm shrink-0"}>
            {d.owned ? "✓" : "✗"}
          </span>
                    <span className={`text-sm flex-1 min-w-0 truncate ${d.owned ? "text-zinc-300" : "text-zinc-400"}`}>
            {item}
          </span>
                    {!d.owned && loading && (
                        <span className="text-[10px] text-zinc-500 shrink-0">PL...</span>
                    )}
                    {!d.owned && !loading && price !== null && (
                        <span className="text-xs text-amber-400 font-semibold shrink-0 whitespace-nowrap">
                {price} <img src={"/PlatinumLarge.webp"} alt="PL" className="inline-block w-3 h-3 -mt-0.5"/>
              </span>
                    )}
                    {!d.owned && (
                        <span className="text-xs text-zinc-600 shrink-0">
                {d.farmLoading ? "..." : d.farmExpanded ? "▲" : "▼"}
              </span>
                    )}
                </div>

                {!d.owned && d.farmExpanded && (
                    <div className="px-4 pb-3 space-y-2">
                        {loading && (
                            <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
                                <span className="text-[10px] text-zinc-500">Loading price...</span>
                            </div>
                        )}
                        {!loading && price !== null && (
                            <div className="flex items-center gap-2 rounded-lg border border-amber-800/30 bg-amber-950/10 px-3 py-2">
                                <span className="text-xs text-amber-300 font-semibold">{price} PL</span>
                                <span className="text-[10px] text-zinc-500">(R0 market avg)</span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); navigate("/market", { state: { autoSearch: item } }); }}
                                    className="ml-auto text-zinc-500 hover:text-amber-300 transition-colors"
                                    title="View on Market"
                                >
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                        <path d="M2 2h8v8M10 2L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                        <path d="M10 6v4H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                </button>
                            </div>
                        )}
                        {d.farmLoading && (
                            <p className="text-xs text-zinc-500">Loading farm sources...</p>)}
                        {!d.farmLoading && d.farm.length === 0 && (
                            <p className="text-xs text-zinc-500">No sources found.</p>)}
                        {!d.farmLoading && d.farm.length > 0 && (
                            <div
                                className="grid gap-2.5"
                                style={{gridTemplateColumns: `repeat(${Math.min(d.farm.slice(0, 8).length, 4)}, minmax(0, 1fr))`}}
                            >
                                {d.farm.slice(0, 8).map((farm, idx) => renderFarmCard(farm, idx))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="wf-page flex min-h-full flex-col gap-5">
            <div className="wf-panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                        <FolderOpen size={20} className="text-amber-400" />
                        Builds & Mods
                    </h1>
                    <p className="mt-1 text-xs text-slate-400">
                        Track saved builds and farm indicators.
                    </p>
                </div>
                <button
                    onClick={() => navigate("/build-analyzer")}
                    className="flex shrink-0 items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-4 py-2 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60"
                    title="Analyze a new build from a screenshot"
                >
                    <Search size={15} />
                    Build Analyze
                </button>
            </div>

            <div className="flex flex-1 min-h-0">
                {/* LEFT PANEL - Build list */}
                <div className="flex w-[30%] min-w-[260px] max-w-[380px] flex-col border-r border-[#1e1e2d] bg-[#0a0a10]/60 rounded-l-xl">
                    <div className="border-b border-[#1e1e2d] p-4 space-y-3">
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={13}/>
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search builds..."
                                className="w-full rounded-lg border border-slate-800 bg-slate-950/80 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder-slate-500 focus:border-primary-500 focus:outline-none"
                            />
                        </div>

                        <div className="flex gap-1">
                            {QUICK_FILTERS.map(({key, label}) => (
                                <button
                                    key={key}
                                    onClick={() => setQuickFilter(key)}
                                    className={`rounded-lg px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                                        quickFilter === key
                                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                            : "bg-slate-900/60 text-zinc-400 border border-transparent hover:border-zinc-700 hover:text-zinc-300"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="custom-scrollbar flex-1 overflow-y-auto p-2 space-y-1">
                        {filteredBuilds.length === 0 ? (
                            <p className="px-3 py-6 text-xs text-zinc-500 text-center">
                                {builds.length === 0
                                    ? 'No saved builds. Click "Analyze" to add one.'
                                    : "No builds match your filter."}
                            </p>
                        ) : (
                                            filteredBuilds.map((build) => {
                                                const isActive = build.id === selectedBuildId;
                                                const total = build.items.length;
                                                const owned = build.items.filter((item) => ownedSetRef.current.has(item.toLowerCase())).length;

                                return (
                                    <div
                                        key={build.id}
                                        onClick={() => selectBuild(build)}
                                        className={`group flex items-center gap-2 rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${
                                            isActive
                                                ? "bg-gradient-to-r from-amber-950/20 to-slate-900 border border-amber-500/20"
                                                : "border border-transparent hover:bg-slate-900/60"
                                        }`}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className={`text-xs font-bold truncate ${isActive ? "text-amber-300" : "text-slate-300"}`}>
                                                {build.name}
                                            </p>
                                            {build.related_entity && (
                                                <p className="text-[10px] text-zinc-500 truncate mt-0.5">
                                                    {build.related_entity}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {total > 0 && (
                                                <span className={`text-[10px] font-semibold ${owned === total ? "text-green-400" : "text-zinc-400"}`}>
                                                    {owned}/{total}
                                                </span>
                                            )}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    deleteBuild(build.id);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-600 hover:text-red-400 transition-all text-xs"
                                                title="Delete build"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>

                {/* RIGHT PANEL - Build preview */}
                <div className="custom-scrollbar flex-1 overflow-y-auto">
                    {!selectedBuild ? (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                                <FolderOpen size={32} className="mx-auto text-zinc-700 mb-3"/>
                                <p className="text-sm text-zinc-500">Select a build to view details</p>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-4 p-5">
                            <div className="flex items-start justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-slate-100">{selectedBuild.name}</h2>
                                    {selectedBuild.related_entity && (
                                        <p className="text-xs text-zinc-400 mt-0.5">
                                            {selectedBuild.related_entity_kind ? `${selectedBuild.related_entity_kind}: ` : ""}
                                            {selectedBuild.related_entity}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {details[selectedBuild.id]?.loaded && selectedBuildItems.length > 0 && (
                                        <span className="text-xs text-zinc-500">
                                            {Object.values(details[selectedBuild.id].itemDetails).filter((d) => d.owned).length}
                                            /{selectedBuildItems.length} owned
                                        </span>
                                    )}
                                </div>
                            </div>

                            {selectedBuild.screenshot_rel_path && (
                                <div className="rounded-xl border border-[#1e1e2d] bg-zinc-900/50 overflow-hidden">
                                    {previewByBuildId[selectedBuild.id]?.loading && (
                                        <div className="flex items-center justify-center h-32">
                                            <p className="text-xs text-zinc-500">Loading screenshot preview...</p>
                                        </div>
                                    )}
                                    {!previewByBuildId[selectedBuild.id]?.loading && previewByBuildId[selectedBuild.id]?.error && (
                                        <div className="flex items-center justify-center h-32">
                                            <p className="text-xs text-zinc-500">Screenshot preview unavailable.</p>
                                        </div>
                                    )}
                                    {!previewByBuildId[selectedBuild.id]?.loading && previewByBuildId[selectedBuild.id]?.src && (
                                        <button
                                            onClick={() => openBuildScreenshot(selectedBuild.screenshot_rel_path!)}
                                            className="block w-full overflow-hidden hover:opacity-90 transition-opacity"
                                            title="Open saved screenshot"
                                        >
                                            <img
                                                src={previewByBuildId[selectedBuild.id].src}
                                                alt={`Preview of build ${selectedBuild.name}`}
                                                className="w-full max-h-64 object-contain bg-black/40"
                                            />
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className="rounded-xl border border-[#1e1e2d] bg-[#111119] overflow-hidden">
                                <div className="px-4 py-3 border-b border-zinc-800">
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                                        Build Items
                                    </h3>
                                </div>
                                {!details[selectedBuild.id]?.loaded ? (
                                    <p className="px-4 py-3 text-xs text-zinc-500">Loading...</p>
                                ) : selectedBuildItems.length === 0 ? (
                                    <p className="px-4 py-3 text-xs text-zinc-500">No items in this build.</p>
                                ) : (
                                    <div className="divide-y divide-zinc-800/50">
                                        {selectedBuildItems.map((item) => renderBuildItem(item, selectedBuild.id))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
