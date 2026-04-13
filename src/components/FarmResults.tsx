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
     */
    variant?: "list" | "cards";
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
            ? "flex items-start justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2"
            : "flex items-start justify-between gap-3 px-4 py-3";
        return (
            <div
                key={`${source}-${entry.itemName}-${entry.location}-${index}`}
                className={rowClass}
            >
                <div className="min-w-0">
                    {showItemName && (
                        <p className="text-sm font-medium text-gray-100">{entry.itemName}</p>
                    )}
                    {!showRarityBadge && (
                        <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                            {sourceLabel(entry.source)}
                        </span>
                    )}
                    {isEnemy && showWikiLink ? (
                        <button
                            onClick={() => open(wikiUrl(entry.location))}
                            className={`${showItemName ? "mt-0.5" : "mt-1.5"} flex items-center gap-1 text-xs text-purple-300/90 hover:text-purple-300 hover:underline truncate`}
                        >
                            {entry.location} ↗
                        </button>
                    ) : (
                        <p className={`${showItemName ? "mt-0.5" : "mt-1.5"} text-xs ${showRarityBadge ? "text-purple-300/90" : "text-gray-200"} truncate`}>
                            {entry.location}
                        </p>
                    )}
                    {isEnemy && entry.dropTableChance !== undefined && entry.itemChance !== undefined && (
                        <p className={`mt-0.5 ${compactDetails ? "text-[10px]" : "text-[11px]"} text-gray-500${compactDetails ? " truncate" : ""}`}>
                            {entry.dropTableChance.toFixed(2)}% table × {entry.itemChance.toFixed(2)}% item
                        </p>
                    )}
                    {isEnemy && showMissionNodes && (() => {
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
                        <p className={`mt-0.5 ${showRarityBadge ? "text-xs" : "text-[11px]"} text-gray-500`}>{entry.extra}</p>
                    )}
                </div>
                <div className="shrink-0 text-right">
                    {showRarityBadge && (
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${rarityBadgeClass(entry.rarity)}`}>
                            {entry.rarity || "Unknown"}
                        </span>
                    )}
                    <p className={`${showRarityBadge ? "mt-1.5" : ""} text-sm font-bold text-purple-400`}>
                        {entry.chance.toFixed(2)}%
                    </p>
                    {estimatedRuns !== null && (
                        <p className={`${compactDetails ? "text-[10px]" : "text-[11px]"} text-gray-500`}>
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
                <p className="text-[11px] text-gray-600">
                    Showing the {maxEntries} best sources.
                </p>
            )}
        </>
    ) : (
        <div className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
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
            {expanded && entryList}
        </div>
    );
}
