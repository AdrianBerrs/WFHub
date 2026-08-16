import {useState} from "react";
import {open} from "@tauri-apps/plugin-shell";
import {wikiUrl} from "../lib/wikiUrl";
import {rarityBadgeClass} from "../lib/rarityBadge";
import {sourceLabel} from "../lib/sourceLabel";
import type {FarmResult} from "../lib/modSpecialSources";

const GROUP_META = {
    enemy: {title: "Enemies", icon: "🗡️"},
    mission: {title: "Missions", icon: "🎯"},
    bounty: {title: "Bounties", icon: "🏆"},
    special: {title: "Special", icon: "⭐"},
    relic: {title: "Relics", icon: "💠"},
} as const;

export {GROUP_META};

interface FarmResultsProps {
    source: keyof typeof GROUP_META;
    entries: FarmResult[];
    /** Render a collapsible header for this group. Defaults to false. */
    showHeader?: boolean;
    /** Show the itemName as the first line of each entry. Defaults to true. */
    showItemName?: boolean;
    /** Show a rarity badge (true) or a sourceLabel badge (false). Defaults to true. */
    showRarityBadge?: boolean;
    /** Render enemy location as a clickable wiki link. Defaults to true. */
    showWikiLink?: boolean;
    /** Show missionNodes / planets for enemy entries. Defaults to false. */
    showMissionNodes?: boolean;
    /** Maximum number of entries to show. 0 means no limit. Defaults to 0. */
    maxEntries?: number;
    /** Use text-[10px] for detail lines (Build pages). Defaults to false (text-[11px]). */
    compactDetails?: boolean;
    /**
     * "list": FarmAdvisor/QuickSearch layout — divide-y rows, px-4 py-3
     * "cards": Build pages layout — space-y-1.5 with bordered cards, px-3 py-2
     * "grid": FarmAdvisor 3-column card grid — always fills width
     */
    variant?: "list" | "cards" | "grid";
    /** Max columns in grid variant. Entries fill the row proportionally up to this. Defaults to 5. */
    maxColumns?: number;
}

