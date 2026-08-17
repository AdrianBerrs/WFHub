import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CalendarDays,
  Flame,
  Target,
  Skull,
  FlaskConical,
  Swords,
  Crown,
  ShoppingBag,
  Package,
  ListChecks,
  Check,
  Clock,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

interface WeeklyMission {
  mission_type: string;
  node: string;
  modifier: string;
}

interface WeeklyArchonHunt {
  boss: string;
  faction: string;
  expires_at_ms: number;
  missions: WeeklyMission[];
}

interface WeeklyArchimedeaRisk {
  name: string;
  description: string;
  is_hard: boolean;
}

interface WeeklyArchimedeaMission {
  mission_type: string;
  faction: string;
  deviation: string;
  deviation_description: string;
  risks: WeeklyArchimedeaRisk[];
}

interface WeeklyModifier {
  name: string;
  description: string;
}

interface WeeklyArchimedea {
  type_name: string;
  expires_at_ms: number;
  missions: WeeklyArchimedeaMission[];
  personal_modifiers: WeeklyModifier[];
}

interface WeeklyCircuitChoices {
  category: string;
  choices: string[];
}

interface WeeklySteelPathReward {
  name: string;
  cost: number;
}

interface WeeklySteelPath {
  current_reward: WeeklySteelPathReward;
  rotation: WeeklySteelPathReward[];
  evergreens: WeeklySteelPathReward[];
  expires_at_ms: number;
}

interface WeeklyState {
  fetched_at_ms: number;
  weekly_reset_ms: number;
  archon_hunt: WeeklyArchonHunt | null;
  sortie: WeeklyArchonHunt | null;
  archimedeas: WeeklyArchimedea[];
  circuit_normal: WeeklyCircuitChoices | null;
  circuit_hard: WeeklyCircuitChoices | null;
  steel_path: WeeklySteelPath | null;
}

interface ActivityDone {
  done: boolean;
  cycle: number;
}

interface ChecklistStore {
  week: number;
  items: Record<string, boolean>;
  activities: Record<string, ActivityDone>;
}

const CHECKLIST_KEY = "wfhub:weekly:checklist";

const CHECKLIST_ITEMS = [
  { key: "netracells", label: "Netracells", hint: "1 reward per week" },
  { key: "descendia", label: "Descendia", hint: "Weekly escalation" },
  { key: "kahl", label: "Break Narmer (Kahl)", hint: "Kahl's weekly mission" },
  { key: "maroo", label: "Ayatan Treasure Hunt (Maroo)", hint: "Maroo's weekly mission" },
  { key: "clem", label: "Help Clem", hint: "Clem's weekly mission" },
];

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

function getWeekNumber(now: number): number {
  // Weekly reset is Monday 00:00 UTC
  const d = new Date(now);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const mondayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday, 0, 0, 0);
  return Math.floor(mondayMs / (7 * 86400 * 1000));
}

