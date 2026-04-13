import {useState} from "react";
import {OrderRow, type Order} from "./OrderRow";

export interface MarketGroup {
    id: string;
    title: string;
    orders: { sell: Order[]; buy: Order[] } | null;
}

export function MarketResults({
    groups,
    itemName,
    containerClass,
    headerBgClass = "bg-gray-900/60",
    buttonLabel = "Copy whisper",
}: {
    groups: MarketGroup[];
    itemName: string;
    containerClass: string;
    headerBgClass?: string;
    buttonLabel?: string;
}) {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    function isOpen(key: string) {
        return !collapsed[key];
    }

    function toggleGroup(key: string) {
        setCollapsed((prev) => ({...prev, [key]: !prev[key]}));
    }

    return (
        <div className={containerClass}>
            {groups.map(({id, title, orders}) => {
                const expanded = isOpen(id);
                const rows = orders?.sell ?? [];
                return (
                    <div key={id}>
                        <button
                            onClick={() => toggleGroup(id)}
                            className={`flex w-full items-center justify-between border border-gray-800 ${headerBgClass} px-3 py-2 text-left hover:bg-gray-800/60 transition-colors ${expanded ? "rounded-t-lg" : "rounded-lg"}`}
                        >
                            <span className="text-sm font-semibold text-gray-200">{title}</span>
                            <span className="flex items-center gap-2">
                                <span className="text-xs text-gray-500">{rows.length}</span>
                                <span className="text-xs text-gray-400">{expanded ? "▲" : "▼"}</span>
                            </span>
                        </button>
                        {expanded && (
                            <div className="overflow-hidden rounded-b-lg border-x border-b border-gray-800 bg-gray-900 divide-y divide-gray-800/70">
                                {rows.map((o, i) => (
                                    <OrderRow key={i} order={o} itemName={itemName} buttonLabel={buttonLabel}/>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