export function FarmResults({
    source,
    entries,
    showHeader = false,
    showItemName = true,
    showRarityBadge = true,
    showWikiLink = true,
    showMissionNodes = false,
    maxEntries = 0,
    compactDetails = false,
    variant = "list",
    maxColumns = 5,
}: FarmResultsProps) {
    const [collapsed, setCollapsed] = useState(false);

    if (entries.length === 0) return null;

    const meta = GROUP_META[source];
    const isEnemy = source === "enemy";
    const isRelic = source === "relic";
    const expanded = !collapsed;
    const visibleEntries = maxEntries > 0 ? entries.slice(0, maxEntries) : entries;

    function renderEntry(entry: FarmResult, index: number) {
        const estimatedRuns = entry.chance > 0 ? Math.ceil(100 / entry.chance) : null;
        const rowClass = variant === "cards"
            ? "flex items-start justify-between gap-3 rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2 transition-colors hover:border-slate-800"
            : "flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-950/30";
        return (
            <div
                key={`${source}-${entry.itemName}-${entry.location}-${index}`}
                className={rowClass}
            >
                <div className="min-w-0">
                    {showItemName && (
                        <p className="text-sm font-bold text-slate-100">{entry.itemName}</p>
                    )}
                    {!showRarityBadge && (
                        <span className="rounded-full border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-400">
                            {sourceLabel(entry.source)}
                        </span>
                    )}
                    {isEnemy && showWikiLink ? (
                        <button
                            onClick={() => open(wikiUrl(entry.location))}
                            className={`${showItemName ? "mt-0.5" : "mt-1.5"} flex items-center gap-1 truncate text-xs font-semibold text-accents-350/90 hover:text-primary-300 hover:underline`}
                        >
                            {entry.location} ↗
                        </button>
                    ) : (
                        <p className={`${showItemName ? "mt-0.5" : "mt-1.5"} truncate text-xs ${showRarityBadge ? "text-primary-300/90" : "text-slate-200"}`}>
                            {entry.location}
                        </p>
                    )}
                    {isEnemy && entry.dropTableChance !== undefined && entry.itemChance !== undefined && (
                        <p className={`mt-0.5 ${compactDetails ? "text-[10px]" : "text-[11px]"} text-slate-500${compactDetails ? " truncate" : ""}`}>
                            {entry.dropTableChance.toFixed(2)}% table × {entry.itemChance.toFixed(2)}% item
                        </p>
                    )}
                    {isEnemy && showMissionNodes && (() => {
                        const nodes = entry.missionNodes;
                        const planets = entry.planets ?? [];
                        if (nodes && nodes.length > 0) {
                            return (
                                <p className="mt-0.5 text-[10px] text-slate-500">
                                    {nodes.slice(0, 2).map(n => `${n.node} — ${n.planet}`).join(", ")}
                                </p>
                            );
                        }
                        if (planets.length === 0) return null;
                        const shown = planets.slice(0, 3);
                        const extra = planets.length > 3 ? " ..." : "";
                        return (
                            <p className="mt-0.5 text-[10px] text-slate-500">
                                {shown.join(" · ")}{extra}
                            </p>
                        );
                    })()}
                    {!isEnemy && entry.extra && (
                        <p className={`mt-0.5 ${showRarityBadge ? "text-xs" : "text-[11px]"} text-slate-500`}>{entry.extra}</p>
                    )}
                </div>
                <div className="shrink-0 text-right">
                    {showRarityBadge && (
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${rarityBadgeClass(entry.rarity)}`}>
                            {entry.rarity || "Unknown"}
                        </span>
                    )}
                    <p className={`${showRarityBadge ? "mt-1.5" : ""} font-mono text-sm font-black text-primary-400`}>
                        {entry.chance.toFixed(2)}%
                    </p>
                    {estimatedRuns !== null && (
                        <p className={`${compactDetails ? "text-[10px]" : "text-[11px]"} text-slate-500`}>
                            ~{estimatedRuns} {isEnemy ? "kills" : isRelic ? "runs" : "runs"}
                        </p>
                    )}
                </div>
            </div>
        );
    }

    const entryList = variant === "cards" ? (
        <>
            <div className="space-y-1.5">
                {visibleEntries.map((entry, index) => renderEntry(entry, index))}
            </div>
            {maxEntries > 0 && entries.length > maxEntries && (
                <p className="text-[11px] text-slate-600">
                    Showing the {maxEntries} best sources.
                </p>
            )}
        </>
    ) : variant === "grid" ? (
        <>
            <div className="rounded-b-xl border-x border-b border-[#1e1e2d] bg-[#111119] p-4">
                <div className="grid gap-2.5" style={{gridTemplateColumns: `repeat(${Math.min(visibleEntries.length, maxColumns)}, minmax(0, 1fr))`}}>
                {visibleEntries.map((entry, index) => {
                    const estimatedRuns = entry.chance > 0 ? Math.ceil(100 / entry.chance) : null;
                    return (
                    <div key={`${source}-${entry.itemName}-${entry.location}-${index}`}
                         className="flex flex-col gap-2 rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2.5 transition-colors hover:border-slate-800">
                        {showItemName && (
                            <p className="text-xs font-bold text-slate-100">{entry.itemName}</p>
                        )}
                        {!showRarityBadge && (
                            <span className="self-start rounded-full border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-[10px] text-slate-400">
                                {sourceLabel(entry.source)}
                            </span>
                        )}
                        {isEnemy && showWikiLink ? (
                            <button onClick={() => open(wikiUrl(entry.location))}
                                    className="flex items-center gap-1 truncate text-[11px] font-semibold text-accents-350/90 hover:text-primary-300 hover:underline">
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
                        {isEnemy && showMissionNodes && (() => {
                            const nodes = entry.missionNodes;
                            const planets = entry.planets ?? [];
                            if (nodes && nodes.length > 0) {
                                return <p className="text-[10px] text-slate-500">{nodes.slice(0, 2).map(n => `${n.node} — ${n.planet}`).join(", ")}</p>;
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
                            {showRarityBadge && (
                                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${rarityBadgeClass(entry.rarity)}`}>
                                    {entry.rarity || "Unknown"}
                                </span>
                            )}
                            <div className="text-right">
                                <p className="font-mono text-xs font-black text-primary-400">
                                    {entry.chance.toFixed(2)}%
                                </p>
                                {estimatedRuns !== null && (
                                    <p className="text-[10px] text-slate-500">
                                        ~{estimatedRuns} {isEnemy ? "kills" : isRelic ? "runs" : "runs"}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                    );
                })}
            </div>
            </div>
            {maxEntries > 0 && entries.length > maxEntries && (
                <p className="text-[11px] text-slate-600">
                    Showing the {maxEntries} best sources.
                </p>
            )}
        </>
    ) : (
        <div className="overflow-hidden rounded-b-xl border-x border-b border-[#1e1e2d] bg-[#111119] divide-y divide-slate-900/80">
            {visibleEntries.map((entry, index) => renderEntry(entry, index))}
        </div>
    );

    if (!showHeader) {
        return entryList;
    }

    return (
        <div key={source}>
            <button
                onClick={() => setCollapsed((prev) => !prev)}
                className={`flex w-full items-center justify-between border border-[#1e1e2d] bg-[#14141e]/40 px-4 py-3 text-left transition-colors hover:bg-slate-950/80 ${expanded ? "rounded-t-xl" : "rounded-xl"}`}
            >
                <span className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-300">
                    <span>{meta.icon}</span>
                    {meta.title}
                </span>
                <span className="flex items-center gap-2">
                    <span className="rounded border border-cyan-500/10 bg-cyan-950/20 px-2 py-0.5 font-mono text-[10px] font-bold text-cyan-300">
                        {entries.length}
                    </span>
                    <span className="text-xs text-slate-400">{expanded ? "▲" : "▼"}</span>
                </span>
            </button>
            {expanded && entryList}
        </div>
    );
}
