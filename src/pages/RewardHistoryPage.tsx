import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RewardItem {
  name: string;
  platinum: number;
  is_best: boolean;
}

interface RewardEntry {
  timestamp: string;
  items: RewardItem[];
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function RewardHistoryPage() {
  const [history, setHistory] = useState<RewardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<string>("read_reward_history")
      .then((raw) => setHistory(JSON.parse(raw)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="space-y-1">
        <h1 className="text-lg font-bold text-primary-400">Reward History</h1>
        <p className="text-sm text-zinc-500">Last {history.length} reward screens detected.</p>
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading...</p>}
      {!loading && history.length === 0 && (
        <p className="text-sm text-zinc-500">No rewards recorded yet. Play a mission!</p>
      )}

      <div className="flex-1 overflow-auto space-y-2">
        {history.map((entry, i) => {
          const best = entry.items.find((it) => it.is_best);
          return (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500">{formatDate(entry.timestamp)}</span>
                {best && best.platinum > 0 && (
                  <span className="text-xs font-semibold text-yellow-400">{best.platinum.toFixed(1)}p best</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {entry.items.map((item, j) => (
                  <span
                    key={j}
                    className={`text-xs px-2 py-1 rounded-md border ${
                      item.is_best
                        ? "border-primary-500/60 bg-primary-500/10 text-primary-300"
                        : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    {item.name}
                    {item.platinum > 0 && (
                      <span className="ml-1 text-yellow-500/70">{item.platinum.toFixed(1)}p</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
