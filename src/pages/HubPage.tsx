import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {useNavigate} from "react-router-dom";
import {
    Award,
    ChevronRight,
    Clock,
    Compass,
    Flame,
    Gamepad2,
    Moon,
    Newspaper,
    RefreshCw,
    Shield,
    Snowflake,
    Sparkles,
    Sun,
    Swords,
    Zap,
} from "lucide-react";

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
    attacker_reward?: string;
    defender_reward?: string;
    expires_at_ms: number;
    completion_pct?: number;
    count?: number;
    required_runs?: number;
    completed?: boolean;
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

interface HubArbitrationSlot {
    start_at_ms: number;
    end_at_ms: number;
    description: string;
    tier?: string | null;
}

interface HubSortieMission {
    mission_type: string;
    node: string;
    modifier: string;
}

interface HubSortie {
    boss: string;
    faction: string;
    expires_at_ms: number;
    missions: HubSortieMission[];
}

interface HubSnapshot {
    source: string;
    fetched_at_ms: number;
    worlds: HubCycle[];
    alerts: HubAlert[];
    invasions: HubInvasion[];
    news?: HubNews[];
    arbitration?: HubActivity | null;
    sortie?: HubSortie | null;
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

const tierStyles: Record<string, { bg: string; text: string; border: string }> = {
    "S TIER": {bg: "bg-primary-500/20", text: "text-primary-300", border: "border-primary-500/40"},
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
            card: "border-sky-900/60 bg-gradient-to-b from-zinc-900 to-sky-950/25",
            title: "text-sky-300",
            status: "border-sky-500/40 bg-sky-500/10 text-sky-300",
            timer: "bg-sky-500/15 text-sky-300",
            stage: "border-sky-900/60 bg-zinc-950/60",
            stageIndex: "bg-sky-500/20 text-sky-200",
        };
    }
    if (boss === "Amar") {
        return {
            card: "border-amber-900/60 bg-gradient-to-b from-zinc-900 to-amber-950/20",
            title: "text-amber-300",
            status: "border-amber-500/40 bg-amber-500/10 text-amber-300",
            timer: "bg-amber-500/15 text-amber-300",
            stage: "border-amber-900/60 bg-zinc-950/60",
            stageIndex: "bg-amber-500/20 text-amber-200",
        };
    }
    if (boss === "Nira") {
        return {
            card: "border-violet-900/60 bg-gradient-to-b from-zinc-900 to-violet-950/20",
            title: "text-violet-300",
            status: "border-violet-500/40 bg-violet-500/10 text-violet-300",
            timer: "bg-violet-500/15 text-violet-300",
            stage: "border-violet-900/60 bg-zinc-950/60",
            stageIndex: "bg-violet-500/20 text-violet-200",
        };
    }

    return {
        card: "border-zinc-800 bg-zinc-900",
        title: "text-zinc-100",
        status: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
        timer: "bg-zinc-800 text-zinc-300",
        stage: "border-zinc-800 bg-zinc-950/70",
        stageIndex: "bg-zinc-800 text-zinc-300",
    };
}

function factionColors(faction: string): { badge: string; accent: string; icon: string; timer: string; stage: string; stageIndex: string } {
    const f = faction.toLowerCase();
    if (f.includes("grineer")) return {
        badge: "border-red-500/40 bg-red-500/10 text-red-300",
        accent: "border-red-900/60 bg-gradient-to-b from-zinc-900 to-red-950/20",
        icon: "text-red-400",
        timer: "bg-red-500/15 text-red-300",
        stage: "border-red-900/40 bg-zinc-950/60",
        stageIndex: "bg-red-500/20 text-red-200",
    };
    if (f.includes("corpus")) return {
        badge: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
        accent: "border-cyan-900/60 bg-gradient-to-b from-zinc-900 to-cyan-950/20",
        icon: "text-cyan-400",
        timer: "bg-cyan-500/15 text-cyan-300",
        stage: "border-cyan-900/40 bg-zinc-950/60",
        stageIndex: "bg-cyan-500/20 text-cyan-200",
    };
    if (f.includes("infest")) return {
        badge: "border-green-500/40 bg-green-500/10 text-green-300",
        accent: "border-green-900/60 bg-gradient-to-b from-zinc-900 to-green-950/20",
        icon: "text-green-400",
        timer: "bg-green-500/15 text-green-300",
        stage: "border-green-900/40 bg-zinc-950/60",
        stageIndex: "bg-green-500/20 text-green-200",
    };
    return {
        badge: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
        accent: "border-zinc-800 bg-zinc-900",
        icon: "text-zinc-400",
        timer: "bg-zinc-800 text-zinc-300",
        stage: "border-zinc-800 bg-zinc-950/70",
        stageIndex: "bg-zinc-800 text-zinc-300",
    };
}

