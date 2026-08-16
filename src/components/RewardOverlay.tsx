import { useEffect, useState, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface RewardItem {
  name: string;
  platinum: number;
  is_best: boolean;
}

interface RewardPayload {
  timestamp: string;
  items: RewardItem[];
}

function getSetName(partName: string): string {
  const m = partName.match(/^(.+? Prime)/);
  return m ? m[1] + " Set" : "";
}

// Remove non-Blueprint duplicates (warframe components like "Chassis" when "Chassis Blueprint" exists)
function dedupeSetParts(parts: string[], baseName: string): string[] {
  const blueprintBases = new Set(
    parts
      .filter((p) => p.replace(baseName, "").trim().endsWith("Blueprint"))
      .map((p) => p.replace(" Blueprint", ""))
  );
  return parts.filter((p) => {
    const withoutBase = p.replace(baseName, "").trim();
    return withoutBase.endsWith("Blueprint") || !blueprintBases.has(p);
  });
}

function shortPartLabel(part: string, baseName: string): string {
  const raw = part.replace(baseName, "").trim();
  if (raw === "Blueprint") return "Blueprint";
  return raw.replace(" Blueprint", "").trim();
}

function partIcon(partName: string): string | null {
  const lower = partName.toLowerCase();
  if (lower.endsWith("chassis blueprint") || lower.endsWith("chassis")) return "/prime_parts/chassis.png";
  if (lower.endsWith("neuroptics blueprint") || lower.endsWith("neuroptics")) return "/prime_parts/neuroptics.png";
  if (lower.endsWith("systems blueprint") || lower.endsWith("systems")) return "/prime_parts/systems.png";
  if (lower.endsWith("blueprint")) return "/prime_parts/blueprint.png";
  if (lower.endsWith("barrel")) return "/prime_parts/barrel.png";
  if (lower.endsWith("receiver")) return "/prime_parts/receiver.png";
  if (lower.endsWith("stock")) return "/prime_parts/stock.png";
  if (lower.endsWith("blade")) return "/prime_parts/blade.png";
  if (lower.endsWith("handle")) return "/prime_parts/handle.png";
  if (lower.endsWith("link")) return "/prime_parts/link.png";
  if (lower.endsWith("grip")) return "/prime_parts/grip.png";
  if (lower.endsWith("guard")) return "/prime_parts/guard.png";
  if (lower.endsWith("disc")) return "/prime_parts/disc.png";
  if (lower.endsWith("string")) return "/prime_parts/string.png";
  if (lower.endsWith("gauntlet")) return "/prime_parts/gauntlet.png";
  if (lower.endsWith("chain")) return "/prime_parts/chain.png";
  if (lower.endsWith("ornament")) return "/prime_parts/ornament.png";
  return null;
}

export default function RewardOverlay() {
  const [payload, setPayload] = useState<RewardPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [primeParts, setPrimeParts] = useState<string[]>([]);
  const [ownedParts, setOwnedParts] = useState<Set<string>>(new Set());
  const [pricesMap, setPricesMap] = useState<Map<string, number>>(new Map());
  const [ducatMap, setDucatMap] = useState<Map<string, number>>(new Map());
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<string>("read_prime_parts"),
      invoke<string>("read_inventory"),
      invoke<string>("read_prices"),
      invoke<string>("read_ducat_values"),
    ])
      .then(([partsRaw, invRaw, pricesRaw, ducatRaw]) => {
        setPrimeParts(JSON.parse(partsRaw));
        setOwnedParts(new Set(JSON.parse(invRaw).prime_parts ?? []));
        const arr: { name: string; custom_avg: string }[] = JSON.parse(pricesRaw);
        setPricesMap(new Map(arr.map((p) => [p.name, parseFloat(p.custom_avg)])));
        const ducatObj: Record<string, number> = JSON.parse(ducatRaw);
        setDucatMap(new Map(Object.entries(ducatObj)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<RewardPayload>("reward-detected", (event) => {
      setPayload(event.payload);
      setSelectedItem(null);
      setVisible(true);
    });
    const unlistenHide = listen("hide-overlay", () => setVisible(false));
    return () => {
      unlisten.then((f) => f());
      unlistenHide.then((f) => f());
    };
  }, []);

  const primePartsSet = useMemo(() => new Set(primeParts), [primeParts]);

  const setPartsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const part of primeParts) {
      const sn = getSetName(part);
      if (!sn) continue;
      if (!map.has(sn)) map.set(sn, []);
      map.get(sn)!.push(part);
    }
    return map;
  }, [primeParts]);

  async function handlePick(name: string) {
    if (selectedItem !== null) return;
    setSelectedItem(name);
    if (primePartsSet.has(name) && !ownedParts.has(name)) {
      const updated = [...ownedParts, name].sort();
      setOwnedParts(new Set(updated));
      invoke("save_prime_parts", { parts: updated }).catch(() => {});
    }
  }

  if (!visible || !payload) return null;

  return (
    <div className="w-full h-full flex items-stretch justify-center p-3 gap-3">
      {payload.items.map((item, i) => {
        const isPicked = selectedItem === item.name;
        const dimmed = selectedItem !== null && !isPicked;
        const setName = getSetName(item.name);
        const baseName = setName.replace(" Set", "");
        const allSetParts = setName ? (setPartsMap.get(setName) ?? []) : [];
        const setParts = dedupeSetParts(allSetParts, baseName);
        const setPrice = setName ? (pricesMap.get(setName) ?? 0) : 0;
        const ducatValue = ducatMap.get(item.name) ?? 0;
        const hasValue = item.platinum > 0;

        return (
          <button
            key={i}
            onClick={() => handlePick(item.name)}
            disabled={selectedItem !== null}
            className={[
              "relative flex flex-col flex-1 rounded-2xl p-3 text-left min-w-0",
              "backdrop-blur-md border shadow-2xl transition-all duration-200",
              isPicked
                ? "bg-green-900/80 border-green-500/60 ring-2 ring-green-400"
                : item.is_best
                ? "bg-zinc-950/85 border-primary-500 border-2 hover:bg-zinc-800/80"
                : "bg-zinc-950/85 border-zinc-700/50 hover:bg-zinc-800/80",
              dimmed ? "opacity-40" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {/* Best / Picked badge */}
            {item.is_best && !isPicked && (
              <span className="absolute top-2 right-2 text-[10px] font-bold text-primary-300 bg-primary-900/60 px-1.5 py-0.5 rounded-full">
                ★ Best
              </span>
            )}
            {isPicked && (
              <span className="absolute top-2 right-2 text-[10px] font-bold text-green-300 bg-green-900/60 px-1.5 py-0.5 rounded-full">
                ✓ Picked
              </span>
            )}

            {/* Item name */}
            <p
              className={[
                "text-sm font-semibold leading-tight line-clamp-2 min-h-[2.5rem] pr-12 shrink-0",
                isPicked ? "text-green-100" : "text-zinc-100",
              ].join(" ")}
            >
              {item.name}
            </p>

            {/* Platinum + Ducats — large, centered */}
            <div className="flex items-center justify-center gap-6 mt-3 shrink-0">
              <span
                className={[
                  "flex items-center gap-1.5 text-2xl font-bold",
                  isPicked ? "text-green-300" : "text-yellow-400",
                ].join(" ")}
              >
                {hasValue ? Math.round(item.platinum) : "—"}
                <img src="/icons/PlatinumLarge.webp" alt="p" className="w-5 h-5 object-contain" />
              </span>
              <span className="flex items-center gap-1.5 text-2xl font-bold text-amber-400">
                {ducatValue > 0 ? ducatValue : "—"}
                <img src="/icons/OrokinDucats.png" alt="d" className="w-5 h-5 object-contain" />
              </span>
            </div>

            {/* Set parts ownership indicators */}
            <div className="flex flex-wrap gap-2 mt-3 flex-1 content-start items-start justify-center">
              {setParts.map((part, idx) => {
                const owned =
                  ownedParts.has(part) ||
                  ownedParts.has(part + " Blueprint") ||
                  ownedParts.has(part.replace(" Blueprint", ""));
                const label = shortPartLabel(part, baseName);
                const icon = partIcon(part);
                return (
                  <div key={idx} className="flex flex-col items-center gap-0.5">
                    <div
                      title={part}
                      className={[
                        "flex h-10 w-10 items-center justify-center rounded-full border transition-all",
                        owned
                          ? "border-emerald-500/40 bg-emerald-950/30"
                          : "border-zinc-700/50 bg-zinc-950/60 opacity-40",
                      ].join(" ")}
                    >
                      {icon ? (
                        <img src={icon} alt={label} className="h-6 w-6 object-contain" style={{imageRendering: "pixelated"}} />
                      ) : (
                        <span className="text-[8px] font-mono font-bold text-zinc-400 text-center leading-tight px-1">{label}</span>
                      )}
                    </div>
                    <span className="text-[8px] text-zinc-500 leading-tight text-center max-w-[2.5rem] truncate">{label}</span>
                  </div>
                );
              })}
            </div>

            {/* Set total price */}
            <div className="pt-1.5 mt-2 border-t border-zinc-700/40 shrink-0">
              <span className="flex items-center gap-1 text-xs text-zinc-400">
                Set:{" "}
                {setPrice > 0 ? (
                  <>
                    <span className="text-zinc-300 font-medium">{Math.round(setPrice)}</span>
                    <img src="/icons/PlatinumLarge.webp" alt="p" className="w-3.5 h-3.5 object-contain" />
                  </>
                ) : (
                  <span className="text-zinc-300 font-medium">—</span>
                )}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
