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
    headerBgClass = "bg-zinc-900/60",
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
                    <div key={id} className="overflow-hidden rounded-xl border border-[#1e1e2d] bg-[#111119] shadow-xl">
                        <button
                            onClick={() => toggleGroup(id)}
                            className={`flex w-full items-center justify-between border-b border-[#1e1e2d] ${headerBgClass} px-4 py-3 text-left transition-colors hover:bg-slate-950/70`}
                        >
                            <span className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-slate-200">
                                <span className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.65)]" />
                                {title}
                            </span>
                            <span className="flex items-center gap-2">
                                <span className="rounded border border-cyan-500/10 bg-cyan-950/20 px-2 py-0.5 font-mono text-[10px] font-bold text-cyan-300">
                                    {rows.length}
                                </span>
                                <span className="text-xs text-slate-400">{expanded ? "▲" : "▼"}</span>
                            </span>
                        </button>
                        {expanded && (
                            <div className="divide-y divide-slate-900/80 bg-[#111119]">
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
