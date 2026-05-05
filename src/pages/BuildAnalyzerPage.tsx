import {useEffect, useMemo, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-shell";
import {
    buildNameSearchIndex,
    candidateMatchesFromIndex,
    normalizeSearchText,
    similarityScore,
    type NameSearchIndex,
} from "../lib/search";
import {getSpecialModSources, type FarmResult} from "../lib/modSpecialSources";
import {wikiUrl} from "../lib/wikiUrl";
import {sourceLabel} from "../lib/sourceLabel";
import AutocompleteField, {
    resolveAutocompleteOption,
    type AutocompleteOption,
} from "../components/AutocompleteField";

interface ItemEntry {
    slug: string;
    name: string;
}

interface DetectionEntry {
    id: string;
    rawText: string;
    matchedName: string | null;
    score: number;
}

interface Inventory {
    mods: string[];
    arcanes: string[];
    scanned_at?: string;
}

interface RelatedEntityOption extends AutocompleteOption {
    kind: "Warframe" | "Weapon";
}

interface BuildItemOption extends AutocompleteOption {
    kind: "Mod" | "Arcane";
}

const WARFRAME_NAMES = [
    "Ash", "Atlas", "Banshee", "Baruuk", "Caliban", "Chroma", "Citrine", "Cyte-09", "Dagath", "Dante",
    "Ember", "Equinox", "Excalibur", "Frost", "Gara", "Garuda", "Gauss", "Grendel", "Gyre", "Harrow",
    "Hildryn", "Hydroid", "Inaros", "Ivara", "Jade", "Khora", "Koumei", "Kullervo", "Lavos", "Limbo",
    "Loki", "Mag", "Mesa", "Mirage", "Nekros", "Nezha", "Nidus", "Nova", "Nyx", "Oberon", "Octavia",
    "Oraxia", "Protea", "Qorvex", "Revenant", "Rhino", "Saryn", "Sevagoth", "Styanax", "Temple", "Titania",
    "Trinity", "Valkyr", "Vauban", "Volt", "Voruna", "Wisp", "Wukong", "Xaku", "Yareli", "Zephyr",
];

const ARCANE_SLUG_PREFIXES = [
    "arcane_",
    "primary_",
    "secondary_",
    "melee_",
    "cascadia_",
    "pax_",
    "exodia_",
    "residual_",
    "theorem_",
    "virtuos_",
    "eternal_",
    "emergence_",
    "molt_",
];

function isLikelyModName(text: string): boolean {
    if (text.length < 4) return false;
    if (/^[\d\s\W]+$/.test(text)) return false;
    const alpha = text.replace(/[^a-zA-Z]/g, "").length;
    if (alpha / text.length < 0.5) return false;
    const uiWords = ["combos", "search", "new", "fusion", "transmute", "sell", "dissolve", "filter", "exit", "recent", "total", "duplicates"];
    return !uiWords.includes(text.toLowerCase());
}

function buildDetections(texts: string[], itemIndex: NameSearchIndex<ItemEntry>): DetectionEntry[] {
    const deduped = new Map<string, DetectionEntry>();
    const usedIndices = new Set<number>();

    for (let i = 0; i < texts.length; i++) {
        if (usedIndices.has(i)) continue;

        const cleaned = normalizeSearchText(texts[i]);
        if (cleaned.length < 2) continue;

        let bestMatch: { name: string; ocr: string; score: number; windowSize: number } | null = null;

        for (let window = 1; window <= 3 && i + window <= texts.length; window++) {
            const rawCombined = texts.slice(i, i + window).join(" ");
            const combined = normalizeSearchText(rawCombined);
            for (const candidate of candidateMatchesFromIndex(itemIndex, combined)) {
                const score = similarityScore(candidate.normalizedName, combined);
                if (score >= 0.75 && (!bestMatch || score > bestMatch.score)) {
                    bestMatch = {
                        name: candidate.item.name,
                        ocr: rawCombined.replace(/\s+/g, " ").trim(),
                        score,
                        windowSize: window,
                    };
                }
            }
        }

        if (bestMatch) {
            const key = `found:${bestMatch.name.toLowerCase()}`;
            const existing = deduped.get(key);
            if (!existing || bestMatch.score > existing.score) {
                deduped.set(key, {
                    id: key,
                    rawText: bestMatch.ocr,
                    matchedName: bestMatch.name,
                    score: bestMatch.score,
                });
            }
            for (let j = i; j < i + bestMatch.windowSize; j++) usedIndices.add(j);
        } else {
            const key = `unknown:${cleaned.toLowerCase()}`;
            if (!deduped.has(key)) {
                deduped.set(key, {id: key, rawText: cleaned, matchedName: null, score: 0});
            }
        }
    }

    return Array.from(deduped.values()).sort((left, right) => {
        if (!!left.matchedName !== !!right.matchedName) {
            return left.matchedName ? -1 : 1;
        }
        return right.score - left.score;
    });
}

function titleCaseWeapon(name: string): string {
    return name.replace(/\b\w/g, (char) => char.toUpperCase());
}

function getWeaponEntityOptions(rawRules: string): RelatedEntityOption[] {
    const parsed = JSON.parse(rawRules) as Record<string, Record<string, unknown>>;
    return Array.from(
        new Map(
            Object.values(parsed).flatMap((weapons) =>
                Object.keys(weapons).map((name) => [
                    normalizeSearchText(name),
                    {name: titleCaseWeapon(name), kind: "Weapon" as const},
                ] as const)
            )
        ).values()
    );
}

function isArcaneLikeItem(item: ItemEntry): boolean {
    const slug = item.slug.toLowerCase();
    return ARCANE_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))
        && !/helmet/i.test(item.name)
        && !/veiled/i.test(item.name);
}

