import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface TradePayload {
  items: string[];
  buyer: string;
  platinum: number;
}

function deduceSetName(items: string[]): string | null {
  if (items.length === 1) return null;

  for (const part of items) {
    const suffixes = [" Neuroptics Blueprint", " Chassis Blueprint", " Systems Blueprint", " Harness Blueprint", " Carapace Blueprint"];
    for (const suffix of suffixes) {
      if (part.endsWith(suffix)) {
        const base = part.slice(0, -suffix.length).trim();
        if (items.some((p) => p.includes(base) && p !== part)) {
          return `${base} Set`;
        }
      }
    }
  }

  const firstBP = items[0].replace(" Blueprint", "");
  const warframeSuffixes = [" Neuroptics", " Chassis", " Systems", " Harness", " Carapace"];
  let base = firstBP;
  for (const s of warframeSuffixes) {
    if (firstBP.endsWith(s)) {
      base = firstBP.slice(0, -s.length).trim();
      break;
    }
  }
  if (base !== firstBP && items.every((p) => p.includes(base))) {
    return `${base} Set`;
  }

  return items.join(", ");
}

export default function TradeSuccessOverlay() {
  const [payload, setPayload] = useState<TradePayload | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<"success" | "error" | null>(null);
  const wasVisible = useRef(false);

  useEffect(() => {
    const unlisten = listen<TradePayload>("trade-success", (event) => {
      wasVisible.current = true;
      setPayload(event.payload);
      setResult(null);
      setIsProcessing(false);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Quando o card some (Ignorar, OK após sucesso ou timeout), esconde a janela
  // do overlay — senão ela continua transparente por cima do jogo capturando o mouse.
  useEffect(() => {
    if (payload === null && wasVisible.current) {
      wasVisible.current = false;
      invoke("hide_overlay_window").catch(() => {});
    }
  }, [payload]);

  const handleConfirm = async () => {
    if (!payload) return;
    setIsProcessing(true);
    setResult(null);
    try {
      const isSet = payload.items.length > 1;
      const itemName = isSet ? deduceSetName(payload.items)! : payload.items[0];
      await invoke("wfmarket_confirm_trade", { itemName });
      setResult("success");
      setTimeout(() => setPayload(null), 2000);
    } catch (error) {
      console.error("Erro ao fechar ordem:", error);
      setResult("error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDismiss = () => setPayload(null);

  useEffect(() => {
    if (!payload) return;
    const timeout = setTimeout(() => setPayload(null), 12000);
    return () => clearTimeout(timeout);
  }, [payload]);

  if (!payload) return null;

  const isSet = payload.items.length > 1;
  const itemLabel = isSet ? deduceSetName(payload.items)! : payload.items[0];

  return (
    <div className="w-full h-full flex items-end justify-end p-3 pointer-events-none">
      <div className="pointer-events-auto bg-zinc-900/90 backdrop-blur-md border border-green-500/30 rounded-xl shadow-2xl px-4 py-3 w-full max-w-md animate-in fade-in duration-300">
        {/* Top row: icon + title + plat + buyer */}
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
            <span className="text-green-400 text-sm font-bold">$</span>
          </div>
          <span className="text-sm font-bold text-green-100 truncate">{itemLabel}</span>
          <span className="ml-auto flex items-center gap-1 text-sm font-bold text-yellow-400 shrink-0">
            +{payload.platinum}
            <img src="/icons/PlatinumLarge.webp" alt="p" className="w-3.5 h-3.5 object-contain" />
          </span>
          <span className="text-xs text-zinc-500 shrink-0">
            para <span className="text-zinc-300">{payload.buyer}</span>
          </span>
        </div>

        {/* Bottom row: details + buttons */}
        <div className="flex items-center gap-2">
          {isSet && (
            <details className="text-[10px] text-zinc-500 shrink-0">
              <summary className="cursor-pointer hover:text-zinc-300">{payload.items.length} itens</summary>
              <ul className="mt-0.5 space-y-0.5">
                {payload.items.map((item, i) => (
                  <li key={i} className="truncate max-w-[180px]">{item}</li>
                ))}
              </ul>
            </details>
          )}

          {result === "success" && (
            <span className="text-green-400 text-xs font-medium">Ordem fechada!</span>
          )}
          {result === "error" && (
            <span className="text-red-400 text-xs">Erro. Veja My Orders.</span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={handleDismiss}
              disabled={isProcessing}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors disabled:opacity-50"
            >
              {result === "success" ? "OK" : "Ignorar"}
            </button>
            {result !== "success" && (
              <button
                onClick={handleConfirm}
                disabled={isProcessing}
                className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                {isProcessing ? "..." : `Fechar ordem${isSet ? " do set" : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
