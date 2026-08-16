import { useState } from "react";
export interface TopOrders {
    sell: Order[];
    buy: Order[];
}

export interface OrderUser {
    ingameName: string;
    reputation: number;
    status: string;
}

export interface Order {
    platinum: number;
    quantity: number;
    rank?: number;
    user: OrderUser;
}

export function OrderRow({
    order,
    itemName,
    buttonLabel = "Copy whisper",
}: {
    order: Order;
    itemName: string;
    buttonLabel?: string;
}) {
    const [copied, setCopied] = useState(false);

    async function copyWhisper() {
        const itemDesc = order.rank !== undefined ? `${itemName} (rank ${order.rank})` : itemName;
        const msg = `/w ${order.user.ingameName} Hi! I want to buy: ${itemDesc} for ${order.platinum} platinum. (warframe.market)`;
        await navigator.clipboard.writeText(msg);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    return (
        <div className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-slate-950/35">
            <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-bold text-slate-200">{order.user.ingameName}</span>
                <span className="font-mono text-[10px] text-slate-500">Rep: {order.user.reputation}</span>
                {order.rank !== undefined && (
                    <span className="rounded border border-[#ed9a3d]/20 bg-[#ed9a3d]/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#ed9a3d]">
                        R{order.rank}
                    </span>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
                <span className="font-mono text-[10px] text-slate-500">x{order.quantity}</span>
                <span className="flex items-center text-sm font-black text-amber-400">
                    {order.platinum}
                    <img src="/icons/PlatinumLarge.webp" alt="Platinum" className="ml-1 inline-block h-4 w-4" />
                </span>
                <button
                    onClick={copyWhisper}
                    className={`rounded-md border px-2 py-1 font-mono text-[10px] font-bold transition-all ${
                        copied
                            ? "border-emerald-500/30 bg-emerald-950/60 text-emerald-300"
                            : "border-slate-800 bg-slate-900 text-slate-200 hover:bg-slate-800"
                    }`}
                >
                    {copied ? "Copiado" : buttonLabel}
                </button>
            </div>
        </div>
    );
}
