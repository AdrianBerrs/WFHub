import {useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";

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
    variant: "primary" | "secondary";
    confirmTitle: string;
    confirmMessage: string;
}

interface HubStateFile {
    refresh_seconds: number;
}

const ACTIONS: ActionCard[] = [
    {
        key: "run_update_script",
        title: "Update datasets",
        description: "Runs update.sh at the project root to download and regenerate data.",
        buttonLabel: "Run update.sh",
        variant: "primary",
        confirmTitle: "Confirm update",
        confirmMessage: "This will run update.sh and overwrite local data files. Do you want to continue?",
    },
    {
        key: "update_prices",
        title: "Update prices",
        description: "Downloads the latest prices from warframe.market via warframestat.us. The overlay will use the new prices immediately on the next detection.",
        buttonLabel: "Update prices.json",
        variant: "primary",
        confirmTitle: "Confirm price update",
        confirmMessage: "This will download and overwrite prices.json with current warframe.market prices. Do you want to continue?",
    },
];

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

    async function handleRun(action: ShellAction) {
        setRunning(action);
        setError(null);
        try {
            const result = await invoke<ShellCommandResult>("run_shell_action", {action});
            setLastResult({action, result});
        } catch (e) {
            setError(String(e));
        } finally {
            setRunning(null);
        }
    }

    useEffect(() => {
        invoke<string>("read_hub_state")
            .then((raw) => {
                const parsed: HubStateFile = JSON.parse(raw);
                setHubRefresh(parsed.refresh_seconds);
            })
            .catch(() => {
            });
    }, []);

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

    const pendingConfig = pendingAction
        ? ACTIONS.find((item) => item.key === pendingAction) ?? null
        : null;

    return (
        <div className="flex flex-col h-full p-4 gap-4">

            <div className="space-y-2">
                <h1 className="text-lg font-bold text-purple-400">Settings</h1>
                <p className="mt-1 text-sm text-gray-500">
                    Hub refresh settings and app maintenance scripts.
                </p>
            </div>

            <div className="grid gap-4">
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                        <h2 className="text-sm font-semibold text-gray-100">Hub: refresh interval</h2>
                        <p className="text-sm text-gray-400">
                            Sets how often the Hub fetches new worldstate data (15s to 600s).
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="number"
                            min={15}
                            max={600}
                            value={hubRefresh}
                            onChange={(e) => setHubRefresh(Number(e.target.value || 60))}
                            className="w-28 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-purple-500 focus:outline-none"
                        />
                        <span className="text-sm text-gray-400">seconds</span>
                        <button
                            onClick={saveHubRefresh}
                            disabled={hubSaving}
                            className="ml-auto px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-50 text-gray-950 text-sm font-semibold transition-colors"
                        >
                            {hubSaving ? "Saving..." : "Save"}
                        </button>
                    </div>
                </div>

                {ACTIONS.map((action) => {
                    const isRunning = running === action.key;
                    const buttonClass =
                        action.variant === "primary"
                            ? "bg-purple-500 hover:bg-purple-400 text-gray-950"
                            : "bg-gray-800 hover:bg-gray-700 text-gray-100";

                    return (
                        <div
                            key={action.key}
                            className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3"
                        >
                            <div className="flex flex-col gap-1">
                                <h2 className="text-sm font-semibold text-gray-100">{action.title}</h2>
                                <p className="text-sm text-gray-400">{action.description}</p>
                            </div>

                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setPendingAction(action.key)}
                                    disabled={running !== null}
                                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${buttonClass}`}
                                >
                                    {isRunning ? "Running..." : action.buttonLabel}
                                </button>

                                {isRunning && (
                                    <span className="text-sm text-purple-300">Command running...</span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {error && (
                <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                    {error}
                </div>
            )}

            {pendingConfig && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setPendingAction(null);
                        }
                    }}
                >
                    <div
                        className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-4 shadow-2xl">
                        <div className="flex flex-col gap-1">
                            <h2 className="text-sm font-semibold text-gray-100">{pendingConfig.confirmTitle}</h2>
                            <p className="text-sm text-gray-400">{pendingConfig.confirmMessage}</p>
                        </div>

                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => setPendingAction(null)}
                                className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-100 text-sm font-medium transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={async () => {
                                    const action = pendingConfig.key;
                                    setPendingAction(null);
                                    await handleRun(action);
                                }}
                                className="px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 text-gray-950 text-sm font-semibold transition-colors"
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {lastResult && (
                <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold text-gray-100">
                            Last result: {ACTIONS.find((item) => item.key === lastResult.action)?.title}
                        </h2>
                        <span
                            className={`text-xs font-medium px-2 py-1 rounded ${
                                lastResult.result.success
                                    ? "bg-green-500/15 text-green-300"
                                    : "bg-red-500/15 text-red-300"
                            }`}
                        >
              {lastResult.result.success ? "Success" : "Failed"}
            </span>
                    </div>

                    <p className="text-xs text-gray-500">
                        Exit code: {lastResult.result.code ?? "none"}
                    </p>

                    {lastResult.result.stdout.trim() && (
                        <div className="flex flex-col gap-1">
                            <span className="text-xs uppercase tracking-wide text-gray-500">stdout</span>
                            <pre
                                className="rounded-lg bg-gray-950 border border-gray-800 p-3 text-xs text-gray-200 overflow-auto whitespace-pre-wrap">
                {lastResult.result.stdout}
              </pre>
                        </div>
                    )}

                    {lastResult.result.stderr.trim() && (
                        <div className="flex flex-col gap-1">
                            <span className="text-xs uppercase tracking-wide text-gray-500">stderr</span>
                            <pre
                                className="rounded-lg bg-gray-950 border border-gray-800 p-3 text-xs text-red-300 overflow-auto whitespace-pre-wrap">
                {lastResult.result.stderr}
              </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