function SmallBadge({label}: { label: string }) {
    return (
        <span className="rounded border border-slate-800 bg-slate-900 px-2.5 py-1.5 font-mono text-[10px] text-slate-400">
      {label}
    </span>
    );
}

function worldVisual(world: HubCycle) {
    const state = world.state.toLowerCase();
    if (world.key === "cetus") {
        return state.includes("night")
            ? <Moon size={24} className="text-amber-400" />
            : <Sun size={24} className="text-yellow-400" />;
    }
    if (world.key === "fortuna") {
        return state.includes("cold")
            ? <Snowflake size={24} className="text-cyan-400" />
            : <Sun size={24} className="text-orange-400" />;
    }
    if (world.key === "cambion") {
        return state.includes("vome")
            ? <Moon size={24} className="text-purple-400" />
            : <Sun size={24} className="text-rose-400" />;
    }
    if (world.key === "duviri") return <Sparkles size={24} className="text-purple-400" />;
    if (world.key === "zariman") return <Compass size={24} className="text-emerald-400" />;
    if (world.key === "daily-reset") return <RefreshCw size={24} className="text-blue-400" />;
    return <Compass size={24} className="text-slate-400" />;
}

function worldAccentBg(world: HubCycle): string {
    const state = world.state.toLowerCase();
    if (world.key === "cetus") {
        return state.includes("night")
            ? "from-amber-950/20 to-transparent border-amber-500/20"
            : "from-yellow-950/20 to-transparent border-yellow-500/20";
    }
    if (world.key === "fortuna") {
        return state.includes("cold")
            ? "from-cyan-950/20 to-transparent border-cyan-500/20"
            : "from-orange-950/20 to-transparent border-orange-500/20";
    }
    if (world.key === "cambion") {
        return state.includes("vome")
            ? "from-purple-950/20 to-transparent border-purple-500/20"
            : "from-rose-950/20 to-transparent border-rose-500/20";
    }
    if (world.key === "duviri") return "from-purple-950/20 to-transparent border-purple-500/20";
    if (world.key === "zariman") return "from-emerald-950/20 to-transparent border-emerald-500/20";
    if (world.key === "daily-reset") return "from-blue-950/20 to-transparent border-blue-500/20";
    return "from-slate-950/20 to-transparent border-slate-500/20";
}

