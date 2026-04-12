import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {useNavigate} from "react-router-dom";
import {ChevronRight} from "lucide-react";

interface HubCycle {
    key: string;
    label: string;
    state: string;
    expires_at_ms: number;
}

interface HubAlert {
    id: string;
    title: string;
    tier: string;
    expires_at_ms: number;
}

interface HubInvasion {
    id: string;
    location: string;
    attacker: string;
    defender: string;
    reward: string;
    expires_at_ms: number;
}

interface HubNews {
    id: string;
    title: string;
    url?: string | null;
    published_at_ms: number;
}

interface HubVoidTrader {
    active: boolean;
    location: string;
    starts_at_ms: number;
    ends_at_ms: number;
}

interface HubActivity {
    title: string;
    description: string;
    expires_at_ms: number;
    tier?: string | null;
    boss?: string | null;
    stages?: string[];
}

interface HubSnapshot {
    source: string;
    fetched_at_ms: number;
    worlds: HubCycle[];
    alerts: HubAlert[];
    invasions: HubInvasion[];
    news?: HubNews[];
    arbitration?: HubActivity | null;
    archon_hunt?: HubActivity | null;
    void_trader: HubVoidTrader;
}

interface HubFetchResponse {
    stale: boolean;
    message: string | null;
    refresh_seconds: number;
    snapshot: HubSnapshot;
}

interface HubStateFile {
    refresh_seconds: number;
    last_success_at_ms?: number | null;
    last_snapshot?: HubSnapshot | null;
}

