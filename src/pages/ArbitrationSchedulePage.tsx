import {useEffect, useMemo, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useNavigate} from "react-router-dom";
import {ChevronLeft, ChevronRight} from "lucide-react";

interface HubArbitrationSlot {
    start_at_ms: number;
    end_at_ms: number;
    description: string;
    tier?: string | null;
}

interface HubArbitrationScheduleResponse {
    source: string;
    generated_at_ms: number;
    days: number;
    stale: boolean;
    message: string | null;
    slots: HubArbitrationSlot[];
}

const tierStyles: Record<string, string> = {
    "S TIER": "bg-primary-500/20 text-primary-300 border-primary-500/40",
    "A TIER": "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    "B TIER": "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
    "C TIER": "bg-amber-500/20 text-amber-300 border-amber-500/40",
    "D TIER": "bg-orange-500/20 text-orange-300 border-orange-500/40",
    "F TIER": "bg-red-500/20 text-red-300 border-red-500/40",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function startOfTodayMs(): number {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.getTime();
}

function formatSlotDateTime(timestampMs: number): string {
    const d = new Date(timestampMs);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${day}/${month} ${hours}:${minutes}`;
}

function formatDayTitle(dayStartMs: number, offset: number): string {
    const rawLabel = new Date(dayStartMs).toLocaleDateString("en-US", {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
    });

    const label = capitalize(rawLabel);

    if (offset === 0) return `Today - ${label}`;
    return label;
}

function sanitizeArbitrationDescription(description: string, tier?: string | null): string {
    const cleaned = description.trim();
    if (!tier) return cleaned;
    const suffix = ` (${tier})`;
    return cleaned.endsWith(suffix) ? cleaned.slice(0, -suffix.length) : cleaned;
}

export default function ArbitrationSchedulePage() {
    const navigate = useNavigate();
    const [slots, setSlots] = useState<HubArbitrationSlot[]>([]);
    const [days, setDays] = useState(7);
    const [selectedDay, setSelectedDay] = useState(0);
    const [source, setSource] = useState<string | null>(null);
    const [staleMessage, setStaleMessage] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const baseDayMs = useMemo(() => startOfTodayMs(), []);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            setError(null);
            try {
                const raw = await invoke<string>("fetch_hub_arbitrations_next_days", {days: 7});
                if (cancelled) return;
                const parsed: HubArbitrationScheduleResponse = JSON.parse(raw);
                setSlots((parsed.slots ?? []).slice().sort((a, b) => a.start_at_ms - b.start_at_ms));
                setDays(Math.max(1, Math.min(14, parsed.days || 7)));
                setSource(parsed.source);
                setStaleMessage(parsed.stale ? (parsed.message ?? "Cached data") : null);
            } catch (e) {
                if (cancelled) return;
                setError(String(e));
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    const selectedDayStartMs = baseDayMs + selectedDay * DAY_MS;
    const selectedDayEndMs = selectedDayStartMs + DAY_MS;

    const daySlots = useMemo(
        () =>
            slots.filter(
                (slot) => slot.start_at_ms >= selectedDayStartMs && slot.start_at_ms < selectedDayEndMs,
            ),
        [slots, selectedDayStartMs, selectedDayEndMs],
    );

    return (
        <div className="wf-page flex min-h-full flex-col gap-5">
            <div className="wf-panel flex items-center justify-between gap-2 p-5">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-slate-100">Arbitrations (7 days)</h1>
                    <p className="mt-1 text-xs text-slate-400">Upcoming schedule from today.</p>
                </div>
                <button
                    type="button"
                    onClick={() => navigate("/hub")}
                    className="rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-950/60"
                >
                    Back to Hub
                </button>
            </div>

            {source && (
                <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-400">
                    Source: {source}
                </div>
            )}

            {staleMessage && (
                <div
                    className="rounded-lg border border-yellow-700/40 bg-yellow-900/10 px-3 py-2 text-xs text-yellow-300">
                    Showing fallback: {staleMessage}
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
                    {error}
                </div>
            )}

            <div className="wf-card p-5">
                <div className="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={() => setSelectedDay((prev) => Math.max(0, prev - 1))}
                        disabled={selectedDay === 0}
                        title="Previous day"
                        className="flex items-center justify-center rounded-lg p-2 text-slate-500 transition hover:bg-slate-800 hover:text-white active:scale-95">
                        <ChevronLeft size={16}/>
                    </button>

                    <p className="text-sm font-semibold text-slate-100">
                        {formatDayTitle(selectedDayStartMs, selectedDay)}
                    </p>

                    <button
                        type="button"
                        onClick={() => setSelectedDay((prev) => Math.min(days - 1, prev + 1))}
                        disabled={selectedDay >= days - 1}
                        title="Next day"
                        className="flex items-center justify-center rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white active:scale-95">
                        <ChevronRight size={16}/>
                    </button>
                </div>

                <div className="mt-4 space-y-2">
                    {loading ? (
                        <p className="text-sm text-zinc-500">Loading arbitrations...</p>
                    ) : daySlots.length === 0 ? (
                        <p className="text-sm text-zinc-500">No arbitrations on this day.</p>
                    ) : (
                        daySlots.map((slot) => (
                            <div
                                key={`${slot.start_at_ms}-${slot.description}`}
                                className="group relative rounded-lg border border-slate-900 bg-slate-950/60 px-3 py-2 transition hover:border-slate-800 hover:bg-slate-900/80 hover:shadow-lg hover:shadow-black/30"
                            >
                                {/* BARRA LATERAL */}
                                <div className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${
                                    slot.tier === "S TIER" ? "bg-primary-500" : slot.tier === "A TIER" ? "bg-emerald-500"
                                        : slot.tier === "B TIER" ? "bg-yellow-500" : slot.tier === "C TIER" ? "bg-orange-500" : "bg-red-500"
                                }`}
                                />

                                {/* CONTEÚDO */}
                                <p className="text-sm font-semibold text-white">
                                    {formatSlotDateTime(slot.start_at_ms)}
                                </p>

                                <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-300">
                                    <span
                                        className="truncate text-xs text-zinc-300">{sanitizeArbitrationDescription(slot.description, slot.tier)}</span>
                                    {slot.tier && (
                                        <span
                                            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
                                                tierStyles[slot.tier] || "bg-zinc-700 text-zinc-300 border-zinc-600"
                                            }`}
                                        >
                                       {slot.tier}
                                    </span>
                                    )}
                                </p>

                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
