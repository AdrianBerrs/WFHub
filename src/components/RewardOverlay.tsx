import {useEffect, useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {invoke} from "@tauri-apps/api/core";

interface RewardItem {
    name: string;
    platinum: number;
    is_best: boolean;
}

interface RewardPayload {
    timestamp: string;
    items: RewardItem[];
}

export default function RewardOverlay() {
    const [payload, setPayload] = useState<RewardPayload | null>(null);
    const [visible, setVisible] = useState(false);
    const [primeParts, setPrimeParts] = useState<Set<string>>(new Set());
    const [ownedParts, setOwnedParts] = useState<string[]>([]);
    const [selectedItem, setSelectedItem] = useState<string | null>(null);

    useEffect(() => {
        invoke<string>("read_prime_parts")
            .then((raw) => setPrimeParts(new Set(JSON.parse(raw))))
            .catch(() => {
            });
        invoke<string>("read_inventory")
            .then((raw) => setOwnedParts(JSON.parse(raw).prime_parts ?? []))
            .catch(() => {
            });
    }, []);

    useEffect(() => {
        const unlisten = listen<RewardPayload>("reward-detected", (event) => {
            setPayload(event.payload);
            setSelectedItem(null);
            setVisible(true);
        });

        const unlistenHide = listen("hide-overlay", () => {
            setVisible(false);
        });

        return () => {
            unlisten.then((f) => f());
            unlistenHide.then((f) => f());
        };
    }, []);

    async function handlePick(name: string) {
        if (selectedItem !== null) return; // já selecionou
        setSelectedItem(name);
        if (primeParts.has(name) && !ownedParts.includes(name)) {
            const updated = [...ownedParts, name].sort();
            setOwnedParts(updated);
            invoke("save_prime_parts", {parts: updated}).catch(() => {
            });
        }
    }

    if (!visible || !payload) return null;

    const sorted = [...payload.items].sort((a, b) =>
        a.is_best ? -1 : b.is_best ? 1 : b.platinum - a.platinum
    );

    const hasPicked = selectedItem !== null;

    return (
        <div className="p-3 w-full h-full">
            <div className="bg-gray-950/90 backdrop-blur-md border border-gray-700/60 rounded-2xl p-4 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse"/>
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
              Void Rewards
            </span>
                    </div>
                </div>

                {/* Hint */}
                <p className={`text-[10px] mb-3 transition-opacity duration-300 ${hasPicked ? "opacity-0" : "text-gray-600"}`}>
                    Clique no item que você pegou
                </p>

                {/* Items */}
                <div className="space-y-2">
                    {sorted.map((item, i) => {
                        const isPicked = selectedItem === item.name;
                        const isPrime = primeParts.has(item.name);
                        const wasOwned = ownedParts.includes(item.name) && isPicked;
                        const dimmed = hasPicked && !isPicked;

                        return (
                            <button
                                key={i}
                                onClick={() => handlePick(item.name)}
                                disabled={hasPicked}
                                className={`w-full flex items-center justify-between rounded-xl px-3 py-2 text-left transition-all duration-200 ${
                                    isPicked
                                        ? "bg-green-500/20 border border-green-500/50"
                                        : item.is_best
                                            ? "bg-purple-500/15 border border-purple-500/30 hover:bg-purple-500/25 cursor-pointer"
                                            : "bg-gray-800/50 hover:bg-gray-700/60 cursor-pointer"
                                } ${dimmed ? "opacity-40" : ""}`}
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    {isPicked ? (
                                        <span className="text-green-400 text-xs flex-shrink-0">✓</span>
                                    ) : item.is_best ? (
                                        <span className="text-purple-400 text-xs flex-shrink-0">🏆</span>
                                    ) : null}
                                    <span
                                        className={`text-sm truncate ${
                                            isPicked
                                                ? "text-green-200 font-medium"
                                                : item.is_best
                                                    ? "text-purple-100 font-medium"
                                                    : "text-gray-300"
                                        }`}
                                    >
                    {item.name}
                  </span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                    {isPicked && isPrime && !wasOwned && (
                                        <span className="text-[10px] text-green-400">adicionado</span>
                                    )}
                                    <span
                                        className={`text-sm font-bold ${
                                            isPicked ? "text-green-400" : item.is_best ? "text-purple-400" : "text-gray-400"
                                        }`}
                                    >
                    {item.platinum > 0 ? `${item.platinum}p` : "—"}
                  </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
