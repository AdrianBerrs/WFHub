import {useState, useEffect, useCallback, useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen, UnlistenFn} from "@tauri-apps/api/event";

type ScanType = "mods" | "arcanes" | "prime_parts";
type Phase = "idle" | "capturing" | "processing" | "done";

interface ProgressPayload {
    count: number;
    phase: "capturing" | "processing" | "done";
}

interface Inventory {
    mods: string[];
    arcanes: string[];
    prime_parts: string[];
    scanned_at?: string;
}

const RARITY_STYLES: Record<string, string> = {
    Common: "border-zinc-700 bg-zinc-900 text-zinc-300",
    Rare: "border-purple-400/60 bg-purple-500/10 text-purple-200",
    Uncommon: "border-gray-500 bg-gray-900 text-gray-200",
};

function AddPrimeModal({
                           allPrimeParts,
                           owned,
                           onAdd,
                           onClose,
                       }: {
    allPrimeParts: string[];
    owned: Set<string>;
    onAdd: (name: string) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const suggestions = query.trim().length >= 1
        ? allPrimeParts.filter((p) => p.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
        : allPrimeParts.slice(0, 50);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                className="flex flex-col w-120 max-h-[70vh] bg-gray-950 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                    <span className="text-sm font-semibold text-gray-200">Add prime part</span>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-lg leading-none">✕
                    </button>
                </div>

                {/* Search */}
                <div className="px-3 py-2 border-b border-gray-800">
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search..."
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
                    />
                </div>

                {/* List */}
                <div className="flex-1 overflow-auto">
                    {suggestions.map((name) => {
                        const isOwned = owned.has(name);
                        return (
                            <button
                                key={name}
                                onClick={() => {
                                    if (!isOwned) onAdd(name);
                                }}
                                disabled={isOwned}
                                className={`flex w-full items-center justify-between px-4 py-2 text-sm border-b border-gray-800/50 transition-colors ${
                                    isOwned
                                        ? "text-gray-600 cursor-default"
                                        : "text-gray-200 hover:bg-gray-800 cursor-pointer"
                                }`}
                            >
                                <span>{name}</span>
                                {isOwned && <span className="text-green-600 text-xs">✓ already owned</span>}
                            </button>
                        );
                    })}
                    {suggestions.length === 0 && (
                        <p className="px-4 py-3 text-sm text-gray-500">No results.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function InventoryPage() {
    const [activeTab, setActiveTab] = useState<ScanType>("mods");
    const [phase, setPhase] = useState<Phase>("idle");
    const [liveCount, setLiveCount] = useState(0);
    const [inventory, setInventory] = useState<Inventory>({mods: [], arcanes: [], prime_parts: []});
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [itemRarities, setItemRarities] = useState<Map<string, string>>(new Map());
    const [allPrimeParts, setAllPrimeParts] = useState<string[]>([]);
    const [showModal, setShowModal] = useState(false);
    const tabLabels: Record<ScanType, string> = {
        mods: "Mods",
        arcanes: "Arcanes",
        prime_parts: "Primes",
    };

    const loadInventory = useCallback(async () => {
        try {
            const raw = await invoke<string>("read_inventory");
            const parsed = JSON.parse(raw);
            setInventory({
                mods: parsed.mods ?? [],
                arcanes: parsed.arcanes ?? [],
                prime_parts: parsed.prime_parts ?? [],
                scanned_at: parsed.scanned_at,
            });
        } catch { /* file doesn't exist yet */
        }
    }, []);

    useEffect(() => {
        loadInventory();
        invoke<string>("read_prime_parts")
            .then((raw) => setAllPrimeParts(JSON.parse(raw)))
            .catch(() => {
            });
    }, [loadInventory]);

    useEffect(() => {
        invoke<string>("read_item_rarities").then((raw) => {
            try {
                const data = JSON.parse(raw) as Record<string, string>;
                setItemRarities(new Map(Object.entries(data)));
            } catch { /* ignore */
            }
        }).catch(() => {
        });
    }, []);

    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>("inventory-progress", async (event) => {
            const {count, phase: p} = event.payload;
            setLiveCount(count);
            setPhase(p);
            if (p === "done") {
                try {
                    await invoke("save_inventory_result");
                } catch { /* ignore */
                }
                await loadInventory();
                setPhase("idle");
            }
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            unlisten?.();
        };
    }, [loadInventory]);

    async function handleStart() {
        setError(null);
        setLiveCount(0);
        setPhase("capturing");
        try {
            await invoke("start_inventory_scan", {scanType: activeTab});
        } catch (e) {
            setError(String(e));
            setPhase("idle");
        }
    }

    async function handleStop() {
        setError(null);
        try {
            await invoke("stop_inventory_scan");
        } catch (e) {
            setError(String(e));
        }
    }

    async function addPrimePart(name: string) {
        if (inventory.prime_parts.includes(name)) return;
        const updated = [...inventory.prime_parts, name].sort();
        setInventory((prev) => ({...prev, prime_parts: updated}));
        await invoke("save_prime_parts", {parts: updated});
    }

    async function removePrimePart(name: string) {
        const updated = inventory.prime_parts.filter((p) => p !== name);
        setInventory((prev) => ({...prev, prime_parts: updated}));
        await invoke("save_prime_parts", {parts: updated});
    }

    const scanning = phase === "capturing";
    const processing = phase === "processing";
    const busy = scanning || processing;
    const canScan = activeTab !== "prime_parts";

    const rawList = activeTab === "mods" ? inventory.mods : activeTab === "arcanes" ? inventory.arcanes : inventory.prime_parts;
    const currentList = search.trim()
        ? rawList.filter((n) => n.toLowerCase().includes(search.toLowerCase()))
        : rawList;

    const statusText = () => {
        if (phase === "capturing") return `Capturing frames... ${liveCount} screens`;
        if (phase === "processing") return `Processing OCR... ${liveCount} items found`;
        return null;
    };

    const ownedSet = new Set(inventory.prime_parts);

    return (
        <div className="flex flex-col h-full p-4 gap-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Inventory</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Inventory of mods, arcanes and prime parts.
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-2">
                {(["mods", "arcanes", "prime_parts"] as ScanType[]).map((t) => (
                    <button
                        key={t}
                        onClick={() => {
                            if (!busy) {
                                setActiveTab(t);
                                setSearch("");
                            }
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeTab === t
                                ? "bg-purple-500/20 text-purple-400 border border-purple-500/40"
                                : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                        } ${busy && activeTab !== t ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                        {tabLabels[t]}
                    </button>
                ))}
            </div>

            {/* Controls */}
            {canScan && (
                <div className="flex items-center gap-3 flex-wrap">
                    {!busy ? (
                        <button
                            onClick={handleStart}
                            className="px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 text-gray-950 text-sm font-semibold transition-colors"
                        >
                            Start Scan
                        </button>
                    ) : scanning ? (
                        <button
                            onClick={handleStop}
                            className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
                        >
                            Stop Capture
                        </button>
                    ) : (
                        <button
                            disabled
                            className="px-4 py-2 rounded-lg bg-gray-700 text-gray-400 text-sm font-semibold cursor-not-allowed"
                        >
                            Processing...
                        </button>
                    )}
                    {statusText() && (
                        <span className="text-sm text-gray-300">
              {phase === "capturing" && <span className="text-purple-400 mr-1">●</span>}
                            {phase === "processing" && <span className="text-blue-400 mr-1">⟳</span>}
                            {statusText()}
            </span>
                    )}
                </div>
            )}

            {/* Primes controls */}
            {activeTab === "prime_parts" && (
                <button
                    onClick={() => setShowModal(true)}
                    className="self-start px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 text-gray-950 text-sm font-semibold transition-colors"
                >
                    + Add
                </button>
            )}

            {error && (
                <p className="text-red-400 text-xs bg-red-900/20 rounded px-3 py-2">{error}</p>
            )}

            {/* Search */}
            {rawList.length > 0 && (
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={activeTab === "prime_parts" ? "Filter added items..." : `Search ${tabLabels[activeTab].toLowerCase()}...`}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
            )}

            {/* Item list */}
            <div className="flex-1 overflow-auto">
                {activeTab === "prime_parts" ? (
                    inventory.prime_parts.length === 0 ? (
                        <p className="text-gray-500 text-sm">No prime parts added.</p>
                    ) : currentList.length === 0 && search.trim() ? (
                        <p className="text-gray-500 text-sm">No results.</p>
                    ) : (
                        <>
                            <p className="text-xs text-gray-500 mb-2">
                                {currentList.length}{search.trim() ? ` of ${inventory.prime_parts.length}` : ""} items
                            </p>
                            <div className="grid grid-cols-2 gap-1">
                                {currentList.map((name) => (
                                    <div
                                        key={name}
                                        className="flex items-center justify-between border border-gray-800 bg-gray-900 rounded px-3 py-1.5 text-sm text-gray-200 group"
                                    >
                                        <span className="truncate flex-1">{name}</span>
                                        <button
                                            onClick={() => removePrimePart(name)}
                                            className="ml-2 shrink-0 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                            title="Remove"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </>
                    )
                ) : (
                    <>
                        {inventory.scanned_at && (
                            <p className="text-xs text-gray-500 mb-2">
                                Last scan: {new Date(inventory.scanned_at).toLocaleString()}
                            </p>
                        )}
                        {currentList.length === 0 ? (
                            <p className="text-gray-500 text-sm">
                                {activeTab === "mods" ? "No mods scanned yet." : "No arcanes scanned yet."}
                            </p>
                        ) : (
                            <>
                                <p className="text-xs text-gray-500 mb-2">
                                    {currentList.length}{search.trim() ? ` of ${rawList.length}` : ""} items
                                </p>
                                <div className="grid grid-cols-2 gap-1">
                                    {currentList.map((name) => {
                                        const rarity = itemRarities.get(name.toLowerCase());
                                        const style = rarity && RARITY_STYLES[rarity]
                                            ? RARITY_STYLES[rarity]
                                            : "border-gray-800 bg-gray-900 text-gray-200";
                                        return (
                                            <div
                                                key={name}
                                                className={`border rounded px-3 py-1.5 text-sm truncate ${style}`}
                                                title={rarity ? `${name} (${rarity})` : name}
                                            >
                                                {name}
                                                {rarity && (
                                                    <span
                                                        className="ml-1 text-xs opacity-50">{rarity === "Rare" ? "★" : "◆"}</span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>

            {showModal && (
                <AddPrimeModal
                    allPrimeParts={allPrimeParts}
                    owned={ownedSet}
                    onAdd={addPrimePart}
                    onClose={() => setShowModal(false)}
                />
            )}
        </div>
    );
}
