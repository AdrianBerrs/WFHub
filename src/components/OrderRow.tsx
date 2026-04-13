import {useState} from "react";

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
        <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200">{order.user.ingameName}</span>
                <span className="text-xs text-gray-500">rep: {order.user.reputation}</span>
                {order.rank !== undefined && (
                    <span className="rounded bg-indigo-900/60 px-1.5 py-0.5 text-xs text-indigo-300">
                        r{order.rank}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">x{order.quantity}</span>
                <span className="text-sm font-bold text-purple-400">{order.platinum}p</span>
                <button
                    onClick={copyWhisper}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600"
                >
                    {copied ? "✓ Copied" : buttonLabel}
                </button>
            </div>
        </div>
    );
}
