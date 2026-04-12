import {useEffect, useState, useCallback} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";

function wikiUrl(name: string): string {
    return `https://wiki.warframe.com/w/${name.replace(/\s+/g, "_")}`;
}

interface Build {
    id: string;
    name: string;
    items: string[];
    created_at: string;
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

function sourceLabel(source: FarmResult["source"]): string {
    switch (source) {
        case "enemy":
            return "Enemy";
        case "mission":
            return "Mission";
        case "bounty":
            return "Bounty";
        case "special":
            return "Special";
        case "relic":
            return "Relic";
    }
}

export default function BuildTrackerPage() {
    const [builds, setBuilds] = useState<Build[]>([]);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, BuildDetail>>({});
    const [previewByBuildId, setPreviewByBuildId] = useState<Record<string, ScreenshotPreviewState>>({});
    const loadBuilds = useCallback(async () => {
        try {
            const raw = await invoke<string>("read_builds");
            setBuilds(JSON.parse(raw));
        } catch { /* ignore */
        }
    }, []);

    useEffect(() => {
        loadBuilds();
    }, [loadBuilds]);

    async function expandBuild(build: Build) {
        if (expanded === build.id) {
            setExpanded(null);
            return;
        }
        setExpanded(build.id);

        if (build.screenshot_rel_path && !previewByBuildId[build.id]) {
            void loadBuildScreenshotPreview(build.id, build.screenshot_rel_path);
        }

        // Already loaded this session — skip
        if (details[build.id]?.loaded) return;

        // Load inventory once
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
        if (expanded === id) setExpanded(null);
    }

    async function openBuildScreenshot(screenshotRelPath: string) {
        try {
            const absolutePath = await invoke<string>("resolve_build_screenshot_path", {screenshotRelPath});
            await open(absolutePath);
        } catch {
            // ignore
        }
    }

    async function loadBuildScreenshotPreview(buildId: string, screenshotRelPath: string) {
        setPreviewByBuildId((prev) => {
            if (prev[buildId]) return prev;
            return {
                ...prev,
                [buildId]: {loading: true},
            };
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

    return (
        <div className="flex flex-col h-full p-4 gap-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Build Tracker</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Track saved builds and farm indicators.
                </p>
            </div>

            {builds.length === 0 ? (
                <p className="text-gray-500 text-sm">
                    No saved builds. Analyze a build in Build Analyzer and click "Save Build".
                </p>
            ) : (
                <div className="flex-1 overflow-auto space-y-2">
                    {builds.map((build) => {
                        const isOpen = expanded === build.id;
                        const detail = details[build.id];
                        const items = detail?.itemDetails ?? {};
                        const owned = Object.values(items).filter((d) => d.owned).length;
                        const total = build.items.length;
                        const complete = total > 0 && owned === total;

                        return (
                            <div key={build.id} className="rounded-lg border border-gray-800 overflow-hidden">
                                {/* Card header */}
                                <div
                                    className={`flex items-center gap-3 px-3 py-2.5 ${isOpen ? "bg-gray-900/80" : "bg-gray-900/60"}`}>
                                    <button
                                        onClick={() => expandBuild(build)}
                                        className="flex-1 flex items-center justify-between text-left hover:opacity-80 transition-opacity">
                                        <span className="flex items-center gap-2 min-w-0">
                                          <span
                                              className="text-sm font-medium text-gray-200 truncate">{build.name}</span>
                                            {build.screenshot_rel_path && (
                                                <span
                                                    className="shrink-0 rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-300">
                                                Screenshot saved
                                              </span>
                                            )}
                                        </span>
                                        <span className="flex items-center gap-2 shrink-0">
                                            {detail?.loaded && (
                                                <>
                                                    <span className={`text-xs font-semibold ${complete ? "text-green-400" : "text-purple-400"}`}>
                                                {owned}/{total}
                                                    </span>
                                                    <span className="w-16 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                                                        <span
                                                            className={`block h-full rounded-full transition-all ${complete ? "bg-green-500" : "bg-purple-500"}`}
                                                            style={{width: total > 0 ? `${(owned / total) * 100}%` : "0%"}}/>
                                                    </span>
                                                </>
                                            )}
                                          {!detail?.loaded && (
                                              <span className="text-xs text-gray-500">{total} items</span>)}
                                            <span className="text-xs text-gray-500">{isOpen ? "▲" : "▼"}</span>
                                        </span>
                                    </button>
                                    <button
                                        onClick={() => deleteBuild(build.id)}
                                        className="text-gray-600 hover:text-red-400 text-sm transition-colors shrink-0"
                                        title="Delete build">
                                        ✕
                                    </button>
                                </div>

                                {/* Expanded items */}
                                {isOpen && (
                                    <div className="border-t border-gray-800">
                                        <div
                                            className={`grid ${build.screenshot_rel_path ? "xl:grid-cols-[700px_1fr]" : "grid-cols-1"}`}>
                                            {/* PREVIEW */}
                                            {build.screenshot_rel_path && (
                                                <div
                                                    className="border-b border-gray-800 bg-gray-900/50 p-4 xl:border-b-0 xl:border-r">
                                                    <p className="text-xs text-gray-500 mb-3 text-center">Screenshot preview.</p>
                                                    {previewByBuildId[build.id]?.loading && (
                                                        <p className="text-xs text-gray-500">Loading screenshot preview...</p>
                                                    )}
                                                    {!previewByBuildId[build.id]?.loading && previewByBuildId[build.id]?.error && (
                                                        <p className="text-xs text-gray-500">Screenshot preview unavailable.</p>
                                                    )}
                                                    {!previewByBuildId[build.id]?.loading && previewByBuildId[build.id]?.src && (
                                                        <button
                                                            onClick={() => openBuildScreenshot(build.screenshot_rel_path!)}
                                                            className="block w-full overflow-hidden rounded-lg border border-gray-800 bg-gray-950/70 hover:border-gray-700 transition-colors"
                                                            title="Open saved screenshot">
                                                            <img
                                                                src={previewByBuildId[build.id].src}
                                                                alt={`Preview of build ${build.name}`}
                                                                className="w-full max-h-56 sm:max-h-64 object-contain"
                                                            />
                                                        </button>
                                                    )}
                                                </div>
                                            )}

                                            {/* ITENS */}
                                            <div className="divide-y divide-gray-800/50 min-w-0">
                                                {!detail?.loaded ? (
                                                    <p className="px-4 py-3 text-xs text-gray-500">Loading...</p>
                                                ) : build.items.length === 0 ? (
                                                    <p className="px-4 py-3 text-xs text-gray-500">No items recognized in this build.</p>
                                                ) : (
                                                    build.items.map((item) => {
                                                        const d = items[item];
                                                        if (!d) return null;

                                                        return (
                                                            <div key={item} className="bg-gray-900/40">
                                                                {/* Item row */}
                                                                <div
                                                                    className={`flex items-center gap-2 px-4 py-2 ${!d.owned ? "cursor-pointer hover:bg-gray-800/40" : ""}`}
                                                                    onClick={() => !d.owned && toggleFarm(build.id, item)}>
                                                                  <span
                                                                      className={d.owned ? "text-green-400 text-sm" : "text-red-500/70 text-sm"}>
                                                                    {d.owned ? "✓" : "✗"}
                                                                  </span>
                                                                    <span
                                                                        className={`text-sm flex-1 ${d.owned ? "text-gray-300" : "text-gray-400"}`}>
                                                                        {item}
                                                                      </span>
                                                                    {!d.owned && (
                                                                        <span className="text-xs text-gray-600">
                                                                            {d.farmLoading ? "..." : d.farmExpanded ? "▲" : "▼"}
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {/* Farm locations */}
                                                                {!d.owned && d.farmExpanded && (
                                                                    <div className="mt-1 px-4 pb-3 space-y-1.5">
                                                                        {d.farmLoading && (
                                                                            <p className="text-xs text-gray-500">Loading farm sources...</p>)}
                                                                        {!d.farmLoading && d.farm.length === 0 && (
                                                                            <p className="text-xs text-gray-500">No sources found.</p>)}
                                                                        {!d.farmLoading && d.farm.slice(0, 8).map((farm, idx) => (
                                                                            <div
                                                                                key={idx}
                                                                                className="flex items-start justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2">
                                                                                <div className="min-w-0">
                                                                                  <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                                                                                    {sourceLabel(farm.source)}
                                                                                  </span>
                                                                                    {farm.source === "enemy" ? (
                                                                                        <button
                                                                                            onClick={() => open(wikiUrl(farm.location))}
                                                                                            className="mt-1.5 flex items-center gap-1 text-xs text-purple-300/90 hover:text-purple-300 hover:underline truncate">
                                                                                            {farm.location} ↗
                                                                                        </button>
                                                                                    ) : (
                                                                                        <p className="mt-1.5 text-xs text-gray-200 truncate">{farm.location}</p>
                                                                                    )}
                                                                                    {farm.source === "enemy" && farm.dropTableChance !== undefined && farm.itemChance !== undefined && (
                                                                                        <p className="mt-0.5 text-[10px] text-gray-500">
                                                                                            {farm.dropTableChance.toFixed(2)}%
                                                                                            table
                                                                                            × {farm.itemChance.toFixed(2)}%
                                                                                            item
                                                                                        </p>
                                                                                    )}
                                                                                    {farm.source === "enemy" && (() => {
                                                                                        const nodes = farm.missionNodes;
                                                                                        const planets = farm.planets ?? [];
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
                                                                                    {farm.source !== "enemy" && farm.extra && (
                                                                                        <p className="mt-0.5 text-[11px] text-gray-500">{farm.extra}</p>
                                                                                    )}
                                                                                </div>
                                                                                <div className="text-right shrink-0">
                                                                                    <p className="text-sm font-bold text-purple-400">{farm.chance.toFixed(2)}%</p>
                                                                                    <p className="text-[10px] text-gray-500">
                                                                                        ~{Math.ceil(100 / Math.max(farm.chance, 0.01))} {farm.source === "enemy" ? "kills" : farm.source === "relic" ? "runs" : "runs"}
                                                                                    </p>
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
