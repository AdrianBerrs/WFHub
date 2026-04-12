import {useState, useEffect, useCallback, useMemo} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen, UnlistenFn} from "@tauri-apps/api/event";

type Filter = "all" | "incomplete" | "complete";

interface PrimeItem {
    name: string;
    parts: string[];
}

const WARFRAME_SUB_BP = /\b(Chassis|Neuroptics|Systems|Harness|Wings) Blueprint$/;

function getPrimeItemName(partName: string): string {
    const words = partName.split(" ");
    const idx = words.indexOf("Prime");
    if (idx >= 0) return words.slice(0, idx + 1).join(" ");
    return partName;
}

function buildGroups(allParts: string[]): PrimeItem[] {
    const map = new Map<string, string[]>();
    for (const part of allParts) {
        const item = getPrimeItemName(part);
        const list = map.get(item) ?? [];
        list.push(part);
        map.set(item, list);
    }
    return Array.from(map.entries())
        .map(([name, parts]) => ({name, parts: parts.sort()}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function isWarframeItem(item: PrimeItem): boolean {
    return item.parts.some((p) => WARFRAME_SUB_BP.test(p));
}

// For warframes: shows crafted parts + main Blueprint; hides sub-blueprints
function getDisplayParts(item: PrimeItem): string[] {
    if (!isWarframeItem(item)) return item.parts;
    return item.parts.filter(
        (p) => !p.endsWith(" Blueprint") || p === `${item.name} Blueprint`
    );
}

export default function PrimeTrackerPage() {
    const [allParts, setAllParts] = useState<string[]>([]);
    const [scanned, setScanned] = useState<Set<string>>(new Set());
    const [scannedAt, setScannedAt] = useState<string | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const loadInventory = useCallback(async () => {
        try {
            const raw = await invoke<string>("read_inventory");
            const parsed = JSON.parse(raw);
            setScanned(new Set<string>(parsed.prime_parts ?? []));
            if (parsed.scanned_at) setScannedAt(parsed.scanned_at);
        } catch { /* file doesn't exist yet */
        }
    }, []);

    useEffect(() => {
        invoke<string>("read_prime_parts")
            .then((raw) => setAllParts(JSON.parse(raw)))
            .catch(() => {
            });
        loadInventory();
    }, [loadInventory]);

    // Reload when a scan completes in InventoryPage
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<{ count: number; phase: string }>("inventory-progress", async (event) => {
            if (event.payload.phase === "done") {
                await loadInventory();
            }
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            unlisten?.();
        };
    }, [loadInventory]);

    const groups = useMemo(() => buildGroups(allParts), [allParts]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return groups.filter((item) => {
            if (q && !item.name.toLowerCase().includes(q)) return false;
            const display = getDisplayParts(item);
            const have = display.filter((p) => scanned.has(p)).length;
            if (filter === "complete") return have === display.length;
            if (filter === "incomplete") return have < display.length;
            return true;
        });
    }, [groups, filter, search, scanned]);

    const totalItems = groups.length;
    const completeItems = groups.filter((g) => {
        const display = getDisplayParts(g);
        return display.every((p) => scanned.has(p));
    }).length;
    const incompleteItems = totalItems - completeItems;

    function toggleExpand(name: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            next.has(name) ? next.delete(name) : next.add(name);
            return next;
        });
    }


    return (
        <div className="flex flex-col h-full p-4 gap-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Prime Tracker</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Track prime sets from inventory, showing complete and incomplete sets.
                </p>
            </div>

            {/* Stats + last scan */}
            <div className="flex items-center gap-4 flex-wrap">
                {allParts.length > 0 && (
                    <div className="flex gap-4 text-sm text-gray-400">
                        <span><span className="text-purple-400 font-semibold">{totalItems}</span> primes</span>
                        <span><span className="text-green-400 font-semibold">{completeItems}</span> complete</span>
                        <span><span className="text-red-400 font-semibold">{incompleteItems}</span> incomplete</span>
                    </div>
                )}
                {scannedAt && (
                    <span className="text-xs text-gray-600 ml-auto">
            Last scan: {new Date(scannedAt).toLocaleString()}
          </span>
                )}
            </div>
            {scanned.size === 0 && allParts.length > 0 && (
                <p className="text-xs text-gray-500">Scan your inventory in the Inventory tab → Primes.</p>
            )}

            {/* Filters + search */}
            {allParts.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                    {(["all", "incomplete", "complete"] as Filter[]).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors  ${
                                filter === f
                                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/40"
                                    : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                            }`}
                        >
                            {f === "all" ? "All" : f === "incomplete" ? "Incomplete" : "Complete"}
                        </button>
                    ))}
                </div>
            )}

            <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search prime..."
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />

            {/* Item list */}
            <div className="flex-1 overflow-auto space-y-1">
                {filtered.length === 0 && allParts.length > 0 && (
                    <p className="text-gray-500 text-sm">No results.</p>
                )}
                {allParts.length === 0 && (
                    <p className="text-gray-500 text-sm">Loading prime parts list...</p>
                )}

                {filtered.map((item) => {
                    const displayParts = getDisplayParts(item);
                    const have = displayParts.filter((p) => scanned.has(p)).length;
                    const total = displayParts.length;
                    const complete = have === total;
                    const isOpen = expanded.has(item.name);

                    return (
                        <div key={item.name} className="rounded-lg border border-gray-800 overflow-hidden">
                            <button
                                onClick={() => toggleExpand(item.name)}
                                className={`flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-gray-800/60 ${
                                    isOpen ? "bg-gray-900/80 rounded-t-lg" : "bg-gray-900/60 rounded-lg"
                                }`}
                            >
                                <span className="text-sm font-medium text-gray-200">{item.name}</span>
                                <span className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-semibold ${complete ? "text-green-400" : "text-purple-400"}`}>
                    {have}/{total}
                  </span>
                                    {/* Progress bar */}
                                    <span className="w-16 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                    <span
                        className={`block h-full rounded-full transition-all ${complete ? "bg-green-500" : "bg-purple-500"}`}
                        style={{width: `${(have / total) * 100}%`}}
                    />
                  </span>
                  <span className="text-xs text-gray-500">{isOpen ? "▲" : "▼"}</span>
                </span>
                            </button>

                            {isOpen && (
                                <div className="divide-y divide-gray-800/70 border-t border-gray-800">
                                    {displayParts.map((part) => {
                                        const owned = scanned.has(part);
                                        const hasBP = !owned && isWarframeItem(item) && scanned.has(part + " Blueprint");
                                        const label = part.replace(`${item.name} `, "");
                                        return (
                                            <div
                                                key={part}
                                                className={`flex items-center gap-2 px-4 py-2 text-sm ${
                                                    owned ? "text-gray-300" : "text-gray-500"
                                                }`}
                                            >
                                                {owned ? (
                                                    <span className="text-green-400">✓</span>
                                                ) : hasBP ? (
                                                    <span
                                                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-900/50 text-blue-300 border border-blue-700/50 leading-none">
                            BP
                          </span>
                                                ) : (
                                                    <span className="text-red-500/60">✗</span>
                                                )}
                                                <span>{label}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