interface DropZoneProps {
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    isDragging: boolean;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
}

function DropZone({onClick, onDrop, isDragging, onDragOver, onDragLeave}: DropZoneProps) {
    return (
        <button
            onClick={onClick}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{height: "72px"}}
            className={`w-full border-2 border-dashed rounded-lg flex items-center justify-center gap-3 cursor-pointer transition-colors shrink-0 ${
                isDragging
                    ? "border-purple-400 bg-purple-500/10"
                    : "border-gray-700 hover:border-purple-500"
            }`}
        >
            <span className="text-2xl text-gray-600">+</span>
            <div>
                <div className="text-sm text-gray-400">Drag, paste or click</div>
                <div className="text-xs text-gray-600">PNG · JPG · Cmd+V</div>
            </div>
        </button>
    );
}

export default function BuildAnalyzerPage() {
    const [allItems, setAllItems] = useState<ItemEntry[]>([]);
    const [allModNames, setAllModNames] = useState<string[]>([]);
    const [allWfcdMods, setAllWfcdMods] = useState<string[]>([]);
    const [inventory, setInventory] = useState<Inventory>({mods: [], arcanes: []});
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [imagePath, setImagePath] = useState<string>("");
    const [detections, setDetections] = useState<DetectionEntry[]>([]);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [farmResults, setFarmResults] = useState<Record<string, FarmResult[]>>({});
    const [farmLoading, setFarmLoading] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [showSaveModal, setShowSaveModal] = useState(false);
    const [saveName, setSaveName] = useState("");
    const [saveRelatedEntity, setSaveRelatedEntity] = useState("");
    const [saveRelatedEntityOption, setSaveRelatedEntityOption] = useState<RelatedEntityOption | null>(null);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");
    const [manualItemInput, setManualItemInput] = useState("");
    const [manualItemError, setManualItemError] = useState<string | null>(null);
    const [relatedEntityOptions, setRelatedEntityOptions] = useState<RelatedEntityOption[]>(
        WARFRAME_NAMES.map((name) => ({name, kind: "Warframe"}))
    );
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        invoke<string>("read_items_list")
            .then((raw) => setAllItems(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_mod_names")
            .then((raw) => setAllModNames(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_all_mods")
            .then((raw) => setAllWfcdMods(JSON.parse(raw)))
            .catch(() => {
            });
        invoke<string>("read_inventory")
            .then((raw) => {
                const parsed = JSON.parse(raw);
                setInventory({
                    mods: parsed.mods ?? [],
                    arcanes: parsed.arcanes ?? [],
                    scanned_at: parsed.scanned_at,
                });
            })
            .catch(() => {
            });
        invoke<string>("read_riven_weapon_rules")
            .then((raw) => {
                const warframes = WARFRAME_NAMES.map((name) => ({name, kind: "Warframe" as const}));
                const weapons = getWeaponEntityOptions(raw);
                const deduped = Array.from(
                    new Map([...warframes, ...weapons].map((item) => [normalizeSearchText(item.name), item])).values()
                );
                setRelatedEntityOptions(deduped);
            })
            .catch(() => {
            });
    }, []);

    const combinedItems = useMemo<ItemEntry[]>(() => {
        const seen = new Set(allItems.map((i) => i.name.toLowerCase()));
        const extraNames = [
            ...allModNames.filter((n) => !seen.has(n.toLowerCase())),
            ...allWfcdMods.filter((n) => !seen.has(n.toLowerCase())),
        ];
        const dedupedExtras = Array.from(new Map(extraNames.map((n) => [n.toLowerCase(), n])).values());
        return [...allItems, ...dedupedExtras.map((n) => ({slug: "", name: n}))];
    }, [allItems, allModNames, allWfcdMods]);

    const buildItemOptions = useMemo<BuildItemOption[]>(() => {
        const modOptions = [
            ...allModNames.map((name) => ({name, kind: "Mod" as const})),
            ...allWfcdMods.map((name) => ({name, kind: "Mod" as const})),
        ];
        const arcaneOptions = allItems
            .filter(isArcaneLikeItem)
            .map((item) => ({name: item.name, kind: "Arcane" as const}));
        return Array.from(
            new Map([...modOptions, ...arcaneOptions].map((item) => [normalizeSearchText(item.name), item])).values()
        ).sort((left, right) => left.name.localeCompare(right.name));
    }, [allItems, allModNames, allWfcdMods]);

    const itemIndex = useMemo(() => buildNameSearchIndex(combinedItems), [combinedItems]);
    const ownedItems = useMemo(
        () => new Set([...inventory.mods, ...inventory.arcanes].map((name) => name.toLowerCase())),
        [inventory]
    );

    async function handleImageFile(file: File) {
        const reader = new FileReader();
        reader.onload = async () => {
            const result = reader.result as string;
            const base64 = result.split(",")[1];
            await invoke("save_temp_image", {
                base64Data: base64,
                path: "/tmp/wfhub_build_input.png",
            });
            setImagePath("/tmp/wfhub_build_input.png");
            setPreviewUrl(result);
            setDetections([]);
            setExpanded({});
            setFarmResults({});
            setManualItemInput("");
            setManualItemError(null);
            setError(null);
        };
        reader.readAsDataURL(file);
    }

    useEffect(() => {
        const handlePaste = async (e: ClipboardEvent) => {
            const items = Array.from(e.clipboardData?.items || []);
            const imageItem = items.find((item) => item.type.startsWith("image/"));
            if (imageItem) {
                const file = imageItem.getAsFile();
                if (file) handleImageFile(file);
            }
        };
        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, []);

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file?.type.startsWith("image/")) handleImageFile(file);
    };

    async function analyzeBuild() {
        if (!imagePath) return;
        setLoading(true);
        setError(null);
        setDetections([]);
        setExpanded({});
        setFarmResults({});
        setManualItemError(null);
        try {
            const raw = await invoke<string>("analyze_build_image", {imagePath});
            const texts: string[] = JSON.parse(raw);
            const filteredTexts = texts.filter(isLikelyModName);
            setDetections(buildDetections(filteredTexts, itemIndex));
        } catch {
            setError("Error analyzing the build image.");
        } finally {
            setLoading(false);
        }
    }

    async function toggleDetails(entry: DetectionEntry) {
        if (!entry.matchedName) return;
        setExpanded((current) => ({...current, [entry.id]: !current[entry.id]}));
        if (farmResults[entry.matchedName] || farmLoading[entry.matchedName]) return;
        setFarmLoading((current) => ({...current, [entry.matchedName!]: true}));
        try {
            const raw = await invoke<string>("search_farm_data", {query: entry.matchedName});
            const parsed: FarmResult[] = JSON.parse(raw);
            const specialRules = getSpecialModSources(entry.matchedName);
            setFarmResults((current) => ({...current, [entry.matchedName!]: [...specialRules, ...parsed]}));
        } finally {
            setFarmLoading((current) => ({...current, [entry.matchedName!]: false}));
        }
    }

    async function handleSaveBuild() {
        const name = saveName.trim();
        if (!name) return;

        const resolvedEntity = resolveAutocompleteOption(relatedEntityOptions, saveRelatedEntity) ?? saveRelatedEntityOption;
        const trimmedRelatedEntity = saveRelatedEntity.trim();
        const relatedEntity = resolvedEntity?.name ?? (trimmedRelatedEntity.length > 0 ? trimmedRelatedEntity : null);
        const relatedEntityKind = resolvedEntity?.kind ?? null;
        const items = detections
            .filter((d) => d.matchedName)
            .map((d) => d.matchedName as string);

        await invoke("save_build", {
            name,
            items,
            imagePath: imagePath || null,
            relatedEntity,
            relatedEntityKind,
        });
        setSaveStatus("saved");
        setTimeout(() => {
            setShowSaveModal(false);
            setSaveName("");
            setSaveRelatedEntity("");
            setSaveRelatedEntityOption(null);
            setSaveStatus("idle");
        }, 1500);
    }

    function handleManualItemAdd() {
        const selected = resolveAutocompleteOption(buildItemOptions, manualItemInput);
        const fallbackName = manualItemInput.trim();

        if (!selected && !fallbackName) {
            return;
        }
        if (!selected) {
            setManualItemError("Select a valid mod or arcane from the suggestions.");
            return;
        }

        const duplicate = detections.some((entry) => entry.matchedName?.toLowerCase() === selected.name.toLowerCase());
        if (duplicate) {
            setManualItemError("This item is already in the build list.");
            return;
        }

        const key = `manual:${normalizeSearchText(selected.name)}:${Date.now()}`;
        setDetections((current) => [
            ...current,
            {
                id: key,
                rawText: `Manual: ${selected.name}`,
                matchedName: selected.name,
                score: 1,
            },
        ]);
        setManualItemInput("");
        setManualItemError(null);
    }

    function removeDetection(id: string) {
        setDetections((current) => current.filter((entry) => entry.id !== id));
        setExpanded((current) => {
            const next = {...current};
            delete next[id];
            return next;
        });
    }

    const foundCount = useMemo(
        () => detections.filter((entry) => entry.matchedName).length,
        [detections]
    );
    const ownedCount = useMemo(
        () => detections.filter((entry) => entry.matchedName && ownedItems.has(entry.matchedName.toLowerCase())).length,
        [detections, ownedItems]
    );

    const hasAnalysisWorkspace = !!previewUrl;

    return (
        <div className="flex flex-col h-full">
            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) handleImageFile(file);
                    event.target.value = "";
                }}
            />

            {!hasAnalysisWorkspace && (
                <div className="flex flex-col flex-1 items-center justify-center gap-6 p-8">
                    <div>
                        <h1 className="text-xl font-bold text-purple-400 text-center">Build Analyzer</h1>
                        <p className="text-sm text-gray-500 mt-1 text-center">
                            Paste, drag or select a build screenshot to detect mods and arcanes
                        </p>
                    </div>

                    <div className="w-full max-w-lg">
                        <DropZone
                            onClick={() => inputRef.current?.click()}
                            onDrop={handleDrop}
                            isDragging={isDragging}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setIsDragging(true);
                            }}
                            onDragLeave={(e) => {
                                e.preventDefault();
                                setIsDragging(false);
                            }}
                        />
                    </div>

                    {previewUrl && (
                        <div className="flex flex-col items-center gap-3 w-full max-w-lg">
                            <img
                                src={previewUrl}
                                alt="Build preview"
                                className="max-h-64 w-full rounded-xl object-contain bg-black/40 border border-gray-800"
                            />
                            <button
                                onClick={analyzeBuild}
                                disabled={loading}
                                className="rounded-lg bg-purple-500 px-6 py-2 text-sm font-semibold text-gray-950 hover:bg-purple-400 disabled:opacity-40"
                            >
                                {loading ? "Analyzing..." : "Analyze Build"}
                            </button>
                        </div>
                    )}

                    {error && <p className="text-sm text-red-400">{error}</p>}
                </div>
            )}

            {hasAnalysisWorkspace && (
                <>
                    <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
                        <div>
                            <h1 className="text-lg font-bold text-purple-400">Build Analyzer</h1>
                            <p className="text-xs text-gray-500 mt-0.5">
                                Paste, drag or select a build screenshot to detect mods and arcanes
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => {
                                    setSaveName("");
                                    setSaveRelatedEntity("");
                                    setSaveRelatedEntityOption(null);
                                    setSaveStatus("idle");
                                    setShowSaveModal(true);
                                }}
                                className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-800 transition-colors"
                            >
                                Save Build
                            </button>
                            <button
                                onClick={analyzeBuild}
                                disabled={loading || !imagePath}
                                className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-semibold text-gray-950 hover:bg-purple-400 disabled:opacity-40"
                            >
                                {loading ? "Analyzing..." : "Analyze Build"}
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-[700px_1fr] h-full min-h-0">
                        <div className="flex flex-col gap-3 p-4 border-r border-gray-800">
                            <DropZone
                                onClick={() => inputRef.current?.click()}
                                onDrop={handleDrop}
                                isDragging={isDragging}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setIsDragging(true);
                                }}
                                onDragLeave={(e) => {
                                    e.preventDefault();
                                    setIsDragging(false);
                                }}
                            />

                            {previewUrl ? (
                                <div className="flex-1 min-h-0 rounded-lg overflow-hidden border border-gray-800 bg-black/40">
                                    <img
                                        src={previewUrl}
                                        alt="Build preview"
                                        className="w-full h-full object-contain"
                                    />
                                </div>
                            ) : (
                                <div className="flex-1 min-h-0 rounded-lg border border-gray-800/50 bg-gray-900/30 flex items-center justify-center">
                                    <p className="text-xs text-gray-600">No image</p>
                                </div>
                            )}
                        </div>

                        <div className="flex-1 overflow-auto p-4">
                            {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

                            <div className="mb-4 rounded-xl border border-gray-800 bg-gray-900/60 p-4">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <div>
                                        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Manual Add</h2>
                                        <p className="mt-1 text-xs text-gray-500">
                                            Add missing mods or arcanes when OCR fails. Remove unknown rows and insert the correct item here.
                                        </p>
                                    </div>
                                </div>
                                <AutocompleteField
                                    value={manualItemInput}
                                    options={buildItemOptions}
                                    onChange={(value) => {
                                        setManualItemInput(value);
                                        setManualItemError(null);
                                    }}
                                    onSelect={(item) => {
                                        setManualItemInput(item.name);
                                        setManualItemError(null);
                                    }}
                                    onButtonClick={handleManualItemAdd}
                                    buttonLabel="Add"
                                    placeholder="Search mod or arcane to insert manually"
                                    emptyText="No mod or arcane matches your search."
                                />
                                {manualItemError && <p className="mt-2 text-xs text-red-400">{manualItemError}</p>}
                            </div>

                            {detections.length === 0 && !loading && (
                                <p className="mb-4 text-sm text-gray-500">
                                    No items detected yet. Run OCR or add mods and arcanes manually.
                                </p>
                            )}

                            {detections.length > 0 && (
                                <>
                                    <div className="flex items-center justify-between mb-3">
                                        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                            Build Items
                                        </h2>
                                        <p className="text-xs text-gray-500">
                                            {foundCount} found · {detections.length - foundCount} unrecognized
                                        </p>
                                        <p className="text-xs text-emerald-400">
                                            {ownedCount} build items already in inventory
                                        </p>
                                    </div>

                                    <div className="space-y-2">
                                        {detections.map((entry) => {
                                            const isFound = !!entry.matchedName;
                                            const isExpanded = expanded[entry.id];
                                            const cachedFarm = entry.matchedName ? farmResults[entry.matchedName] ?? [] : [];
                                            const isFarmLoading = entry.matchedName ? farmLoading[entry.matchedName] : false;
                                            const displayName = entry.matchedName ?? entry.rawText;
                                            const isOwned = !!entry.matchedName && ownedItems.has(entry.matchedName.toLowerCase());

                                            return (
                                                <div
                                                    key={entry.id}
                                                    onClick={() => isFound && toggleDetails(entry)}
                                                    className={`rounded-lg border overflow-hidden transition-colors ${
                                                        isFound
                                                            ? "border-gray-800 bg-gray-900 cursor-pointer hover:bg-gray-800"
                                                            : "border-orange-800/50 bg-gray-900"
                                                    }`}
                                                >
                                                    <div className="flex items-center gap-2 px-3 py-2">
                                                        <span
                                                            className={`text-sm font-bold shrink-0 ${
                                                                isFound ? "text-emerald-400" : "text-orange-400"
                                                            }`}
                                                        >
                                                            {isFound ? "✓" : "?"}
                                                        </span>

                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-1.5">
                                                                <p className={`text-sm font-medium truncate ${isFound ? "text-gray-100" : "text-gray-400"}`}>
                                                                    {displayName}
                                                                </p>
                                                                {isOwned && (
                                                                    <span
                                                                        className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 shrink-0"
                                                                        title="This item already exists in the saved inventory"
                                                                    >
                                                                        ✓ Already owned
                                                                    </span>
                                                                )}
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        open(wikiUrl(isFound ? entry.matchedName! : entry.rawText));
                                                                    }}
                                                                    className="text-gray-500 hover:text-purple-400 transition-colors shrink-0"
                                                                    title="View on wiki"
                                                                >
                                                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                                                        <path d="M7 1h4v4M11 1L5 7M3 2H1v9h9V9"
                                                                              stroke="currentColor" strokeWidth="1.5"
                                                                              strokeLinecap="round"/>
                                                                    </svg>
                                                                </button>
                                                            </div>
                                                            {isFound && entry.rawText !== entry.matchedName && (
                                                                <p className="text-[11px] text-gray-500 truncate">OCR: {entry.rawText}</p>
                                                            )}
                                                        </div>

                                                        <div className="flex items-center gap-2 shrink-0">
                                                            {isFound && (
                                                                <span className="text-[11px] text-gray-500">
                                                                    {isExpanded ? "▲" : "▼"}
                                                                </span>
                                                            )}
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    removeDetection(entry.id);
                                                                }}
                                                                className="text-[11px] text-gray-600 hover:text-gray-300 leading-none"
                                                            >
                                                                ×
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {isFound && isExpanded && (
                                                        <div className="border-t border-gray-800 bg-gray-950/60 px-3 py-3">
                                                            {isFarmLoading && (
                                                                <p className="text-xs text-gray-500">Loading farm sources...</p>
                                                            )}
                                                            {!isFarmLoading && cachedFarm.length === 0 && (
                                                                <p className="text-xs text-gray-500">No farm sources found.</p>
                                                            )}
                                                            {!isFarmLoading && cachedFarm.length > 0 && (
                                                                <div className="space-y-1.5">
                                                                    {cachedFarm.slice(0, 8).map((farm, index) => (
                                                                        <div
                                                                            key={`${entry.id}-farm-${index}`}
                                                                            className="flex items-start justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2"
                                                                        >
                                                                            <div className="min-w-0">
                                                                                <span className="rounded-full bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">
                                                                                    {sourceLabel(farm.source)}
                                                                                </span>
                                                                                <p className="mt-1.5 text-xs text-gray-200 truncate">{farm.location}</p>
                                                                                {farm.source === "enemy" && farm.dropTableChance !== undefined && farm.itemChance !== undefined && (
                                                                                    <p className="mt-0.5 text-[10px] text-gray-500 truncate">
                                                                                        {farm.dropTableChance.toFixed(2)}% table × {farm.itemChance.toFixed(2)}% item
                                                                                    </p>
                                                                                )}
                                                                                {farm.source !== "enemy" && farm.extra && (
                                                                                    <p className="mt-0.5 text-[11px] text-gray-500">{farm.extra}</p>
                                                                                )}
                                                                            </div>
                                                                            <div className="text-right shrink-0">
                                                                                <p className="text-sm font-bold text-purple-400">{farm.chance.toFixed(2)}%</p>
                                                                                <p className="text-[10px] text-gray-500">
                                                                                    ~{Math.ceil(100 / Math.max(farm.chance, 0.01))} {farm.source === "enemy" ? "kills" : "runs"}
                                                                                </p>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                    {cachedFarm.length > 8 && (
                                                                        <p className="text-[11px] text-gray-600">
                                                                            Showing the 8 best sources.
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}

            {showSaveModal && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setShowSaveModal(false);
                    }}
                >
                    <div className="w-[30rem] bg-gray-950 border border-gray-700 rounded-xl shadow-2xl p-5 flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-gray-200">Save Build</span>
                            <button onClick={() => setShowSaveModal(false)} className="text-gray-500 hover:text-gray-200">✕</button>
                        </div>
                        {saveStatus === "saved" ? (
                            <p className="text-sm text-green-400 text-center py-2">✓ Build saved!</p>
                        ) : (
                            <>
                                <input
                                    autoFocus
                                    type="text"
                                    value={saveName}
                                    onChange={(e) => setSaveName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSaveBuild();
                                        if (e.key === "Escape") setShowSaveModal(false);
                                    }}
                                    placeholder="Build name (e.g. Volt Prime — Endgame)"
                                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500"
                                />
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                            Related Entity
                                        </span>
                                        <span className="text-[11px] text-gray-500">Warframe or weapon</span>
                                    </div>
                                    <AutocompleteField
                                        value={saveRelatedEntity}
                                        options={relatedEntityOptions}
                                        onChange={(value) => {
                                            setSaveRelatedEntity(value);
                                            setSaveRelatedEntityOption(null);
                                        }}
                                        onSelect={(item) => {
                                            setSaveRelatedEntity(item.name);
                                            setSaveRelatedEntityOption(item);
                                        }}
                                        placeholder="Search the warframe or weapon this build belongs to"
                                        emptyText="No known warframe or weapon matches your search."
                                    />
                                </div>
                                <p className="text-xs text-gray-500">
                                    {detections.filter((d) => d.matchedName).length} recognized items will be saved.
                                </p>
                                <p className="text-xs text-gray-500">
                                    The current screenshot will also be attached to the build for tracking in Build Tracker.
                                </p>
                                <button
                                    onClick={handleSaveBuild}
                                    disabled={!saveName.trim()}
                                    className="w-full rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-40 py-2 text-sm font-semibold text-gray-950 transition-colors"
                                >
                                    Save
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
