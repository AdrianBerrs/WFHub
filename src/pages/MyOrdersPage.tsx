import {useEffect, useState} from "react";
import {useNavigate} from "react-router-dom";
import {invoke} from "@tauri-apps/api/core";
import {ArrowLeft, CheckCircle, Eye, EyeOff, Pencil, RefreshCw, ShoppingCart, Trash2, X} from "lucide-react";

interface OrderItem {
    id: string;
    slug: string;
    name: string;
}

interface Order {
    id: string;
    type: "sell" | "buy";
    platinum: number;
    quantity: number;
    perTrade: number;
    visible: boolean;
    rank?: number | null;
    item: OrderItem;
    createdAt?: string;
}

interface EditState {
    platinum: number;
    quantity: number;
    visible: boolean;
    rank: number | null;
}

type WfmStatus = "online" | "ingame" | "invisible";

const STATUS_OPTIONS: { value: WfmStatus; label: string }[] = [
    {value: "online", label: "Online"},
    {value: "ingame", label: "In Game"},
    {value: "invisible", label: "Offline"},
];

export default function MyOrdersPage() {
    const navigate = useNavigate();
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [activeStatus, setActiveStatus] = useState<WfmStatus>("ingame");
    const [onlineStatus, setOnlineStatus] = useState<"idle" | "setting" | "ok" | "error">("idle");
    const [onlineError, setOnlineError] = useState<string | null>(null);

    const [editingId, setEditingId] = useState<string | null>(null);
    const [editState, setEditState] = useState<EditState | null>(null);
    const [editSaving, setEditSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);

    const [closingId, setClosingId] = useState<string | null>(null);
    const [closeQty, setCloseQty] = useState(1);
    const [closeSubmitting, setCloseSubmitting] = useState(false);
    const [closeError, setCloseError] = useState<string | null>(null);

    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    async function setStatus(status: WfmStatus) {
        setOnlineStatus("setting");
        setOnlineError(null);
        try {
            await invoke("wfmarket_set_status", {status});
            setActiveStatus(status);
            setOnlineStatus("ok");
        } catch (e) {
            setOnlineStatus("error");
            setOnlineError(String(e));
        }
    }

    useEffect(() => {
        invoke<string>("wfmarket_read_auth")
            .then((raw) => {
                const parsed = JSON.parse(raw);
                if (parsed.jwt) {
                    setIsLoggedIn(true);
                    fetchOrders();
                    setStatus("ingame");
                }
            })
            .catch(() => {});
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    async function fetchOrders() {
        setLoading(true);
        setError(null);
        try {
            const raw = await invoke<string>("wfmarket_get_orders");
            const json = JSON.parse(raw);
            const list: Order[] = json?.data ?? [];
            setOrders(list.filter((o) => o.type === "sell"));
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }

    function startEdit(order: Order) {
        setEditingId(order.id);
        setEditState({
            platinum: order.platinum,
            quantity: order.quantity,
            visible: order.visible,
            rank: order.rank ?? null,
        });
        setEditError(null);
    }

    async function submitEdit() {
        if (!editingId || !editState) return;
        setEditSaving(true);
        setEditError(null);
        try {
            const raw = await invoke<string>("wfmarket_update_order", {
                id: editingId,
                platinum: editState.platinum,
                quantity: editState.quantity,
                visible: editState.visible,
                rank: editState.rank ?? undefined,
            });
            const json = JSON.parse(raw);
            const updated: Order = json?.data;
            if (updated) {
                setOrders((prev) => prev.map((o) => (o.id === editingId ? {...o, ...updated} : o)));
            }
            setEditingId(null);
            setEditState(null);
        } catch (e) {
            setEditError(String(e));
        } finally {
            setEditSaving(false);
        }
    }

    function startClose(order: Order) {
        setClosingId(order.id);
        setCloseQty(order.quantity);
        setCloseError(null);
    }

    async function submitClose() {
        if (!closingId) return;
        setCloseSubmitting(true);
        setCloseError(null);
        try {
            await invoke<string>("wfmarket_close_order", {id: closingId, quantity: closeQty});
            setOrders((prev) => {
                return prev
                    .map((o) => {
                        if (o.id !== closingId) return o;
                        const remaining = o.quantity - closeQty;
                        return remaining > 0 ? {...o, quantity: remaining} : null;
                    })
                    .filter(Boolean) as Order[];
            });
            setClosingId(null);
        } catch (e) {
            setCloseError(String(e));
        } finally {
            setCloseSubmitting(false);
        }
    }

    async function handleDelete(id: string) {
        setDeletingId(id);
        try {
            await invoke<string>("wfmarket_delete_order", {id});
            setOrders((prev) => prev.filter((o) => o.id !== id));
        } catch (e) {
            setError(String(e));
        } finally {
            setDeletingId(null);
        }
    }

    const sellOrders = orders.filter((o) => o.type === "sell");

    return (
        <div className="wf-page space-y-5">
            <div className="wf-panel flex items-center justify-between gap-3 p-5">
                <div>
                    <button
                        onClick={() => navigate("/market")}
                        className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-400 transition-colors hover:text-cyan-300"
                    >
                        <ArrowLeft size={13} />
                        Back to Market
                    </button>
                    <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                        <ShoppingCart size={20} className="text-cyan-400" />
                        My Orders
                    </h1>
                    <p className="mt-1 text-xs text-slate-400">
                        Manage your active sell orders on warframe.market.
                    </p>
                </div>
                {isLoggedIn && (
                    <div className="flex items-center gap-2">
                        <div
                            title={onlineError ?? "Set your warframe.market status"}
                            className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1"
                        >
                            {STATUS_OPTIONS.map((opt) => {
                                const isActive = activeStatus === opt.value;
                                const accent =
                                    opt.value === "online"
                                        ? "bg-emerald-950/60 text-emerald-400 border-emerald-500/30"
                                        : opt.value === "ingame"
                                        ? "bg-amber-950/60 text-amber-400 border-amber-500/30"
                                        : "bg-slate-800 text-slate-400 border-slate-700";
                                return (
                                    <button
                                        key={opt.value}
                                        onClick={() => setStatus(opt.value)}
                                        disabled={onlineStatus === "setting"}
                                        className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                                            isActive ? accent : "border-transparent text-slate-500 hover:text-slate-300"
                                        }`}
                                    >
                                        {onlineStatus === "setting" && isActive ? "..." : opt.label}
                                    </button>
                                );
                            })}
                        </div>
                        <button
                            onClick={fetchOrders}
                            disabled={loading}
                            className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-700 hover:text-white disabled:opacity-50"
                        >
                            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                            Refresh
                        </button>
                    </div>
                )}
            </div>

            {!isLoggedIn && (
                <div className="wf-card p-8 text-center">
                    <ShoppingCart size={32} className="mx-auto mb-3 text-slate-600" />
                    <p className="text-sm text-slate-400">
                        Connect your warframe.market account in{" "}
                        <span className="text-cyan-400">Settings</span> to manage orders.
                    </p>
                </div>
            )}

            {error && (
                <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                    {error}
                </div>
            )}

            {isLoggedIn && !loading && sellOrders.length === 0 && !error && (
                <div className="wf-card p-8 text-center">
                    <p className="text-sm text-slate-500">No active sell orders.</p>
                </div>
            )}

            {sellOrders.length > 0 && (
                <div className="wf-card overflow-hidden p-0">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-slate-800 text-left">
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Item</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Plat</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Qty</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Min</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Rank</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500">Status</th>
                                <th className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                            {sellOrders.map((order) => {
                                const isEditing = editingId === order.id;
                                const isDeleting = deletingId === order.id;
                                return (
                                    <tr key={order.id} className="transition-colors hover:bg-slate-900/30">
                                        <td className="px-4 py-3 font-semibold text-slate-200">
                                            {order.item?.name ?? order.item?.slug ?? "—"}
                                        </td>

                                        {isEditing && editState ? (
                                            <>
                                                <td className="px-4 py-2">
                                                    <input
                                                        type="number"
                                                        min={1}
                                                        value={editState.platinum}
                                                        onChange={(e) => setEditState({...editState, platinum: Number(e.target.value)})}
                                                        className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                                                    />
                                                </td>
                                                <td className="px-4 py-2">
                                                    <input
                                                        type="number"
                                                        min={1}
                                                        value={editState.quantity}
                                                        onChange={(e) => setEditState({...editState, quantity: Number(e.target.value)})}
                                                        className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                                                    />
                                                </td>
                                                <td className="px-4 py-2">
                                                    {editState.rank !== null ? (
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            value={editState.rank}
                                                            onChange={(e) => setEditState({...editState, rank: Number(e.target.value)})}
                                                            className="w-14 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none"
                                                        />
                                                    ) : (
                                                        <span className="text-slate-600">—</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2">
                                                    <button
                                                        onClick={() => setEditState({...editState, visible: !editState.visible})}
                                                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold transition-colors ${
                                                            editState.visible
                                                                ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                                                                : "bg-slate-800 text-slate-500 hover:bg-slate-700"
                                                        }`}
                                                    >
                                                        {editState.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                                                        {editState.visible ? "Visible" : "Hidden"}
                                                    </button>
                                                </td>
                                                <td className="px-4 py-2">
                                                    <div className="flex items-center gap-1.5">
                                                        {editError && (
                                                            <span className="text-xs text-red-400">{editError}</span>
                                                        )}
                                                        <button
                                                            onClick={submitEdit}
                                                            disabled={editSaving}
                                                            className="rounded bg-cyan-500/20 px-2 py-1 text-xs font-bold text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
                                                        >
                                                            {editSaving ? "..." : "Save"}
                                                        </button>
                                                        <button
                                                            onClick={() => { setEditingId(null); setEditState(null); }}
                                                            className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-400 hover:bg-slate-700"
                                                        >
                                                            <X size={12} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </>
                                        ) : (
                                            <>
                                                <td className="px-4 py-3 font-mono text-emerald-400">
                                                    {order.platinum}p
                                                </td>
                                                <td className="px-4 py-3 text-slate-300">{order.quantity}</td>
                                                <td className="px-4 py-3 text-slate-400">{order.perTrade}</td>
                                                <td className="px-4 py-3 text-slate-400">
                                                    {order.rank != null ? `r${order.rank}` : "—"}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold ${
                                                        order.visible
                                                            ? "bg-emerald-500/15 text-emerald-400"
                                                            : "bg-slate-800 text-slate-500"
                                                    }`}>
                                                        {order.visible ? <Eye size={9} /> : <EyeOff size={9} />}
                                                        {order.visible ? "Visible" : "Hidden"}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-1.5">
                                                        <button
                                                            onClick={() => startEdit(order)}
                                                            className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-cyan-400"
                                                            title="Edit"
                                                        >
                                                            <Pencil size={13} />
                                                        </button>
                                                        <button
                                                            onClick={() => startClose(order)}
                                                            className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-emerald-400"
                                                            title="Mark sold"
                                                        >
                                                            <CheckCircle size={13} />
                                                        </button>
                                                        <button
                                                            onClick={() => setConfirmDeleteId(order.id)}
                                                            disabled={isDeleting}
                                                            className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-red-400 disabled:opacity-40"
                                                            title="Delete"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Delete confirmation modal */}
            {confirmDeleteId && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                    onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
                >
                    <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-red-500/20 bg-[#111119] p-5 shadow-2xl">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-950/40">
                                <Trash2 size={16} className="text-red-400" />
                            </div>
                            <div>
                                <h2 className="text-sm font-semibold text-slate-100">Delete order</h2>
                                <p className="text-xs text-slate-400 mt-0.5">This action cannot be undone.</p>
                            </div>
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed">
                            Are you sure you want to permanently delete this sell order?
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => {
                                    const id = confirmDeleteId;
                                    setConfirmDeleteId(null);
                                    handleDelete(id);
                                }}
                                disabled={deletingId === confirmDeleteId}
                                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                            >
                                {deletingId === confirmDeleteId ? "Deleting..." : "Delete"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Close order modal */}
            {closingId && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                    onMouseDown={(e) => { if (e.target === e.currentTarget) setClosingId(null); }}
                >
                    <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-2xl">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-semibold text-slate-100">Mark as Sold</h2>
                            <button onClick={() => setClosingId(null)} className="text-slate-500 hover:text-slate-200">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-xs text-slate-400">Quantity sold</label>
                            <input
                                type="number"
                                min={1}
                                value={closeQty}
                                onChange={(e) => setCloseQty(Number(e.target.value))}
                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary-500 focus:outline-none"
                            />
                        </div>
                        {closeError && <p className="text-xs text-red-400">{closeError}</p>}
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setClosingId(null)}
                                className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={submitClose}
                                disabled={closeSubmitting || closeQty < 1}
                                className="rounded-lg bg-primary-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-primary-400 disabled:opacity-50"
                            >
                                {closeSubmitting ? "Closing..." : "Confirm"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
