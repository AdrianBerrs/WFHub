import {useState, useEffect, useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen, UnlistenFn} from "@tauri-apps/api/event";

type ForjaPhase = "idle" | "waiting" | "acting";

interface ForjaPayload {
    phase: ForjaPhase;
    count: number;
    item: string;
}

interface ForjaItem {
    key: string;
    label: string;
    cooldownSecs: number;
    description: string;
}

const FORJA_ITEMS: ForjaItem[] = [
    {
        key: "decodificador_1x",
        label: "Decodificador (1×)",
        cooldownSecs: 55,
        description: "Fabricação contínua de Decodificadores. Coleta e reinicia automaticamente ao terminar.",
    },
];

export default function ForjaPage() {
    const [selectedKey, setSelectedKey] = useState(FORJA_ITEMS[0].key);
    const [phase, setPhase] = useState<ForjaPhase>("idle");
    const [count, setCount] = useState(0);
    const [countdown, setCountdown] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const selectedItem = FORJA_ITEMS.find((i) => i.key === selectedKey)!;
    const running = phase !== "idle";

    function startCountdown(secs: number) {
        stopCountdown();
        setCountdown(secs);
        countdownRef.current = setInterval(() => {
            setCountdown((prev) => {
                if (prev <= 1) {
                    stopCountdown();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }

    function stopCountdown() {
        if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
        }
    }

    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ForjaPayload>("forja-status", (event) => {
            const {phase: p, count: c} = event.payload;
            setPhase(p);
            setCount(c);
            if (p === "waiting") {
                const item = FORJA_ITEMS.find((i) => i.key === event.payload.item);
                startCountdown(item?.cooldownSecs ?? 55);
            }
            if (p === "acting") stopCountdown();
            if (p === "idle") {
                stopCountdown();
                setCountdown(0);
            }
        }).then((fn) => {
            unlisten = fn;
        });
        return () => {
            unlisten?.();
            stopCountdown();
        };
    }, []);

    async function handleStart() {
        setError(null);
        try {
            await invoke("start_forja", {itemKey: selectedKey});
            setPhase("waiting");
            setCount(0);
            startCountdown(selectedItem.cooldownSecs);
        } catch (e) {
            setError(String(e));
        }
    }

    async function handleStop() {
        setError(null);
        try {
            await invoke("stop_forja");
        } catch (e) {
            setError(String(e));
        }
    }

    const countdownPct = countdown > 0
        ? Math.round((countdown / selectedItem.cooldownSecs) * 100)
        : 0;

    return (
        <div className="flex flex-col h-full p-4 gap-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Forja</h1>
                <p className="text-sm text-gray-500">Itens para craft automático</p>
            </div>

            {/* Item selector */}
            <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-4">
                    {FORJA_ITEMS.map((item) => (
                        <button
                            key={item.key}
                            onClick={() => !running && setSelectedKey(item.key)}
                            className={`text-left px-4 py-3 rounded-lg border transition-colors ${
                                selectedKey === item.key
                                    ? "border-purple-500/60 bg-purple-500/10 text-purple-200"
                                    : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"
                            } ${running ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        >
                            <p className="text-sm font-medium">{item.label}</p>
                            <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
                        </button>
                    ))}
                </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-3">
                {!running ? (
                    <button
                        onClick={handleStart}
                        className="px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 text-gray-950 text-sm font-semibold transition-colors"
                    >
                        Iniciar Monitor
                    </button>
                ) : (
                    <button
                        onClick={handleStop}
                        className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
                    >
                        Parar Monitor
                    </button>
                )}

                {phase === "waiting" && (
                    <span className="text-sm text-gray-300 flex items-center gap-1.5">
            <span className="text-purple-400">●</span>
            Aguardando item pronto...
          </span>
                )}
                {phase === "acting" && (
                    <span className="text-sm text-gray-300 flex items-center gap-1.5">
            <span className="text-blue-400">⟳</span>
            Executando automação...
          </span>
                )}
            </div>

            {error && (
                <p className="text-red-400 text-xs bg-red-900/20 rounded px-3 py-2">{error}</p>
            )}

            {/* Status card */}
            {running && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-400">Fabricações concluídas</span>
                        <span className="text-2xl font-bold text-purple-400">{count}</span>
                    </div>

                    {phase === "waiting" && countdown > 0 && (
                        <div className="flex flex-col gap-1.5">
                            <div className="flex justify-between text-xs text-gray-500">
                                <span>Próximo em</span>
                                <span>{countdown}s</span>
                            </div>
                            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-purple-500 rounded-full transition-all duration-1000"
                                    style={{width: `${countdownPct}%`}}
                                />
                            </div>
                        </div>
                    )}

                    {phase === "acting" && (
                        <p className="text-xs text-blue-400">Coletando e reiniciando fabricação...</p>
                    )}
                </div>
            )}
        </div>
    );
}