function humanizeWeapon(name: string): string {
  const known: Record<string, string> = {
    AckAndBrunt: "Ack & Brunt",
    NamiSolo: "Nami Solo",
    NamiSkyla: "Nami Skyla",
    TwinBasolk: "Twin Basolk",
    DualKamas: "Dual Kamas",
    DarkSword: "Dark Sword",
    PangolinSword: "Pangolin Sword",
    Krohkur: "Krohkur",
    Sibear: "Sibear",
    Boltor: "Boltor",
    Burston: "Burston",
    Soma: "Soma",
    Vasto: "Vasto",
    Despair: "Despair",
  };
  if (known[name]) return known[name];
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function SectionTitle({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-950/60 text-violet-300">
        <Icon size={15} />
      </div>
      <div>
        <h2 className="text-sm font-bold text-slate-100">{title}</h2>
        {subtitle && <p className="text-[11px] text-slate-500">{subtitle}</p>}
      </div>
    </div>
  );
}

function Card({
  icon: Icon,
  color,
  title,
  time,
  timeLabel,
  nowMs,
  checked,
  onToggle,
  tall,
  children,
}: {
  icon: any;
  color: string;
  title: string;
  time: number;
  timeLabel: string;
  nowMs: number;
  checked: boolean;
  onToggle: () => void;
  tall?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`wf-card p-4 ${checked ? "ring-1 ring-green-500/30" : ""} ${tall ? "min-h-[13rem]" : ""}`}>
      <div className="mb-2 flex items-start gap-2">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${color}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={`truncate text-sm font-bold ${checked ? "text-slate-500 line-through" : "text-slate-100"}`}>
            {title}
          </h3>
          <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-slate-500">
            <Clock size={10} />
            {timeLabel} {formatCountdown(time, nowMs)}
          </span>
        </div>
        <button
          onClick={onToggle}
          title={checked ? "Mark as not done" : "Mark as done"}
          className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
            checked
              ? "border-green-500/60 bg-green-500/20 text-green-300"
              : "border-slate-600/60 text-transparent hover:border-slate-400"
          }`}
        >
          <Check size={13} />
        </button>
      </div>
      <div className={checked ? "opacity-50" : ""}>{children}</div>
    </div>
  );
}

const WIKI_IMG = "https://wiki.warframe.com/images";
const FILENAME_EXCEPTIONS: Record<string, string> = {
  AckAndBrunt: "Ack&Brunt",
};

function Tooltip({ label, children }: { label?: string; children: React.ReactNode }) {
  if (!label) return <>{children}</>;
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-max max-w-[220px] rounded-md border border-slate-700 bg-[#14141d] px-2 py-1 text-left text-[10px] font-normal leading-snug text-slate-200 opacity-0 shadow-xl transition-opacity duration-100 group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}

function CircuitChoice({ name, image, large }: { name: string; image?: string; large?: boolean }) {
  const display = humanizeWeapon(name);
  const [failed, setFailed] = useState(false);
  const src = image || `${WIKI_IMG}/${FILENAME_EXCEPTIONS[name] ?? name}.png`;
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`flex items-center justify-center rounded-full border border-slate-700/60 bg-slate-950/60 shadow-inner ${
          large ? "h-16 w-16" : "h-14 w-14"
        }`}
      >
        {!failed ? (
          <img
            src={src}
            alt={display}
            title={display}
            className={`object-contain ${large ? "h-12 w-12" : "h-11 w-11"}`}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className={`px-1 text-center font-mono font-bold leading-tight text-slate-500 ${large ? "text-[10px]" : "text-[9px]"}`}>
            {display}
          </span>
        )}
      </div>
      <span className={`max-w-[4.5rem] truncate text-center leading-tight text-slate-400 ${large ? "text-[11px]" : "text-[10px]"}`} title={display}>
        {display}
      </span>
    </div>
  );
}

export default function WeeklyPage() {
  const [data, setData] = useState<WeeklyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [store, setStore] = useState<ChecklistStore>({
    week: getWeekNumber(Date.now()),
    items: {},
    activities: {},
  });
  const [circuitImages, setCircuitImages] = useState<Record<string, string>>({});
  const [showRotation, setShowRotation] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    invoke<string>("read_circuit_images")
      .then((raw) => setCircuitImages(JSON.parse(raw)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("fetch_weekly_state")
      .then((raw) => {
        if (cancelled) return;
        setData(JSON.parse(raw));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const currentWeek = getWeekNumber(Date.now());
    let loaded: ChecklistStore = { week: currentWeek, items: {}, activities: {} };
    try {
      const parsed = JSON.parse(localStorage.getItem(CHECKLIST_KEY) || "{}");
      if (parsed && typeof parsed === "object") {
        if (parsed.week === currentWeek) {
          loaded = { week: currentWeek, items: parsed.items ?? {}, activities: parsed.activities ?? {} };
        }
      }
    } catch {
      // ignore corrupt storage
    }
    setStore(loaded);
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(loaded));
  }, []);

  const persist = (next: ChecklistStore) => {
    setStore(next);
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
  };

  const toggleItem = (key: string) => {
    persist({ ...store, items: { ...store.items, [key]: !store.items[key] } });
  };

  const toggleActivity = (key: string, cycle: number) => {
    const current = store.activities[key];
    const done = !(current && current.cycle === cycle && current.done);
    persist({ ...store, activities: { ...store.activities, [key]: { done, cycle } } });
  };

  const isActivityChecked = (key: string, cycle: number): boolean => {
    const a = store.activities[key];
    return !!a && a.cycle === cycle && a.done;
  };

  const doneCount = CHECKLIST_ITEMS.filter((i) => store.items[i.key]).length;

  if (loading) {
    return (
      <div className="wf-page">
        <p className="text-sm text-slate-500">Loading weekly activities...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="wf-page">
        <div className="rounded-lg border border-red-700/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
          Failed to fetch data: {error || "no data"}
        </div>
      </div>
    );
  }

  const deep = data.archimedeas.find((a) => a.type_name === "Deep Archimedea");
  const temporal = data.archimedeas.find((a) => a.type_name === "Temporal Archimedea");
  const weeklyCycle = data.weekly_reset_ms;
  const sortieCycle = data.sortie?.expires_at_ms ?? weeklyCycle;
  const veiled = data.steel_path?.evergreens.find((e) => e.name.toLowerCase().includes("veiled riven"));
  const kuva = data.steel_path?.evergreens.find((e) => e.name.toLowerCase().includes("kuva"));

  return (
    <div className="wf-page space-y-6">
      {/* Header + weekly reset countdown */}
      <div className="wf-panel flex flex-wrap items-center gap-4 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-violet-500 to-purple-600 text-white shadow-[0_0_16px_rgba(139,92,246,0.35)]">
          <CalendarDays size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-slate-100">Weekly</h1>
          <p className="text-[11px] text-slate-500">
            Weekly reset in <span className="font-mono text-violet-300">{formatCountdown(data.weekly_reset_ms, nowMs)}</span>{" "}
            (Monday 00:00 UTC)
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          <RefreshCw size={13} />
          Checklist: {doneCount}/{CHECKLIST_ITEMS.length}
        </div>
      </div>

      {/* Section: Weekly activities */}
      <section className="space-y-3">
        <SectionTitle icon={ListChecks} title="Weekly activities" subtitle="Live data · check the box when done" />

        {/* Row 1: sortie, archon, circuit normal, circuit SP */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data.sortie && (
            <Card
              icon={Target}
              color="bg-amber-950/60 text-amber-300"
              title={`Sortie: ${data.sortie.boss || "—"}`}
              time={data.sortie.expires_at_ms}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("sortie", sortieCycle)}
              onToggle={() => toggleActivity("sortie", sortieCycle)}
              tall
            >
              <ul className="space-y-1">
                {data.sortie.missions.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 rounded-md bg-slate-900/40 px-2 py-1.5 text-[13px]">
                    <span className="text-slate-300">{m.mission_type}</span>
                    <span className="truncate text-slate-500">
                      {m.modifier ? <Tooltip label={m.modifier}>{m.modifier}</Tooltip> : m.node}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.archon_hunt && (
            <Card
              icon={Flame}
              color="bg-red-950/60 text-red-300"
              title={`Archon Hunt: ${data.archon_hunt.boss.replace("Archon ", "")}`}
              time={data.archon_hunt.expires_at_ms}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("archon", weeklyCycle)}
              onToggle={() => toggleActivity("archon", weeklyCycle)}
              tall
            >
              <ul className="space-y-1">
                {data.archon_hunt.missions.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 rounded-md bg-slate-900/40 px-2 py-1.5 text-[13px]">
                    <span className="text-slate-300">{m.mission_type}</span>
                    <span className="truncate text-slate-500">{m.node}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {data.circuit_normal && (
            <Card
              icon={Swords}
              color="bg-indigo-950/60 text-indigo-300"
              title="The Circuit (Normal)"
              time={weeklyCycle}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("circuit_normal", weeklyCycle)}
              onToggle={() => toggleActivity("circuit_normal", weeklyCycle)}
              tall
            >
              <div className="mt-8 flex flex-wrap items-start justify-center gap-3">
                {data.circuit_normal.choices.map((c, i) => (
                  <CircuitChoice key={i} name={c} image={circuitImages[c]} large />
                ))}
              </div>
            </Card>
          )}

          {data.circuit_hard && (
            <Card
              icon={Crown}
              color="bg-fuchsia-950/60 text-fuchsia-300"
              title="The Circuit (Steel Path)"
              time={weeklyCycle}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("circuit_hard", weeklyCycle)}
              onToggle={() => toggleActivity("circuit_hard", weeklyCycle)}
              tall
            >
              <div className="mt-8 flex flex-wrap items-start justify-center gap-3">
                {data.circuit_hard.choices.map((c, i) => (
                  <CircuitChoice key={i} name={c} image={circuitImages[c]} />
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Row 2: temporal archimedea, deep archimedea, weekly missions */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {temporal && (
            <Card
              icon={Skull}
              color="bg-emerald-950/60 text-emerald-300"
              title={temporal.type_name}
              time={temporal.expires_at_ms}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("temporal", weeklyCycle)}
              onToggle={() => toggleActivity("temporal", weeklyCycle)}
            >
              <ul className="space-y-1">
                {temporal.missions.map((m, i) => (
                  <li key={i} className="rounded-md bg-slate-900/40 px-2 py-1.5 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-300">{m.mission_type}</span>
                      {m.deviation && (
                        <Tooltip label={m.deviation_description || undefined}>
                          <span className="truncate text-emerald-300">{m.deviation}</span>
                        </Tooltip>
                      )}
                    </div>
                    {m.risks.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.risks.map((r, j) => (
                          <Tooltip key={j} label={r.description}>
                            <span
                              className={`rounded px-1 py-0.5 text-[10px] font-semibold ${
                                r.is_hard ? "bg-red-950/50 text-red-300" : "bg-slate-800/70 text-slate-400"
                              }`}
                            >
                              {r.name}
                            </span>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {temporal.personal_modifiers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {temporal.personal_modifiers.map((mod, j) => (
                    <Tooltip key={j} label={mod.description}>
                      <span className="rounded bg-emerald-950/50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                        {mod.name}
                      </span>
                    </Tooltip>
                  ))}
                </div>
              )}
            </Card>
          )}

          {deep && (
            <Card
              icon={FlaskConical}
              color="bg-cyan-950/60 text-cyan-300"
              title={deep.type_name}
              time={deep.expires_at_ms}
              timeLabel="Resets in"
              nowMs={nowMs}
              checked={isActivityChecked("deep", weeklyCycle)}
              onToggle={() => toggleActivity("deep", weeklyCycle)}
            >
              <ul className="space-y-1">
                {deep.missions.map((m, i) => (
                  <li key={i} className="rounded-md bg-slate-900/40 px-2 py-1.5 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-300">{m.mission_type}</span>
                      {m.deviation && (
                        <Tooltip label={m.deviation_description || undefined}>
                          <span className="truncate text-cyan-300">{m.deviation}</span>
                        </Tooltip>
                      )}
                    </div>
                    {m.risks.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {m.risks.map((r, j) => (
                          <Tooltip key={j} label={r.description}>
                            <span
                              className={`rounded px-1 py-0.5 text-[10px] font-semibold ${
                                r.is_hard ? "bg-red-950/50 text-red-300" : "bg-slate-800/70 text-slate-400"
                              }`}
                            >
                              {r.name}
                            </span>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {deep.personal_modifiers.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {deep.personal_modifiers.map((mod, j) => (
                    <Tooltip key={j} label={mod.description}>
                      <span className="rounded bg-cyan-950/50 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-300">
                        {mod.name}
                      </span>
                    </Tooltip>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Weekly missions */}
          <div className="wf-card p-4">
            <div className="mb-2 flex items-start gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-950/60 text-violet-300">
                <ListChecks size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-bold text-slate-100">Weekly missions</h3>
                <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                  <Clock size={10} />
                  Resets in {formatCountdown(weeklyCycle, nowMs)}
                </span>
              </div>
              <span className="shrink-0 text-xs font-bold text-violet-300">
                {doneCount}/{CHECKLIST_ITEMS.length}
              </span>
            </div>
            <div className="space-y-1">
              {CHECKLIST_ITEMS.map((item) => {
                const checked = !!store.items[item.key];
                return (
                  <button
                    key={item.key}
                    onClick={() => toggleItem(item.key)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      checked ? "bg-green-950/10" : "hover:bg-slate-900/30"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        checked
                          ? "border-green-500/50 bg-green-500/20 text-green-300"
                          : "border-slate-700/60 text-transparent"
                      }`}
                    >
                      <Check size={12} />
                    </span>
                    <span
                      className={`truncate text-[11px] font-semibold ${checked ? "text-green-300 line-through" : "text-slate-200"}`}
                    >
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {error && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-900/10 px-2 py-1.5 text-[10px] text-amber-300">
                <AlertTriangle size={12} />
                Checklist still works offline.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Vendors */}
      {data.steel_path && (
        <section className="space-y-3">
          <SectionTitle icon={ShoppingBag} title="Vendors" subtitle="Teshin and Palladino weekly rotation" />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="wf-card p-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 text-slate-300">
                    <Crown size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold text-slate-100">Steel Path Honors (Teshin)</h3>
                    <p className="text-[11px] text-slate-500">Resets in {formatCountdown(data.steel_path.expires_at_ms, nowMs)}</p>
                  </div>
                  <button
                    onClick={() => toggleItem("teshin")}
                    title={store.items["teshin"] ? "Mark as not done" : "Mark as done"}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      store.items["teshin"]
                        ? "border-green-500/60 bg-green-500/20 text-green-300"
                        : "border-slate-600/60 text-transparent hover:border-slate-400"
                    }`}
                  >
                    <Check size={13} />
                  </button>
                </div>

                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-950/20 px-3 py-2">
                  <span className="text-xs text-slate-400">Item of the week</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs font-bold text-amber-300">
                    {data.steel_path.current_reward.name || "—"}
                  </span>
                  {data.steel_path.current_reward.cost > 0 && (
                    <span className="shrink-0 text-[10px] text-slate-500">{data.steel_path.current_reward.cost} essences</span>
                  )}
                </div>

                <ul className="space-y-1">
                  {(veiled || kuva) && (
                    <li className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/40 px-3 py-2">
                      <span className="text-xs text-slate-300">{veiled?.name ?? "Veiled Riven Cipher"}</span>
                      {veiled && <span className="shrink-0 text-[10px] text-slate-500">{veiled.cost} essences</span>}
                    </li>
                  )}
                  <li className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/40 px-3 py-2">
                    <span className="text-xs text-slate-300">
                      {kuva ? kuva.name.replace(/(\d)k/i, "$1K") : "25x Kuva Pack"}
                      {kuva && <span className="text-slate-500"> (25x)</span>}
                    </span>
                    {kuva && <span className="shrink-0 text-[10px] text-slate-500">{kuva.cost * 25} essences</span>}
                  </li>
                </ul>

                <button
                  onClick={() => setShowRotation((s) => !s)}
                  className="mt-2 w-full rounded-lg bg-slate-900/50 px-3 py-2 text-left text-[11px] font-semibold text-slate-300 transition-colors hover:bg-slate-800/60"
                >
                  {showRotation ? "▾" : "▸"} Rotation (8 weeks)
                </button>
                {showRotation && (
                  <ul className="mt-1 space-y-0.5 rounded-lg bg-slate-900/30 p-2">
                    {data.steel_path.rotation.map((r, i) => (
                      <li
                        key={i}
                        className={`flex items-center justify-between rounded px-2 py-1 text-[11px] ${
                          r.name === data.steel_path?.current_reward.name
                            ? "bg-amber-950/40 text-amber-300"
                            : "text-slate-400"
                        }`}
                      >
                        <span className="truncate">{r.name}</span>
                        <span className="shrink-0 text-slate-600">{r.cost}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="wf-card flex flex-col p-4">
                <div className="mb-2 flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 text-slate-300">
                    <Package size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-bold text-slate-100">Iron Wake (Palladino)</h3>
                    <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                      <Clock size={10} />
                      Resets in {formatCountdown(data.steel_path.expires_at_ms, nowMs)}
                    </span>
                  </div>
                  <button
                    onClick={() => toggleItem("palladino")}
                    title={store.items["palladino"] ? "Mark as not done" : "Mark as done"}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      store.items["palladino"]
                        ? "border-green-500/60 bg-green-500/20 text-green-300"
                        : "border-slate-600/60 text-transparent hover:border-slate-400"
                    }`}
                  >
                    <Check size={13} />
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">Rotating stock. Check when you visit.</p>
              </div>
          </div>
        </section>
      )}
    </div>
  );
}