function worldStatusColor(world: HubCycle): string {
    const state = world.state.toLowerCase();
    if (world.key === "cetus") return state.includes("night") ? "text-amber-400" : "text-yellow-400";
    if (world.key === "fortuna") return state.includes("cold") ? "text-cyan-400" : "text-orange-400";
    if (world.key === "cambion") return state.includes("vome") ? "text-purple-400" : "text-rose-400";
    if (world.key === "duviri") return "text-purple-400";
    if (world.key === "zariman") return "text-emerald-400";
    if (world.key === "daily-reset") return "text-blue-400";
    return "text-slate-400";
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
    const [upcomingArbs, setUpcomingArbs] = useState<HubArbitrationSlot[]>([]);

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

    useEffect(() => {
        invoke<string>("fetch_hub_arbitrations_next_days", {days: 1})
            .then((raw) => {
                const parsed = JSON.parse(raw);
                const sorted: HubArbitrationSlot[] = (parsed.slots ?? []).slice().sort(
                    (a: HubArbitrationSlot, b: HubArbitrationSlot) => a.start_at_ms - b.start_at_ms
                );
                setUpcomingArbs(sorted);
            })
            .catch(() => {});
    }, []);

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
        <div className="wf-page space-y-6">
            <div className="wf-panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">

                <div>
                    <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                        <span className="wf-status-dot" />
                        Real-Time Activities
                    </h1>
                    <p className="mt-1 text-xs text-slate-400">
                        Live monitoring for Warframe world cycles, rotations and alerts.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {snapshot && <SmallBadge label={`Source: ${snapshot.source}`}/>}
                    <SmallBadge label={`Refresh: ${refreshSeconds}s`}/>
                    <button
                        onClick={() => refreshData()}
                        disabled={refreshing}
                        className="flex items-center gap-2 rounded border border-cyan-500/30 bg-[#1d1233] px-4 py-1.5 text-xs font-bold text-cyan-400 transition-colors hover:bg-[#2c1354] disabled:opacity-50"
                    >
                        <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
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
                <div className="rounded-lg border border-[#1e1e2d] bg-[#111119] px-3 py-2 text-sm text-slate-400">
                    Loading worldstate...
                </div>
            )}

            {snapshot && (
                <div className="min-h-0 flex-1 space-y-5">

                    {/*OPEN WORLDS*/}
                    <section>
                        <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400">
                            <Gamepad2 size={14} className="text-cyan-400" />
                            Open Worlds & Rotations
                        </h2>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                            {orderedWorlds.map((world) => (
                                <div
                                    key={world.key}
                                    className={`bg-gradient-to-b ${worldAccentBg(world)} bg-[#111119]/80 rounded-xl p-4 border flex min-h-40 flex-col justify-between items-center text-center transition-all duration-200 hover:scale-[1.02] shadow-[0_4px_12px_rgba(0,0,0,0.5)]`}
                                >
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                                        {worldLabel(world)}
                                    </span>
                                    <div className="my-4 flex flex-col items-center gap-2">
                                        <div className="p-2.5 rounded-full bg-slate-950/80 border border-slate-800/80 shadow-inner">
                                            {worldVisual(world)}
                                        </div>
                                        <span className={`text-base font-black ${worldStatusColor(world)} font-mono tracking-wide`}>
                                            {world.state}
                                        </span>
                                    </div>
                                    <span className="text-[10px] font-mono font-bold bg-slate-950/80 py-1 px-2 rounded border border-slate-800/80 text-slate-300">
                                        Expires: {formatCountdown(world.expires_at_ms, nowMs)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>

                    {/*VOID TRADER + ARBITRATION + SORTIE + ARCHON HUNT*/}
                    <div className="grid gap-4 lg:grid-cols-4">

                        {/*VOID TRADER*/}
                        <section
                            className={`group relative flex h-full flex-col justify-between overflow-hidden rounded-xl border bg-[#111119] p-4 shadow-lg transition-all duration-200 hover:scale-[1.01] ${snapshot.void_trader.active ? "border-primary-900/80" : "border-[#1e1e2d]"}`}>
                            <div className="pointer-events-none absolute right-0 top-0 h-20 w-20 rounded-bl-full bg-gradient-to-bl from-purple-500/10 to-transparent" />
                            <div>
                                <div className="flex items-center justify-between gap-2">
                                    <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-purple-400">
                                        <Shield size={14} />
                                        Void Trader
                                    </h2>
                                </div>
                                <p className="mt-3 text-sm font-black tracking-tight text-slate-100">
                                    {snapshot.void_trader.active
                                        ? `Active at ${snapshot.void_trader.location}`
                                        : `Arriving at ${snapshot.void_trader.location}`}
                                </p>
                                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                                    <Clock size={12} className="text-purple-400" />
                                    {snapshot.void_trader.active
                                        ? `Leaves in ${formatCountdown(snapshot.void_trader.ends_at_ms, nowMs)}`
                                        : `Arrives in ${formatCountdown(snapshot.void_trader.starts_at_ms, nowMs)}`}
                                </p>
                            </div>

                            <div className="mt-4 flex justify-end border-t border-slate-900 pt-3">
                                <button
                                    type="button"
                                    onClick={() => navigate("/hub/void-trader")}
                                    title={snapshot.void_trader.active ? "See full catalog" : "See last catalog"}
                                    className="ml-auto flex w-fit origin-right scale-80 cursor-pointer items-center gap-1 text-base font-medium leading-none text-purple-400 transition hover:text-purple-300 group-hover:translate-x-0.5"
                                >
                                    {snapshot.void_trader.active ? "See full catalog" : "See last catalog"} <ChevronRight size={10} strokeWidth={1.75} />
                                </button>
                            </div>
                        </section>

                        {/*ARBITRATION*/}
                        <section
                            className={`group relative flex h-full flex-col justify-between overflow-hidden rounded-xl border bg-[#111119] p-4 shadow-lg transition-all duration-200 hover:scale-[1.01] ${snapshot.arbitration?.tier && tierStyles[snapshot.arbitration.tier] ? `${tierStyles[snapshot.arbitration.tier].border}` : "border-[#1e1e2d]"}`}>
                            <div className="pointer-events-none absolute right-0 top-0 h-20 w-20 rounded-bl-full bg-gradient-to-bl from-amber-500/10 to-transparent" />
                            <div>
                                <div className="flex items-start justify-between gap-2">
                                    <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-amber-500">
                                        <Award size={14} />
                                        Arbitration
                                    </h2>
                                    {snapshot.arbitration?.tier && (
                                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${
                                            tierStyles[snapshot.arbitration.tier]
                                                ? `${tierStyles[snapshot.arbitration.tier].border} ${tierStyles[snapshot.arbitration.tier].bg} ${tierStyles[snapshot.arbitration.tier].text}`
                                                : "border-zinc-600 bg-zinc-700 text-zinc-300"
                                        }`}>
                                            {snapshot.arbitration.tier}
                                        </span>
                                    )}
                                </div>
                                {snapshot.arbitration ? (
                                    <>
                                        <p className="mt-3 text-sm font-black tracking-tight text-slate-100">
                                            {sanitizeArbitrationDescription(snapshot.arbitration.description, snapshot.arbitration.tier)}
                                        </p>
                                        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                                            <Clock size={12} className="text-amber-500" />
                                            Updates in {formatCountdown(snapshot.arbitration.expires_at_ms, nowMs)}
                                        </p>
                                        {upcomingArbs.filter((s) => s.start_at_ms >= snapshot.arbitration!.expires_at_ms).slice(0, 3).length > 0 && (
                                            <div className="mt-3 space-y-2">
                                                {upcomingArbs.filter((s) => s.start_at_ms >= snapshot.arbitration!.expires_at_ms).slice(0, 3).map((slot, idx) => (
                                                    <div key={slot.start_at_ms} className="flex items-center gap-2 rounded-lg border border-amber-900/30 bg-zinc-950/60 px-2.5 py-2">
                                                        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[11px] font-semibold text-amber-300">
                                                            {idx + 1}
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="truncate text-xs font-semibold text-zinc-200">
                                                                {sanitizeArbitrationDescription(slot.description, slot.tier)}
                                                            </p>
                                                            <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                                                                In {formatCountdown(slot.start_at_ms, nowMs)}
                                                            </p>
                                                        </div>
                                                        {slot.tier && (
                                                            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold ${
                                                                tierStyles[slot.tier]
                                                                    ? `${tierStyles[slot.tier].border} ${tierStyles[slot.tier].bg} ${tierStyles[slot.tier].text}`
                                                                    : "border-zinc-700 bg-zinc-800 text-zinc-400"
                                                            }`}>
                                                                {slot.tier}
                                                            </span>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <p className="mt-2 text-xs text-slate-500">No arbitration data at the moment.</p>
                                )}
                            </div>

                            <div className="mt-4 flex justify-end border-t border-slate-900 pt-3">
                                <button
                                    type="button"
                                    onClick={() => navigate("/hub/arbitrations")}
                                    title="See next arbitrations"
                                    className="ml-auto flex w-fit origin-right scale-80 cursor-pointer items-center gap-1 text-base font-medium leading-none text-amber-500 transition hover:text-amber-400 group-hover:translate-x-0.5"
                                >
                                    See next arbitrations <ChevronRight size={10} strokeWidth={1.75} />
                                </button>
                            </div>
                        </section>


                        {/*SORTIE*/}
                        {(() => {
                            const sortie = snapshot.sortie;
                            if (!sortie) {
                                return (
                                    <section className="rounded-xl border border-[#1e1e2d] bg-[#111119] p-4 shadow-lg">
                                        <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-orange-400">
                                            <Swords size={14} />
                                            Sortie
                                        </h2>
                                        <p className="mt-2 text-xs text-slate-500">No sortie data at the moment.</p>
                                    </section>
                                );
                            }
                            const fc = factionColors(sortie.faction);
                            return (
                                <section className={`rounded-xl border p-4 shadow-lg transition-all duration-200 hover:scale-[1.01] ${fc.accent}`}>
                                    <div className="flex items-start justify-between gap-2">
                                        <h2 className={`flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest ${fc.icon}`}>
                                            <Swords size={14} />
                                            Sortie
                                        </h2>
                                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${fc.badge}`}>
                                            {sortie.faction}
                                        </span>
                                    </div>

                                    <p className="mt-3 text-sm font-black tracking-tight text-slate-100">
                                        {sortie.boss}
                                    </p>

                                    <div className="mt-2">
                                        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${fc.timer}`}>
                                            <Clock size={12} />
                                            Resets in {formatCountdown(sortie.expires_at_ms, nowMs)}
                                        </span>
                                    </div>

                                    <div className="mt-4 space-y-2">
                                        {sortie.missions.length > 0 ? (
                                            sortie.missions.map((mission, idx) => (
                                                <div
                                                    key={idx}
                                                    className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${fc.stage}`}>
                                                    <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${fc.stageIndex}`}>
                                                        {idx + 1}
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-semibold text-zinc-200">{mission.mission_type} — {mission.node}</p>
                                                        <p className="mt-0.5 font-mono text-[10px] text-zinc-500">{mission.modifier}</p>
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-xs text-zinc-400">No mission details available.</p>
                                        )}
                                    </div>
                                </section>
                            );
                        })()}

                        {/*ARCHON HUNT*/}
                        <section
                            className={`h-full rounded-xl border p-4 shadow-lg transition-all duration-200 hover:scale-[1.01] ${snapshot.archon_hunt ? archonTheme(archonDisplay(snapshot.archon_hunt).boss).card : "border-[#1e1e2d] bg-[#111119]"}`}>
                            {snapshot.archon_hunt ? (
                                (() => {
                                    const info = archonDisplay(snapshot.archon_hunt);
                                    const theme = archonTheme(info.boss);
                                    return (
                                        <>
                                            <div className="flex items-start justify-between gap-2">
                                                <h2 className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-widest text-red-500">
                                                    <Flame size={14} />
                                                    Archon Hunt
                                                </h2>
                                                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${theme.status}`}>
                                                    Active
                                                </span>
                                            </div>

                                            <p className={`mt-3 text-sm font-black tracking-tight ${theme.title}`}>
                                                Hunting: Archon {info.boss}
                                            </p>
                                            <div className="mt-2">
                                                <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${theme.timer}`}>
                                                    <Clock size={12} />
                                                    Expires in {formatCountdown(snapshot.archon_hunt.expires_at_ms, nowMs)}
                                                </span>
                                            </div>

                                            <div className="mt-4 space-y-2">
                                                {info.stages.length > 0 ? (
                                                    info.stages.map((stage, idx) => (
                                                        <div
                                                            key={`${stage}-${idx}`}
                                                            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${theme.stage}`}>
                                                            <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${theme.stageIndex}`}>
                                                                {idx + 1}
                                                            </span>
                                                            <p className="mt-1 text-xs text-zinc-300">{stage}</p>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <p className="text-xs text-zinc-400">No detailed stages at the moment.</p>
                                                )}
                                            </div>
                                        </>
                                    );
                                })()
                            ) : (
                                <>
                                    <h2 className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-widest text-red-500">
                                        <Flame size={14} />
                                        Archon Hunt
                                    </h2>
                                    <p className="mt-2 text-sm text-slate-500">No active archon hunt at the moment.</p>
                                </>
                            )}
                        </section>

                    </div>

                    {/*INVASOES-NEWS*/}
                    <div className="grid gap-4 lg:grid-cols-2">

                        {/*INVASOES*/}
                        <section className="rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-lg">
                            <h2 className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-rose-400">
                                <Zap size={14} className="text-cyan-400" />
                                Invasions
                            </h2>
                            {snapshot.invasions.length === 0 ? (
                                <p className="mt-2 text-sm text-slate-500">No active invasions.</p>
                            ) : (
                                <div className="custom-scrollbar mt-3 max-h-140 space-y-2 overflow-auto pr-1">
                                    {snapshot.invasions.map((invasion) => {
                                        const pct = Math.max(0, Math.min(100, invasion.completion_pct ?? 0));
                                        const completed = invasion.completed ?? false;
                                        const hasRewardSides = !!(invasion.attacker_reward || invasion.defender_reward);
                                        return (
                                        <div key={invasion.id}
                                             className="rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2.5 transition-colors hover:border-slate-800">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="text-xs font-bold text-slate-100">{invasion.location}</p>
                                                <span className="font-mono text-[10px] text-slate-400">
                                                    {completed ? 'Completed' : `${pct.toFixed(1)}%`}
                                                </span>
                                            </div>

                                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-900">
                                                {completed ? (
                                                    <div className="h-full w-full rounded-full bg-green-500/60" />
                                                ) : (
                                                    <div className="flex h-full w-full">
                                                        <div className="h-full bg-red-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                                                        <div className="h-full flex-1 bg-blue-500" />
                                                    </div>
                                                )}
                                            </div>

                                            {hasRewardSides ? (
                                                <div className="mt-1.5 flex items-center justify-between gap-2">
                                                    <span className="flex items-center gap-1 font-mono text-[10px] text-red-400">
                                                        <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                                                        {invasion.attacker}: {invasion.attacker_reward}
                                                    </span>
                                                    <span className="flex items-center gap-1 font-mono text-[10px] text-blue-400">
                                                        {invasion.defender}: {invasion.defender_reward}
                                                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                                                    </span>
                                                </div>
                                            ) : (
                                                <p className="mt-1 text-[10px] text-slate-400">
                                                    {invasion.attacker} vs {invasion.defender} — {invasion.reward}
                                                </p>
                                            )}

                                            <p className="mt-1 font-mono text-[10px] text-slate-600">
                                                Updates in {formatCountdown(invasion.expires_at_ms, nowMs)}
                                            </p>
                                        </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>

                        {/*NEWS*/}
                        <section className="rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-lg">
                            <h2 className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest text-cyan-400">
                                <Newspaper size={14} />
                                News
                            </h2>
                            {newsItems.length === 0 ? (
                                <p className="mt-2 text-sm text-slate-500">No news at the moment.</p>
                            ) : (
                                <div className="custom-scrollbar mt-3 max-h-140 space-y-2 overflow-auto pr-1">
                                    {newsItems.map((item) => (
                                        <button
                                            key={item.id}
                                            onClick={() => openNews(item)}
                                            className="w-full rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2 text-left transition-colors hover:border-slate-800"
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <p className="line-clamp-2 text-sm font-semibold text-slate-200">{item.title}</p>
                                                {newsBadge(item.title) && (
                                                    <span
                                                        className="shrink-0 rounded-md border border-orange-500/30 bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                            {newsBadge(item.title)}
                          </span>
                                                )}
                                            </div>
                                            <p className="mt-0.5 font-mono text-[11px] text-slate-500">{formatSince(item.published_at_ms, nowMs)}</p>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>

                    </div>

                    {/*ALERTAS*/}
                    <section className="rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-lg">
                        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-amber-400">Alerts</h2>
                        {snapshot.alerts.length === 0 ? (
                            <p className="mt-2 text-sm text-slate-500">No active alerts.</p>
                        ) : (
                            <div className="custom-scrollbar mt-3 max-h-44 space-y-2 overflow-auto pr-1">
                                {snapshot.alerts.map((alert) => (
                                    <div key={alert.id}
                                         className="rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2 transition-colors hover:border-slate-800">
                                        <p className="text-sm font-semibold text-slate-200">{alert.title}</p>
                                        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
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
