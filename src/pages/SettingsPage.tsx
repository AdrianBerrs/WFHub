import {useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {Database, Eye, FileText, Plug, Search, Sliders, Tag, Wrench} from "lucide-react";

type ShellAction = "run_update_script" | "update_prices";

interface ShellCommandResult {
    success: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
}

interface ActionCard {
    key: ShellAction;
    title: string;
    description: string;
    buttonLabel: string;
    confirmTitle: string;
    confirmMessage: string;
}

interface HubStateFile {
    refresh_seconds: number;
}

interface WfMarketAuth {
    jwt: string;
    username: string;
}

const ACTIONS: ActionCard[] = [
    {
        key: "run_update_script",
        title: "Update datasets",
        description: "Runs update.sh at the project root to download and regenerate data.",
        buttonLabel: "Run update.sh",
        confirmTitle: "Confirm update",
        confirmMessage: "This will run update.sh and overwrite local data files. Do you want to continue?",
    },
    {
        key: "update_prices",
        title: "Update prices",
        description: "Downloads the latest prices from warframe.market via warframestat.us. The overlay will use the new prices immediately on the next detection.",
        buttonLabel: "Update prices.json",
        confirmTitle: "Confirm price update",
        confirmMessage: "This will download and overwrite prices.json with current warframe.market prices. Do you want to continue?",
    },
];

function SectionHeader({icon: Icon, title, subtitle}: {icon: any; title: string; subtitle?: string}) {
    return (
        <div className="flex items-center gap-2 pl-1">
            <Icon size={14} className="text-cyan-400" />
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-300">{title}</h2>
            {subtitle && <span className="text-[11px] text-slate-500">— {subtitle}</span>}
        </div>
    );
}

export default function SettingsPage() {
    const [hubRefresh, setHubRefresh] = useState(60);
    const [hubSaving, setHubSaving] = useState(false);
    const [running, setRunning] = useState<ShellAction | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<ShellAction | null>(null);
    const [lastResult, setLastResult] = useState<{
        action: ShellAction;
        result: ShellCommandResult;
    } | null>(null);
    const [progressLines, setProgressLines] = useState<string[]>([]);
    const progressRef = useRef<HTMLPreElement>(null);

    const [marketAuth, setMarketAuth] = useState<WfMarketAuth | null>(null);
    const [jwtInput, setJwtInput] = useState("");
    const [jwtSaving, setJwtSaving] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);

    const [logPath, setLogPath] = useState("");
    const [logPathSaving, setLogPathSaving] = useState(false);
    const [logPathDetecting, setLogPathDetecting] = useState(false);
    const [logPathMessage, setLogPathMessage] = useState<string | null>(null);


    async function handleRun(action: ShellAction) {
        setRunning(action);
        setError(null);
        setProgressLines([]);
        setLastResult(null);

        const unlisten = await listen<{action: string; line: string; done: boolean}>("shell-progress", (event) => {
            if (event.payload.action !== action) return;
            if (event.payload.done) return;
            setProgressLines((prev) => [...prev, event.payload.line]);
        });

        try {
            const result = await invoke<ShellCommandResult>("run_shell_action", {action});
            setLastResult({action, result});
        } catch (e) {
            setError(String(e));
        } finally {
            unlisten();
            setRunning(null);
        }
    }

    useEffect(() => {
        invoke<string>("read_hub_state")
            .then((raw) => {
                const parsed: HubStateFile = JSON.parse(raw);
                setHubRefresh(parsed.refresh_seconds);
            })
            .catch(() => {});
        invoke<string>("wfmarket_read_auth")
            .then((raw) => {
                const parsed: WfMarketAuth = JSON.parse(raw);
                setMarketAuth(parsed.jwt ? parsed : null);
            })
            .catch(() => {});
        invoke<string>("read_config")
            .then((raw) => {
                const parsed = JSON.parse(raw);
                setLogPath(typeof parsed.log_path === "string" ? parsed.log_path : "");
            })
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (progressRef.current) {
            progressRef.current.scrollTop = progressRef.current.scrollHeight;
        }
    }, [progressLines]);

    async function handleSaveJwt() {
        setJwtSaving(true);
        setLoginError(null);
        try {
            const raw = await invoke<string>("wfmarket_save_jwt", {jwt: jwtInput.trim()});
            setMarketAuth(JSON.parse(raw));
            setJwtInput("");
        } catch (e) {
            setLoginError(String(e));
        } finally {
            setJwtSaving(false);
        }
    }

    async function handleLogout() {
        await invoke("wfmarket_logout");
        setMarketAuth(null);
    }


    async function saveHubRefresh() {
        setHubSaving(true);
        setError(null);
        try {
            const raw = await invoke<string>("save_hub_settings", {refreshSeconds: hubRefresh});
            const parsed: HubStateFile = JSON.parse(raw);
            setHubRefresh(parsed.refresh_seconds);
        } catch (e) {
            setError(String(e));
        } finally {
            setHubSaving(false);
        }
    }

    async function handleSaveLogPath() {
        setLogPathSaving(true);
        setLogPathMessage(null);
        try {
            const raw = await invoke<string>("save_log_path", {path: logPath});
            const parsed = JSON.parse(raw);
            setLogPath(typeof parsed.log_path === "string" ? parsed.log_path : "");
            setLogPathMessage("Saved. The monitor will reconnect automatically.");
        } catch (e) {
            setLogPathMessage(String(e));
        } finally {
            setLogPathSaving(false);
        }
    }

    async function handleDetectLogPath() {
        setLogPathDetecting(true);
        setLogPathMessage(null);
        try {
            const found = await invoke<string | null>("detect_log_path");
            if (found) {
                setLogPath(found);
                setLogPathMessage("EE.log found. Click Save to apply.");
            } else {
                setLogPathMessage("EE.log not found automatically. Set the path manually.");
            }
        } catch (e) {
            setLogPathMessage(String(e));
        } finally {
            setLogPathDetecting(false);
        }
    }

    const pendingConfig = pendingAction
        ? ACTIONS.find((item) => item.key === pendingAction) ?? null
        : null;

    return (
        <div className="wf-page space-y-6">

            <div className="wf-panel flex items-center gap-3 p-5">
                <Sliders size={20} className="text-slate-400" />
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-slate-100">Settings & System</h1>
                    <p className="mt-1 text-xs text-slate-400">
                        Configure Hub refresh, Market integration and maintenance scripts.
                    </p>
                </div>
            </div>

            {/* ── Integrations ─────────────────────────────────────────── */}
            <section className="space-y-3">
                <SectionHeader icon={Plug} title="Integrations"/>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="wf-card flex flex-col gap-3 p-5">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-sm font-semibold text-slate-100">Hub refresh interval</h3>
                            <p className="text-xs text-slate-400">
                                How often the Hub fetches new worldstate data (15s – 600s).
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                min={15}
                                max={600}
                                value={hubRefresh}
                                onChange={(e) => setHubRefresh(Number(e.target.value || 60))}
                                className="w-24 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary-500 focus:outline-none"
                            />
                            <span className="text-xs text-slate-400">seconds</span>
                            <button
                                onClick={saveHubRefresh}
                                disabled={hubSaving}
                                className="ml-auto rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-4 py-2 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60 disabled:opacity-50"
                            >
                                {hubSaving ? "Saving..." : "Save"}
                            </button>
                        </div>
                    </div>

                    <div className="wf-card flex flex-col gap-3 p-5">
                        <div className="flex items-start justify-between gap-3">
                            <div className="flex flex-col gap-1">
                                <h3 className="text-sm font-semibold text-slate-100">Warframe Market</h3>
                                <p className="text-xs text-slate-400">
                                    Log in to create sell orders directly from Inventory and Market pages.
                                </p>
                            </div>
                            {marketAuth && (
                                <span className="shrink-0 rounded-md bg-emerald-950/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                                    Connected
                                </span>
                            )}
                        </div>

                        {marketAuth ? (
                            <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/60 bg-slate-950/40 px-3 py-2">
                                <span className="text-xs text-slate-300">
                                    Logged in
                                </span>
                                <button
                                    onClick={handleLogout}
                                    className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700"
                                >
                                    Log out
                                </button>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-slate-400">
                                    Go to <span className="text-cyan-400">warframe.market</span>, sign in, open
                                    DevTools (F12) → Application → Cookies →{" "}
                                    <code className="rounded bg-slate-800 px-1 text-emerald-400">warframe.market</code>{" "}
                                    → copy the{" "}
                                    <code className="rounded bg-slate-800 px-1 text-emerald-400">JWT</code> cookie value.
                                </p>
                                <textarea
                                    rows={3}
                                    value={jwtInput}
                                    onChange={(e) => setJwtInput(e.target.value)}
                                    placeholder="Paste the JWT cookie value here..."
                                    disabled={jwtSaving}
                                    className="custom-scrollbar resize-none rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-100 focus:border-primary-500 focus:outline-none disabled:opacity-50"
                                />
                                {loginError && <p className="text-xs text-red-400">{loginError}</p>}
                                <button
                                    onClick={handleSaveJwt}
                                    disabled={jwtSaving || !jwtInput.trim()}
                                    className="self-end rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-4 py-2 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60 disabled:opacity-50"
                                >
                                    {jwtSaving ? "Verifying..." : "Connect"}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </section>

            {/* ── Warframe ─────────────────────────────────────────────── */}
            <section className="space-y-3">
                <SectionHeader icon={FileText} title="Warframe" subtitle="EE.log monitor"/>
                <div className="wf-card flex flex-col gap-3 p-5">
                    <div className="flex flex-col gap-1">
                        <h3 className="text-sm font-semibold text-slate-100">EE.log path</h3>
                        <p className="text-xs text-slate-400">
                            Used to detect reward screens and successful trades. Paste the full path to your Warframe EE.log.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={logPath}
                            onChange={(e) => setLogPath(e.target.value)}
                            placeholder="/path/to/Warframe/EE.log"
                            className="flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-100 focus:border-primary-500 focus:outline-none"
                        />
                        <button
                            onClick={handleDetectLogPath}
                            disabled={logPathDetecting}
                            className="flex shrink-0 items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs font-bold text-slate-200 transition-colors hover:bg-slate-700/60 disabled:opacity-50"
                        >
                            <Search size={13}/>
                            {logPathDetecting ? "Detecting..." : "Detect"}
                        </button>
                        <button
                            onClick={handleSaveLogPath}
                            disabled={logPathSaving || !logPath.trim()}
                            className="shrink-0 rounded-lg border border-cyan-500/20 bg-cyan-950/40 px-4 py-2 text-xs font-bold text-cyan-300 transition-colors hover:bg-cyan-950/60 disabled:opacity-50"
                        >
                            {logPathSaving ? "Saving..." : "Save"}
                        </button>
                    </div>
                    {logPathMessage && <p className="text-xs text-slate-400">{logPathMessage}</p>}
                </div>
            </section>

            {/* ── Tests ─────────────────────────────────────────────────── */}
            <section className="space-y-3">
                <SectionHeader icon={Eye} title="Tests"/>
                <div className="grid gap-4 md:grid-cols-2">
                    <div className="wf-card flex flex-col gap-3 p-5">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-sm font-semibold text-slate-100">Reward Overlay</h3>
                            <p className="text-xs text-slate-400">
                                Trigger the overlay with sample void reward data.
                            </p>
                        </div>
                        <button
                            onClick={() => invoke("test_overlay")}
                            className="flex items-center gap-2 self-start rounded-lg border border-violet-500/20 bg-violet-950/40 px-4 py-2 text-xs font-bold text-violet-300 transition-colors hover:bg-violet-950/60"
                        >
                            <Eye size={13} />
                            Test Overlay
                        </button>
                    </div>

                    <div className="wf-card flex flex-col gap-3 p-5">
                        <div className="flex flex-col gap-1">
                            <h3 className="text-sm font-semibold text-slate-100">Trade Overlay</h3>
                            <p className="text-xs text-slate-400">
                                Test the trade detection overlay with mocked data.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                onClick={() => invoke("test_trade_overlay")}
                                className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-950/40 px-4 py-2 text-xs font-bold text-green-300 transition-colors hover:bg-green-950/60"
                            >
                                <Eye size={13} />
                                Single Part
                            </button>
                            <button
                                onClick={() => invoke("test_trade_overlay_set")}
                                className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-950/40 px-4 py-2 text-xs font-bold text-green-300 transition-colors hover:bg-green-950/60"
                            >
                                <Eye size={13} />
                                Set
                            </button>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── Maintenance ─────────────────────────────────────────── */}
            <section className="space-y-3">
                <SectionHeader icon={Wrench} title="Maintenance"/>
                <div className="grid gap-4 md:grid-cols-2">
                    {ACTIONS.map((action) => {
                        const isRunning = running === action.key;
                        const Icon = action.key === "run_update_script" ? Database : Tag;
                        const accent = action.key === "run_update_script" ? "text-cyan-400" : "text-emerald-400";

                        return (
                            <button
                                key={action.key}
                                onClick={() => setPendingAction(action.key)}
                                disabled={running !== null}
                                className="wf-card group flex flex-col gap-3 p-5 text-left transition-colors hover:border-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <div className="flex items-center gap-3">
                                    <Icon size={16} className={accent} />
                                    <h3 className="text-sm font-semibold text-slate-100">{action.title}</h3>
                                </div>
                                <p className="text-xs text-slate-400">{action.description}</p>
                                <span className={`mt-auto self-start rounded-md border border-cyan-500/20 bg-cyan-950/30 px-2.5 py-1 font-mono text-[10px] font-bold ${accent}`}>
                                    {isRunning ? "RUNNING..." : action.buttonLabel}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {progressLines.length > 0 && (
                    <pre ref={progressRef}
                         className="custom-scrollbar h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[10px] leading-relaxed text-slate-300">
                        {progressLines.map((l, i) => <span key={i}>{l}{"\n"}</span>)}
                    </pre>
                )}

                {lastResult && (
                    <div className="wf-card flex flex-col gap-3 p-5">
                        <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-semibold text-slate-100">
                                Last result: {ACTIONS.find((item) => item.key === lastResult.action)?.title}
                            </h3>
                            <span
                                className={`rounded px-2 py-1 text-xs font-medium ${
                                    lastResult.result.success
                                        ? "bg-green-500/15 text-green-300"
                                        : "bg-red-500/15 text-red-300"
                                }`}
                            >
                                {lastResult.result.success ? "Success" : "Failed"}
                            </span>
                        </div>

                        <p className="text-xs text-slate-500">
                            Exit code: {lastResult.result.code ?? "none"}
                        </p>

                        {lastResult.result.stdout.trim() && (
                            <div className="flex flex-col gap-1">
                                <span className="text-xs uppercase tracking-wide text-slate-500">stdout</span>
                                <pre
                                    className="custom-scrollbar overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200">
                                    {lastResult.result.stdout}
                                </pre>
                            </div>
                        )}

                        {lastResult.result.stderr.trim() && (
                            <div className="flex flex-col gap-1">
                                <span className="text-xs uppercase tracking-wide text-slate-500">stderr</span>
                                <pre
                                    className="custom-scrollbar overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-red-300">
                                    {lastResult.result.stderr}
                                </pre>
                            </div>
                        )}
                    </div>
                )}
            </section>

            {error && (
                <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                    {error}
                </div>
            )}

            {pendingConfig && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setPendingAction(null);
                        }
                    }}
                >
                    <div
                        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-[#1e1e2d] bg-[#111119] p-5 shadow-2xl">
                        <div className="flex flex-col gap-1">
                            <h2 className="text-sm font-semibold text-slate-100">{pendingConfig.confirmTitle}</h2>
                            <p className="text-sm text-slate-400">{pendingConfig.confirmMessage}</p>
                        </div>

                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => setPendingAction(null)}
                                className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-700"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={async () => {
                                    const action = pendingConfig.key;
                                    setPendingAction(null);
                                    await handleRun(action);
                                }}
                                className="rounded-lg bg-primary-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-primary-400"
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