function formatCountdown(targetMs: number, nowMs: number): string {
    const delta = Math.max(0, targetMs - nowMs);
    const totalSeconds = Math.floor(delta / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatSince(timestampMs: number, nowMs: number): string {
    const delta = Math.max(0, nowMs - timestampMs);
    const totalSeconds = Math.floor(delta / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours % 24}h ago`;
    if (hours > 0) return `${hours}h ${minutes}m ago`;
    return `${minutes}m ago`;
}

function newsBadge(title: string): "Hotfix" | "Patch" | null {
    const lower = title.toLowerCase();
    if (lower.includes("hotfix")) return "Hotfix";
    if (lower.includes("patch")) return "Patch";
    return null;
}

function archonDisplay(activity: HubActivity): { boss: string; stages: string[] } {
    const explicitStages = activity.stages ?? [];
    if (explicitStages.length > 0) {
        return {
            boss: activity.boss ?? "Archon",
            stages: explicitStages,
        };
    }

    const raw = activity.description.trim();
    if (!raw) {
        return {boss: activity.boss ?? "Archon", stages: []};
    }

    const firstSep = raw.indexOf(" - ");
    if (firstSep === -1) {
        return {boss: activity.boss ?? raw, stages: []};
    }

    const parsedBoss = raw.slice(0, firstSep).trim();
    const rest = raw.slice(firstSep + 3).trim();
    const stages = rest.split("|").map((s) => s.trim()).filter(Boolean);
    return {
        boss: activity.boss ?? parsedBoss,
        stages,
    };
}

function archonVisual(boss: string): string {
    if (boss === "Boreal") return "❄️";
    if (boss === "Amar") return "🔥";
    if (boss === "Nira") return "⚡️";
    return "•";
}

const tierStyles: Record<string, { bg: string; text: string; border: string }> = {
    "S TIER": {bg: "bg-purple-500/20", text: "text-purple-300", border: "border-purple-500/40"},
    "A TIER": {bg: "bg-emerald-500/20", text: "text-emerald-300", border: "border-emerald-500/40"},
    "B TIER": {bg: "bg-yellow-500/20", text: "text-yellow-300", border: "border-yellow-500/40"},
    "C TIER": {bg: "bg-amber-500/20", text: "text-amber-300", border: "border-amber-500/40"},
    "D TIER": {bg: "bg-orange-500/20", text: "text-orange-300", border: "border-orange-500/40"},
    "F TIER": {bg: "bg-red-500/20", text: "text-red-300", border: "border-red-500/40"},
};

function archonTheme(boss: string): {
    card: string;
    title: string;
    status: string;
    timer: string;
    stage: string;
    stageIndex: string;
} {
    if (boss === "Boreal") {
        return {
            card: "border-sky-900/60 bg-gradient-to-b from-gray-900 to-sky-950/25",
            title: "text-sky-300",
            status: "border-sky-500/40 bg-sky-500/10 text-sky-300",
            timer: "bg-sky-500/15 text-sky-300",
            stage: "border-sky-900/60 bg-gray-950/60",
            stageIndex: "bg-sky-500/20 text-sky-200",
        };
    }
    if (boss === "Amar") {
        return {
            card: "border-amber-900/60 bg-gradient-to-b from-gray-900 to-amber-950/20",
            title: "text-amber-300",
            status: "border-amber-500/40 bg-amber-500/10 text-amber-300",
            timer: "bg-amber-500/15 text-amber-300",
            stage: "border-amber-900/60 bg-gray-950/60",
            stageIndex: "bg-amber-500/20 text-amber-200",
        };
    }
    if (boss === "Nira") {
        return {
            card: "border-violet-900/60 bg-gradient-to-b from-gray-900 to-violet-950/20",
            title: "text-violet-300",
            status: "border-violet-500/40 bg-violet-500/10 text-violet-300",
            timer: "bg-violet-500/15 text-violet-300",
            stage: "border-violet-900/60 bg-gray-950/60",
            stageIndex: "bg-violet-500/20 text-violet-200",
        };
    }

    return {
        card: "border-gray-800 bg-gray-900",
        title: "text-gray-100",
        status: "border-gray-700 bg-gray-800/60 text-gray-300",
        timer: "bg-gray-800 text-gray-300",
        stage: "border-gray-800 bg-gray-950/70",
        stageIndex: "bg-gray-800 text-gray-300",
    };
}

function SmallBadge({label}: { label: string }) {
    return (
        <span className="rounded-md border border-gray-700 bg-gray-800/80 px-2 py-0.5 text-[11px] text-gray-300">
      {label}
    </span>
    );
}

function worldVisual(world: HubCycle): string {
    if (world.key === "cetus") return world.state === "Night" ? "🌙" : "☀️";
    if (world.key === "fortuna") return world.state === "Cold" ? "❄️" : "☀️";
    if (world.key === "cambion") return world.state === "Vome" ? "🌙" : "☀️";
    if (world.key === "duviri") {
        const mood = world.state.toLowerCase();
        if (mood.includes("joy")) return "😀";
        if (mood.includes("anger")) return "😠";
        if (mood.includes("envy")) return "😒";
        if (mood.includes("fear")) return "😨";
        return "😔";
    }
    if (world.key === "zariman") return "🛰️";
    if (world.key === "daily-reset") return "⟳";
    return "•";
}

function worldLabel(world: HubCycle): string {
    if (world.key === "cetus") return "Cetus/Earth";
    if (world.key === "fortuna") return "Vallis";
    if (world.key === "cambion") return "Cambion";
    if (world.key === "duviri") return "Duviri";
    if (world.key === "zariman") return "Zariman Ten Zero";
    if (world.key === "daily-reset") return "Daily Reset";
    return world.label;
}

function sanitizeArbitrationDescription(description: string, tier?: string | null): string {
    const cleaned = description.trim();
    if (!tier) return cleaned;
    const suffix = ` (${tier})`;
    return cleaned.endsWith(suffix) ? cleaned.slice(0, -suffix.length) : cleaned;
}

export default function HubPage() {
    const navigate = useNavigate();
    const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
    const [refreshSeconds, setRefreshSeconds] = useState(60);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [staleMessage, setStaleMessage] = useState<string | null>(null);
    const [nowMs, setNowMs] = useState(Date.now());

    async function refreshData() {
        setRefreshing(true);
        setError(null);
        try {
            const raw = await invoke<string>("fetch_hub_worldstate");
            const parsed: HubFetchResponse = JSON.parse(raw);
            setSnapshot(parsed.snapshot);
            setRefreshSeconds(parsed.refresh_seconds);
            setStaleMessage(parsed.stale ? (parsed.message ?? "Cached data.") : null);
        } catch (e) {
            setError(String(e));
        } finally {
            setRefreshing(false);
            setLoading(false);
        }
    }

    useEffect(() => {
        let cancelled = false;
        invoke<string>("read_hub_state")
            .then((raw) => {
                if (cancelled) return;
                const parsed: HubStateFile = JSON.parse(raw);
                setRefreshSeconds(parsed.refresh_seconds ?? 60);
                if (parsed.last_snapshot) {
                    setSnapshot(parsed.last_snapshot);
                }
            })
            .catch(() => {
            })
            .finally(() => {
                if (!cancelled) {
                    refreshData();
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        const timer = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!refreshSeconds || refreshSeconds < 15) return;
        const timer = setInterval(() => {
            refreshData();
        }, refreshSeconds * 1000);
        return () => clearInterval(timer);
    }, [refreshSeconds]);

    const orderedWorlds = useMemo(() => {
        const order = ["cetus", "fortuna", "cambion", "duviri", "zariman", "daily-reset"];
        if (!snapshot) return [] as HubCycle[];
        return [...snapshot.worlds].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }, [snapshot]);

    const newsItems = snapshot?.news ?? [];

    async function openNews(item: HubNews) {
        const url = item.url ?? "https://browse.wf/live";
        await open(url).catch(() => {
        });
    }

    return (
        <div className="flex h-full flex-col gap-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">

                <div className="space-y-2">
                    <h1 className="text-lg font-bold text-purple-400">Hub</h1>
                    <p className="mt-1 text-sm text-gray-500">
                        Real-time monitoring of warframe activities.
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    {snapshot && <SmallBadge label={`Source: ${snapshot.source}`}/>}
                    <SmallBadge label={`Refresh: ${refreshSeconds}s`}/>
                    <button
                        onClick={() => refreshData()}
                        disabled={refreshing}
                        className="rounded-lg border bg-purple-500/20 text-purple-400 border-purple-500/40 px-3 py-2 text-xs font-medium hover:bg-purple-500/20 disabled:opacity-50"
                    >
                        {refreshing ? "Updating..." : "Refresh now"}
                    </button>
                </div>
            </div>

            {staleMessage && (
                <div
                    className="rounded-lg border border-yellow-700/40 bg-yellow-900/10 px-3 py-2 text-xs text-yellow-300">
                    Showing last saved snapshot ({staleMessage}).
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
                    {error}
                </div>
            )}

            {loading && !snapshot && (
                <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-400">
                    Loading worldstate...
                </div>
            )}

            {snapshot && (
                <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">

                    {/*OPEN WORLDS*/}
                    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                        <h2 className="text-sm font-semibold text-gray-100">🌍 Open Worlds</h2>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
                            {orderedWorlds.map((world) => (
                                <div
                                    key={world.key}
                                    className="rounded-lg border border-gray-800 bg-gray-950/80 px-3 py-2.5 text-center">
                                    <p className="text-xs text-gray-300">{worldLabel(world)}</p>
                                    <p className="mt-1 text-3xl leading-none">{worldVisual(world)}</p>
                                    <p className="mt-1 text-sm font-medium text-gray-100">{world.state}</p>
                                    <p className="mt-1 text-[11px] text-gray-400">Time remaining</p>
                                    <span
                                        className="mt-1 inline-flex rounded-md border border-purple-500/40 bg-purple-500/10 text-purple-300 px-2 py-0.5 text-[11px] font-semibold">
                                        Expires: {formatCountdown(world.expires_at_ms, nowMs)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/*VOID TRADER + ARBITRATION (left) / ARCHON HUNT (right)*/}
                    <div className="grid gap-4 lg:grid-cols-2">

                        {/*VOID TRADER + ARBITRATION*/}
                        <div className="flex flex-col gap-4 lg:min-h-65">

                            {/*VOID TRADER*/}
                            <section
                                className={`h-full rounded-xl border p-4 transition-colors duration-150 hover:border-gray-700 bg-gray-900 ${snapshot.void_trader.active ? "border-blue-900/80" : "border-gray-800"}`}>
                                <div className="flex items-center justify-between gap-2">
                                    <h2 className="text-sm font-semibold text-gray-100">🌀 Void Trader</h2>
                                    <button
                                        type="button"
                                        onClick={() => navigate("/hub/void-trader")}
                                        disabled={!snapshot.void_trader.active}
                                        title={snapshot.void_trader.active ? "View Void Trader items" : "Available when Baro is active"}
                                        className="flex items-center justify-center rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronRight size={16}/>
                                    </button>
                                </div>
                                <p className="mt-2 text-sm text-gray-300">
                                    {snapshot.void_trader.active
                                        ? `Active at ${snapshot.void_trader.location}`
                                        : `Arriving at ${snapshot.void_trader.location}`}
                                </p>
                                <p className="mt-1 text-xs text-gray-400">
                                    {snapshot.void_trader.active
                                        ? `Leaves in ${formatCountdown(snapshot.void_trader.ends_at_ms, nowMs)}`
                                        : `Arrives in ${formatCountdown(snapshot.void_trader.starts_at_ms, nowMs)}`}
                                </p>
                            </section>

                            {/*ARBITRATION*/}
                            <section
                                className={`h-full rounded-xl border p-4 transition-colors duration-150 hover:border-gray-700 bg-gray-900 ${snapshot.arbitration?.tier && tierStyles[snapshot.arbitration.tier] ? `${tierStyles[snapshot.arbitration.tier].border}` : "border-gray-800"}`}>
                                <div className="flex items-center justify-between gap-2">
                                    <h2 className="text-sm font-semibold text-gray-100">⛩️ Arbitration</h2>
                                    <button
                                        type="button"
                                        onClick={() => navigate("/hub/arbitrations")}
                                        title="View upcoming arbitrations"
                                        className="flex items-center justify-center rounded-lg p-2 text-gray-400 transition hover:bg-gray-800 hover:text-white disabled:opacity-30">
                                        <ChevronRight size={16}/>
                                    </button>
                                </div>
                                {snapshot.arbitration ? (
                                    <>
                                        <p className="mt-2 flex items-center gap-2 text-sm text-gray-300">
                                            <span className="truncate">
                                                {sanitizeArbitrationDescription(snapshot.arbitration.description, snapshot.arbitration.tier)}
                                            </span>
                                            {snapshot.arbitration.tier && (
                                                <span
                                                    className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
                                                        tierStyles[snapshot.arbitration.tier]
                                                            ? `${tierStyles[snapshot.arbitration.tier].border} ${tierStyles[snapshot.arbitration.tier].bg} ${tierStyles[snapshot.arbitration.tier].text}`
                                                            : "bg-gray-700 text-gray-300 border-gray-600"
                                                    }`}
                                                >
                                                {snapshot.arbitration.tier}
                                              </span>
                                            )}
                                        </p>
                                        <p className="mt-1 text-xs text-gray-400">
                                            Updates in {formatCountdown(snapshot.arbitration.expires_at_ms, nowMs)}
                                        </p>
                                    </>
                                ) : (
                                    <p className="mt-2 text-sm text-gray-500">No arbitration data at the moment.</p>
                                )}
                            </section>

                        </div>

                        {/*ARCHON HUNT*/}
                        <section
                            className={`h-full rounded-xl border p-4 transition-colors duration-150 hover:border-gray-700 ${snapshot.archon_hunt ? archonTheme(archonDisplay(snapshot.archon_hunt).boss).card : "border-gray-800 bg-gray-900"}`}>
                            {snapshot.archon_hunt ? (
                                (() => {
                                    const info = archonDisplay(snapshot.archon_hunt);
                                    const theme = archonTheme(info.boss);
                                    return (
                                        <>
                                            <div className="flex items-start justify-between gap-2">
                                                <h2 className="text-sm font-semibold text-gray-100">🎯 Archon Hunt</h2>
                                                <span
                                                    className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${theme.status}`}>
                                                    Active
                                                </span>
                                            </div>

                                            <p className={`mt-4 text-lg font-semibold ${theme.title}`}>
                                                {archonVisual(info.boss)} {info.boss}
                                            </p>
                                            <div className="mt-3">
                                                <span
                                                    className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${theme.timer}`}>
                                                    Expires in {formatCountdown(snapshot.archon_hunt.expires_at_ms, nowMs)}
                                                </span>
                                            </div>

                                            <div className="mt-4 space-y-2">
                                                {info.stages.length > 0 ? (
                                                    info.stages.map((stage, idx) => (
                                                        <div
                                                            key={`${stage}-${idx}`}
                                                            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${theme.stage}`}>
                                                            <span
                                                                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${theme.stageIndex}`}>
                                                                {idx + 1}
                                                            </span>
                                                            <p className="mt-1 text-xs text-gray-300">{stage}</p>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <p className="text-xs text-gray-400">No detailed stages at the moment.</p>
                                                )}
                                            </div>
                                        </>
                                    );
                                })()
                            ) : (
                                <>
                                    <h2 className="text-sm font-semibold text-gray-100">🎯 Archon Hunt</h2>
                                    <p className="mt-2 text-sm text-gray-500">No active archon hunt at the moment.</p>
                                </>
                            )}
                        </section>

                    </div>

                    {/*INVASOES-NEWS*/}
                    <div className="grid gap-4 lg:grid-cols-2">

                        {/*INVASOES*/}
                        <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                            <h2 className="text-sm font-semibold text-gray-100">💥 Invasions</h2>
                            {snapshot.invasions.length === 0 ? (
                                <p className="mt-2 text-sm text-gray-500">No active invasions.</p>
                            ) : (
                                <div className="mt-3 max-h-140 space-y-2 overflow-auto pr-1">
                                    {snapshot.invasions.map((invasion) => (
                                        <div key={invasion.id}
                                             className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                                            <p className="text-sm text-gray-200">{invasion.location}</p>
                                            <p className="mt-0.5 text-xs text-gray-400">
                                                {invasion.attacker} vs {invasion.defender} -
                                                reward: {invasion.reward}
                                            </p>
                                            <p className="mt-0.5 text-[11px] text-gray-500">
                                                Updates in {formatCountdown(invasion.expires_at_ms, nowMs)}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        {/*NEWS*/}
                        <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                            <h2 className="text-sm font-semibold text-gray-100">📰 News</h2>
                            {newsItems.length === 0 ? (
                                <p className="mt-2 text-sm text-gray-500">No news at the moment.</p>
                            ) : (
                                <div className="mt-3 max-h-140 space-y-2 overflow-auto pr-1">
                                    {newsItems.map((item) => (
                                        <button
                                            key={item.id}
                                            onClick={() => openNews(item)}
                                            className="w-full rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2 text-left hover:border-gray-700"
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="line-clamp-2 text-sm text-gray-200">{item.title}</p>
                                                {newsBadge(item.title) && (
                                                    <span
                                                        className="shrink-0 rounded-md border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                            {newsBadge(item.title)}
                          </span>
                                                )}
                                            </div>
                                            <p className="mt-0.5 text-[11px] text-gray-500">{formatSince(item.published_at_ms, nowMs)}</p>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>

                    </div>

                    {/*ALERTAS*/}
                    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                        <h2 className="text-sm font-semibold text-gray-100">📢 Alerts</h2>
                        {snapshot.alerts.length === 0 ? (
                            <p className="mt-2 text-sm text-gray-500">No active alerts.</p>
                        ) : (
                            <div className="mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                                {snapshot.alerts.map((alert) => (
                                    <div key={alert.id}
                                         className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                                        <p className="text-sm text-gray-200">{alert.title}</p>
                                        <p className="mt-0.5 text-[11px] text-gray-500">
                                            Expires in {formatCountdown(alert.expires_at_ms, nowMs)}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}






