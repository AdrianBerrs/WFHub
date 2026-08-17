import {useState, useEffect, useCallback, useRef, useMemo} from "react";
import {useNavigate} from "react-router-dom";
import {invoke} from "@tauri-apps/api/core";
import {listen, UnlistenFn} from "@tauri-apps/api/event";
import {Box, History, Info, Search, SlidersHorizontal} from "lucide-react";
import AutocompleteField from "../components/AutocompleteField";
import {findFuzzyMatches, normalizeSearchText} from "../lib/search";

type ScanType = "mods" | "arcanes" | "prime_parts";
type Phase = "idle" | "capturing" | "processing" | "done";
type PrimeFilter = "todos" | "andamento" | "completo";

interface ProgressPayload {
    count: number;
    phase: "capturing" | "processing" | "done";
}

interface Inventory {
    mods: string[];
    arcanes: string[];
    prime_parts: string[];
    scanned_at?: string;
}

interface RewardItem {
    name: string;
    platinum: number;
    is_best: boolean;
}

interface RewardEntry {
    timestamp: string;
    items: RewardItem[];
}

interface PrimeItem {
    name: string;
    parts: string[];
}

interface ModImageInfo {
    name: string;
    thumbnailUrl?: string;
    imageName?: string;
    rarity?: string;
    type?: string;
    maxRank?: number;
    stats?: string[];
}

const WARFRAME_SUB_BP = /\b(Chassis|Neuroptics|Systems|Harness|Wings) Blueprint$/;
const WFCD_IMAGE_BASE = "https://cdn.warframestat.us/img/";
const WFM_IMAGE_BASE = "https://warframe.market/static/assets/";
const WIKI_IMAGE_BASE = "https://wiki.warframe.com/images/";
const RARITY_RANK: Record<string, number> = {Common: 0, Uncommon: 1, Rare: 2, Legendary: 3};
type OrderBy = "name" | "price" | "rarity";

function primeWikiImageUrl(itemName: string): string | null {
    // "Rhino Prime" -> "RhinoPrime.png"; remove caracteres especiais para nomes de arquivo
    const file = itemName.replace(/\s+/g, "").replace(/[^A-Za-z0-9_&]/g, "");
    if (!file) return null;
    return `${WIKI_IMAGE_BASE}${file}.png`;
}

function PrimePreviewImg({primarySrc, fallbackName, alt, className, style}: {
    primarySrc: string;
    fallbackName?: string;
    alt: string;
    className?: string;
    style?: React.CSSProperties;
}) {
    const [attemptedWiki, setAttemptedWiki] = useState(false);
    const [src, setSrc] = useState(primarySrc);
    useEffect(() => { setSrc(primarySrc); setAttemptedWiki(false); }, [primarySrc]);

    const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        if (!attemptedWiki && fallbackName) {
            const wiki = primeWikiImageUrl(fallbackName);
            if (wiki) {
                setAttemptedWiki(true);
                setSrc(wiki);
                return;
            }
        }
        img.style.display = "none";
    };

    return (
        <img key={src} src={src} alt={alt} className={className} style={style}
             onError={handleError} />
    );
}

function getPrimeItemName(partName: string): string {
    const words = partName.split(" ");
    const idx = words.indexOf("Prime");
    if (idx >= 0) return words.slice(0, idx + 1).join(" ");
    return partName;
}

function buildGroups(allParts: string[]): PrimeItem[] {
    const map = new Map<string, string[]>();
    for (const part of allParts) {
        const item = getPrimeItemName(part);
        const list = map.get(item) ?? [];
        list.push(part);
        map.set(item, list);
    }
    return Array.from(map.entries())
        .map(([name, parts]) => ({name, parts: parts.sort()}))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function isWarframeItem(item: PrimeItem): boolean {
    return item.parts.some((p) => WARFRAME_SUB_BP.test(p));
}

function getDisplayParts(item: PrimeItem): string[] {
    if (!isWarframeItem(item)) return item.parts;
    return item.parts.filter(
        (p) => !p.endsWith(" Blueprint") || p === `${item.name} Blueprint`
    );
}

function formatDate(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {month: "short", day: "numeric"}) +
        " " + d.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});
}

function PlatIcon({size = 14}: {size?: number}) {
    return <img src="/PlatinumLarge.webp" alt="plat" style={{width: size, height: size}} className="inline-block object-contain"/>;
}

function DucatIcon({size = 14}: {size?: number}) {
    return <img src="/OrokinDucats.png" alt="ducat" style={{width: size, height: size}} className="inline-block object-contain"/>;
}


function ModPreviewImage({modImage, name}: {modImage?: ModImageInfo; name: string}) {
    const [failed, setFailed] = useState(false);
    const src = modImage?.thumbnailUrl ?? (modImage?.imageName ? `${WFCD_IMAGE_BASE}${modImage.imageName}` : undefined);

    useEffect(() => setFailed(false), [src]);

    if (!src || failed) {
        return (
            <div className="flex h-90 w-full items-center justify-center rounded-lg border border-dashed border-slate-800 bg-slate-950/70 text-center text-xs font-mono uppercase tracking-wide text-slate-600">
                Sem preview
            </div>
        );
    }

    return (
        <div className="flex h-90 w-full items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
            <img
                src={src}
                alt={name}
                loading="lazy"
                className="h-full w-full object-contain"
                onError={() => setFailed(true)}
            />
        </div>
    );
}

function ArcanePreviewCard({arcane, name, rarity}: {arcane?: ModImageInfo; name: string; rarity?: string}) {
    const [failed, setFailed] = useState(false);
    const src = arcane?.imageName ? `${WFCD_IMAGE_BASE}${arcane.imageName}` : undefined;
    const displayRarity = rarity ?? arcane?.rarity;
    const maxRank = arcane?.maxRank ?? 5;
    const statLines = (arcane?.stats ?? [])
        .map((stat) => stat.replace(/\\n/g, "\n"))
        .flatMap((stat) => stat.split("\n"))
        .map((line) => line.trim())
        .filter((line, index, lines) => {
            if (!line || lines.indexOf(line) !== index) return false;
            if (line === "+1 Arcane Revive" && lines.some((candidate) => candidate !== line && candidate.includes(line))) {
                return false;
            }
            return true;
        })
        .slice(0, 4);

    useEffect(() => setFailed(false), [src]);

    return (
        <div className="overflow-hidden rounded-xl border border-cyan-500/20 bg-[#070a12] shadow-[0_0_24px_rgba(8,145,178,0.10)]">
            <div className="bg-cyan-950/20 px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[10px] font-black uppercase text-cyan-200/80">{arcane?.type ?? "Arcane"}</span>
                    <span className="shrink-0 rounded border border-cyan-400/25 bg-cyan-950/50 px-2 py-0.5 text-[10px] font-bold text-cyan-200">
                        Rank {maxRank}
                    </span>
                </div>
            </div>

            <div className="relative overflow-hidden bg-[radial-gradient(circle_at_50%_22%,rgba(34,211,238,0.18),transparent_38%),linear-gradient(180deg,#080b18_0%,#060814_100%)] p-4">
                <div className="flex items-center gap-4">
                    <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border border-cyan-400/20 bg-black/25 shadow-[inset_0_0_28px_rgba(34,211,238,0.08)]">
                        {src && !failed ? (
                            <img
                                src={src}
                                alt={name}
                                loading="lazy"
                                className="h-18 w-18 object-contain drop-shadow-[0_0_14px_rgba(34,211,238,0.75)]"
                                onError={() => setFailed(true)}
                            />
                        ) : (
                            <span className="text-[10px] font-bold uppercase text-cyan-200/60">Arcane</span>
                        )}
                    </div>

                    <div className="min-w-0 flex-1">
                        <h3 className="text-base font-black leading-tight text-slate-100">{name}</h3>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {displayRarity && (
                                <span className="rounded bg-cyan-950/60 px-2 py-0.5 text-[10px] font-black uppercase text-cyan-300">
                                    {displayRarity}
                                </span>
                            )}
                            <span className="rounded bg-emerald-950/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400">Possuído</span>
                        </div>
                    </div>
                </div>

                {statLines.length > 0 && (
                    <div className="mt-4 rounded-lg border border-cyan-500/10 bg-black/25 p-3">
                        {statLines.map((line) => (
                            <p key={line} className="text-xs leading-relaxed text-slate-300">
                                {line}
                            </p>
                        ))}
                    </div>
                )}

                <div className="mt-4 flex justify-center gap-1.5">
                    {Array.from({length: maxRank + 1}, (_, index) => (
                        <span key={index} className="h-1.5 w-5 rounded-full bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.65)]" />
                    ))}
                </div>
            </div>
        </div>
    );
}

function AddPrimeModal({allPrimeParts, owned, onAdd, onClose}: {
    allPrimeParts: string[];
    owned: Set<string>;
    onAdd: (name: string) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);
    useEffect(() => {
        function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const suggestions = query.trim().length >= 1
        ? allPrimeParts.filter((p) => p.toLowerCase().includes(query.toLowerCase())).slice(0, 50)
        : allPrimeParts.slice(0, 50);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
             onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="flex max-h-[70vh] w-120 flex-col overflow-hidden rounded-xl border border-[#1e1e2d] bg-[#111119] shadow-2xl">
                <div className="flex items-center justify-between border-b border-[#1e1e2d] px-4 py-3">
                    <span className="text-sm font-semibold text-slate-200">Add prime part</span>
                    <button onClick={onClose} className="text-lg leading-none text-slate-500 hover:text-slate-200">✕</button>
                </div>
                <div className="border-b border-[#1e1e2d] px-3 py-2">
                    <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                           placeholder="Search..." className="w-full rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-primary-500 focus:outline-none"/>
                </div>
                <div className="custom-scrollbar flex-1 overflow-auto">
                    {suggestions.map((name) => {
                        const isOwned = owned.has(name);
                        return (
                            <button key={name} onClick={() => { if (!isOwned) onAdd(name); }} disabled={isOwned}
                                    className={`flex w-full items-center justify-between border-b border-slate-900/70 px-4 py-2 text-sm transition-colors ${isOwned ? "cursor-default text-slate-600" : "cursor-pointer text-slate-200 hover:bg-slate-900"}`}>
                                <span>{name}</span>
                                {isOwned && <span className="text-xs text-green-500">✓ already owned</span>}
                            </button>
                        );
                    })}
                    {suggestions.length === 0 && <p className="px-4 py-3 text-sm text-slate-500">No results.</p>}
                </div>
            </div>
        </div>
    );
}

export default function InventoryPage() {
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<ScanType>("mods");
    const [phase, setPhase] = useState<Phase>("idle");
    const [liveCount, setLiveCount] = useState(0);
    const [inventory, setInventory] = useState<Inventory>({mods: [], arcanes: [], prime_parts: []});
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [itemRarities, setItemRarities] = useState<Map<string, string>>(new Map());
    const [modImages, setModImages] = useState<Map<string, ModImageInfo>>(new Map());
    const [arcaneImages, setArcaneImages] = useState<Map<string, ModImageInfo>>(new Map());
    const [selectedModName, setSelectedModName] = useState<string | null>(null);
    const [selectedArcaneName, setSelectedArcaneName] = useState<string | null>(null);
    const [allPrimeParts, setAllPrimeParts] = useState<string[]>([]);
    const [showModal, setShowModal] = useState(false);

    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [allItemSlugs, setAllItemSlugs] = useState<{name: string; slug: string}[]>([]);
    const [sellSlugQuery, setSellSlugQuery] = useState("");
    const [sellSlug, setSellSlug] = useState<string | null>(null);
    const [sellPrice, setSellPrice] = useState(1);
    const [sellRank, setSellRank] = useState<number | null>(null);
    const [sellQuantity, setSellQuantity] = useState(1);
    const [sellSubmitting, setSellSubmitting] = useState(false);
    const [sellError, setSellError] = useState<string | null>(null);
    const [sellSuccess, setSellSuccess] = useState<string | null>(null);
    const [itemsPrices, setItemsPrices] = useState<Map<string, {avg?: number | null; buy?: number | null; sell?: number | null; ducats?: number | null; updated_at?: string | null}>>(new Map());

    // Primes filter + sell mode
    const [selectedItemPrice, setSelectedItemPrice] = useState<{
        unranked: {buyPrice: number | null; sellPrice: number | null};
        ranked: {buyPrice: number | null; sellPrice: number | null} | null;
        maxRank: number | null;
    } | null>(null);
    const [modRanks, setModRanks] = useState<Map<string, number>>(new Map());

    const [modOrderBy, setModOrderBy] = useState<OrderBy>("name");
    const [arcaneOrderBy, setArcaneOrderBy] = useState<OrderBy>("name");
    const [primeOrderBy, setPrimeOrderBy] = useState<OrderBy>("name");

    const [modMeta, setModMeta] = useState<Record<string, {polarity: string; type: string}>>({});
    const [modPolarityFilter, setModPolarityFilter] = useState<string | null>(null);
    const [modTypeFilter, setModTypeFilter] = useState<string | null>(null);
    const [showModFilterMenu, setShowModFilterMenu] = useState(false);
    const modFilterMenuRef = useRef<HTMLDivElement>(null);

    const [arcaneTypeFilter, setArcaneTypeFilter] = useState<string | null>(null);
    const [showArcaneFilterMenu, setShowArcaneFilterMenu] = useState(false);
    const arcaneFilterMenuRef = useRef<HTMLDivElement>(null);

    const [primeFilter, setPrimeFilter] = useState<PrimeFilter>("todos");
    const [primeTypeFilter, setPrimeTypeFilter] = useState<string | null>(null);
    const [primeVaultFilter, setPrimeVaultFilter] = useState<"all" | "vaulted" | "unvaulted">("all");
    const [vaultData, setVaultData] = useState<Record<string, {category: string; vaulted: boolean}>>({});
    const [showPrimeFilterMenu, setShowPrimeFilterMenu] = useState(false);
    const primeFilterMenuRef = useRef<HTMLDivElement>(null);
    const [primeSellMode, setPrimeSellMode] = useState(true);
    const [primePanelPart, setPrimePanelPart] = useState<string | null>(null);
    const [primePanelSet, setPrimePanelSet] = useState<PrimeItem | null>(null);
    const [primePreviewImgUrl, setPrimePreviewImgUrl] = useState<string | null>(null);
    const [showVoidHistory, setShowVoidHistory] = useState(false);
    const [rewardHistory, setRewardHistory] = useState<RewardEntry[]>([]);
    const [historyLoaded, setHistoryLoaded] = useState(false);

    const tabLabels: Record<ScanType, string> = {mods: "Mods", arcanes: "Arcanes", prime_parts: "Primes"};

    const scanInstructions: Record<ScanType, string> = {
        mods: "Open the in-game Mods terminal.",
        arcanes: "Open the in-game Inventory and switch to the Arcanes tab.",
        prime_parts: "Open the in-game Inventory showing your Prime parts.",
    };

    const loadInventory = useCallback(async () => {
        try {
            const raw = await invoke<string>("read_inventory");
            const parsed = JSON.parse(raw);
            setInventory({
                mods: parsed.mods ?? [],
                arcanes: parsed.arcanes ?? [],
                prime_parts: parsed.prime_parts ?? [],
                scanned_at: parsed.scanned_at,
            });
        } catch { /* file doesn't exist yet */ }
    }, []);

    useEffect(() => {
        loadInventory();
        invoke<string>("read_prime_parts").then((raw) => setAllPrimeParts(JSON.parse(raw))).catch(() => {});
        invoke<string>("read_item_rarities").then((raw) => {
            try { setItemRarities(new Map(Object.entries(JSON.parse(raw) as Record<string, string>))); } catch { /* ignore */ }
        }).catch(() => {});
        invoke<string>("read_mod_images").then((raw) => {
            try { setModImages(new Map(Object.entries(JSON.parse(raw) as Record<string, ModImageInfo>))); } catch { /* ignore */ }
        }).catch(() => {});
        invoke<string>("read_arcane_images").then((raw) => {
            try { setArcaneImages(new Map(Object.entries(JSON.parse(raw) as Record<string, ModImageInfo>))); } catch { /* ignore */ }
        }).catch(() => {});
        invoke<string>("wfmarket_read_auth").then((raw) => setIsLoggedIn(!!JSON.parse(raw).jwt)).catch(() => {});
        invoke<string>("read_items_list").then((raw) => setAllItemSlugs(JSON.parse(raw))).catch(() => {});
        invoke<string>("read_prime_vault").then((raw) => setVaultData(JSON.parse(raw))).catch(() => {});
        invoke<string>("read_mod_ranks").then((raw) => {
            try { setModRanks(new Map(Object.entries(JSON.parse(raw) as Record<string, number>))); } catch { /* ignore */ }
        }).catch(() => {});
        invoke<string>("read_mod_meta").then((raw) => setModMeta(JSON.parse(raw))).catch(() => {});
        invoke<string>("read_items_prices").then((raw) => {
            try { setItemsPrices(new Map(Object.entries(JSON.parse(raw) as Record<string, any>))); } catch { /* ignore */ }
        }).catch(() => {});
    }, [loadInventory]);

    useEffect(() => {
        function onFocus() {
            invoke<string>("read_items_prices").then((raw) => {
                try { setItemsPrices(new Map(Object.entries(JSON.parse(raw) as Record<string, any>))); } catch { /* ignore */ }
            }).catch(() => {});
        }
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, []);

    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>("inventory-progress", async (event) => {
            const {count, phase: p} = event.payload;
            setLiveCount(count);
            setPhase(p);
            if (p === "done") {
                try { await invoke("save_inventory_result"); } catch { /* ignore */ }
                await loadInventory();
                setPhase("idle");
            }
        }).then((fn) => { unlisten = fn; });
        return () => { unlisten?.(); };
    }, [loadInventory]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (primeFilterMenuRef.current && !primeFilterMenuRef.current.contains(e.target as Node)) {
                setShowPrimeFilterMenu(false);
            }
            if (modFilterMenuRef.current && !modFilterMenuRef.current.contains(e.target as Node)) {
                setShowModFilterMenu(false);
            }
            if (arcaneFilterMenuRef.current && !arcaneFilterMenuRef.current.contains(e.target as Node)) {
                setShowArcaneFilterMenu(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    useEffect(() => {
        const selectedName = activeTab === "mods" ? selectedModName : activeTab === "arcanes" ? selectedArcaneName : null;
        if (!selectedName || sellSlug || sellSlugQuery !== selectedName || allItemSlugs.length === 0) return;
        const matched = findFuzzyMatches(allItemSlugs, selectedName, 1)[0];
        setSellSlug(matched?.slug ?? null);
    }, [activeTab, allItemSlugs, selectedArcaneName, selectedModName, sellSlug, sellSlugQuery]);

    function prepareSellForm(itemName: string) {
        setSellError(null);
        setSellSuccess(null);
        setSellPrice(1);
        setSellRank(null);
        setSellQuantity(1);
        setSellSlugQuery(itemName);
        const matched = findFuzzyMatches(allItemSlugs, itemName, 1)[0];
        setSellSlug(matched?.slug ?? null);
    }

    function fetchItemPrices(slug: string, itemName?: string) {
        const name = itemName ?? slug;
        invoke<string>("fetch_market_top", {slug, rank: null})
            .then((raw) => {
                const data = JSON.parse(raw);
                if (!data?.data) return;
                const unranked = {
                    buyPrice: data.data.buy?.[0]?.platinum ?? null,
                    sellPrice: data.data.sell?.[0]?.platinum ?? null,
                };
                if (unranked.buyPrice !== null || unranked.sellPrice !== null) {
                    invoke("save_item_price", {name, buy: unranked.buyPrice, sell: unranked.sellPrice}).catch(() => {});
                    setItemsPrices((prev) => {
                        const next = new Map(prev);
                        const existing = next.get(name) ?? {};
                        next.set(name, {...existing, buy: unranked.buyPrice, sell: unranked.sellPrice, updated_at: new Date().toISOString()});
                        return next;
                    });
                }
                invoke<string>("fetch_item_info", {slug})
                    .then((infoRaw) => {
                        const info = JSON.parse(infoRaw);
                        const maxRank = info?.data?.maxRank ?? null;
                        if (maxRank === null) {
                            setSelectedItemPrice({unranked, ranked: null, maxRank: null});
                            return;
                        }
                        invoke<string>("fetch_market_top", {slug, rank: maxRank})
                            .then((rankedRaw) => {
                                const rData = JSON.parse(rankedRaw);
                                setSelectedItemPrice({
                                    unranked,
                                    ranked: rData?.data ? {
                                        buyPrice: rData.data.buy?.[0]?.platinum ?? null,
                                        sellPrice: rData.data.sell?.[0]?.platinum ?? null,
                                    } : null,
                                    maxRank,
                                });
                            })
                            .catch(() => setSelectedItemPrice({unranked, ranked: null, maxRank: null}));
                    })
                    .catch(() => setSelectedItemPrice({unranked, ranked: null, maxRank: null}));
            })
            .catch(() => {});
    }

    function handleSelectArcane(itemName: string) {
        setSelectedArcaneName(itemName);
        setSelectedItemPrice(null);
        prepareSellForm(itemName);
        const matched = findFuzzyMatches(allItemSlugs, itemName, 1)[0];
        if (matched) fetchItemPrices(matched.slug, itemName);
    }

    useEffect(() => {
        setSelectedItemPrice(null);
    }, [activeTab]);

    function handleSelectMod(itemName: string) {
        setSelectedModName(itemName);
        prepareSellForm(itemName);
        setSelectedItemPrice(null);
        const matched = findFuzzyMatches(allItemSlugs, itemName, 1)[0];
        if (matched) fetchItemPrices(matched.slug, itemName);
    }

    async function handleSellSubmit() {
        if (!sellSlug) { setSellError("Please select a valid item from the list."); return; }
        setSellSubmitting(true);
        setSellError(null);
        setSellSuccess(null);
        try {
            await invoke("wfmarket_create_sell_order", {
                itemSlug: sellSlug,
                platinum: sellPrice,
                quantity: sellQuantity,
                rank: sellRank,
            });
            setSellSuccess("Order published on warframe.market.");
        } catch (e) {
            setSellError(String(e));
        } finally {
            setSellSubmitting(false);
        }
    }

    function loadHistory() {
        if (historyLoaded) return;
        invoke<string>("read_reward_history")
            .then((raw) => setRewardHistory(JSON.parse(raw)))
            .catch(() => {})
            .finally(() => setHistoryLoaded(true));
    }

    async function handleStart() {
        setError(null);
        setLiveCount(0);
        setPhase("capturing");
        try { await invoke("start_inventory_scan", {scanType: activeTab}); }
        catch (e) { setError(String(e)); setPhase("idle"); }
    }

    async function handleStop() {
        setError(null);
        try { await invoke("stop_inventory_scan"); }
        catch (e) { setError(String(e)); }
    }

    async function addPrimePart(name: string) {
        if (inventory.prime_parts.includes(name)) return;
        const updated = [...inventory.prime_parts, name].sort();
        setInventory((prev) => ({...prev, prime_parts: updated}));
        await invoke("save_prime_parts", {parts: updated});
    }

    async function removePrimePart(name: string) {
        const updated = inventory.prime_parts.filter((p) => p !== name);
        setInventory((prev) => ({...prev, prime_parts: updated}));
        await invoke("save_prime_parts", {parts: updated});
    }

    function getPartLocalIcon(partName: string): string | null {
        const lower = partName.toLowerCase();
        if (lower.endsWith("chassis blueprint") || lower.endsWith("chassis")) return "/prime_parts/chassis.png";
        if (lower.endsWith("neuroptics blueprint") || lower.endsWith("neuroptics")) return "/prime_parts/neuroptics.png";
        if (lower.endsWith("systems blueprint") || lower.endsWith("systems")) return "/prime_parts/systems.png";
        if (lower.endsWith("harness blueprint") || lower.endsWith("harness")) return "/prime_parts/blueprint.png";
        if (lower.endsWith("wings blueprint") || lower.endsWith("wings")) return "/prime_parts/blueprint.png";
        if (lower.endsWith("blueprint")) return "/prime_parts/blueprint.png";
        if (lower.endsWith("barrel")) return "/prime_parts/barrel.png";
        if (lower.endsWith("receiver")) return "/prime_parts/receiver.png";
        if (lower.endsWith("stock")) return "/prime_parts/stock.png";
        if (lower.endsWith("blade")) return "/prime_parts/blade.png";
        if (lower.endsWith("handle")) return "/prime_parts/handle.png";
        if (lower.endsWith("link")) return "/prime_parts/link.png";
        if (lower.endsWith("grip")) return "/prime_parts/grip.png";
        if (lower.endsWith("guard")) return "/prime_parts/guard.png";
        if (lower.endsWith("disc")) return "/prime_parts/disc.png";
        if (lower.endsWith("string")) return "/prime_parts/string.png";
        if (lower.endsWith("gauntlet")) return "/prime_parts/gauntlet.png";
        if (lower.endsWith("chain")) return "/prime_parts/chain.png";
        if (lower.endsWith("ornament")) return "/prime_parts/ornament.png";
        return null;
    }

    function fetchAndSetPrimeIcon(slug: string) {
        invoke<string>("fetch_item_info", {slug})
            .then((raw) => {
                const icon: string | undefined = JSON.parse(raw)?.data?.i18n?.en?.icon;
                if (icon) setPrimePreviewImgUrl(`${WFM_IMAGE_BASE}${icon}`);
            })
            .catch(() => {});
    }

    function openPrimeSellPanel(partName: string) {
        setPrimePanelPart(partName);
        setPrimePanelSet(null);
        setSellError(null);
        setSellSuccess(null);
        setSellSlugQuery(partName);
        setSellSlug(null);
        setSellPrice(1);
        setSellRank(null);
        setSellQuantity(1);
        setSelectedItemPrice(null);
        setPrimePreviewImgUrl(getPartLocalIcon(partName));
        const matched = findFuzzyMatches(allItemSlugs, partName, 1)[0];
        if (matched) {
            setSellSlugQuery(matched.name);
            setSellSlug(matched.slug);
            fetchItemPrices(matched.slug, partName);
        }
    }

    function openPrimeSetPanel(item: PrimeItem) {
        setPrimePanelSet(item);
        setPrimePanelPart(null);
        setSellSuccess(null);
        setSellError(null);
        setSellPrice(1);
        setSellRank(null);
        setSellQuantity(1);
        setSelectedItemPrice(null);
        setPrimePreviewImgUrl(primeWikiImageUrl(item.name));
        const setName = `${item.name} Set`;
        const setSlugEntry = allItemSlugs.find((s) => s.name.toLowerCase() === setName.toLowerCase())
            ?? findFuzzyMatches(allItemSlugs, setName, 1)[0];
        if (setSlugEntry) {
            setSellSlugQuery(setSlugEntry.name);
            setSellSlug(setSlugEntry.slug);
            fetchAndSetPrimeIcon(setSlugEntry.slug);
            fetchItemPrices(setSlugEntry.slug, `${item.name} Set`);
        }
    }

    function closePrimePanel() {
        setPrimePanelPart(null);
        setPrimePanelSet(null);
        setPrimePreviewImgUrl(null);
    }

    function togglePrimeSellMode() {
        setPrimeSellMode((prev) => {
            if (prev) closePrimePanel();
            return !prev;
        });
    }

    const scanning = phase === "capturing";
    const processing = phase === "processing";
    const busy = scanning || processing;

    // Mods/Arcanes list
    const rawList = activeTab === "mods" ? inventory.mods : inventory.arcanes;
    const currentList = useMemo(() => {
        let list = search.trim() ? rawList.filter((n) => n.toLowerCase().includes(search.toLowerCase())) : rawList;
        if (activeTab === "mods") {
            if (modPolarityFilter) list = list.filter((n) => modMeta[n.toLowerCase()]?.polarity === modPolarityFilter);
            if (modTypeFilter) {
                const typeMap: Record<string, string[]> = {
                    "Warframe": ["Warframe Mod"],
                    "Primary": ["Primary Mod"],
                    "Secondary": ["Secondary Mod"],
                    "Melee": ["Melee Mod", "Stance Mod"],
                    "Shotgun": ["Shotgun Mod"],
                    "Companion": ["Companion Mod"],
                    "Archwing": ["Archwing Mod", "Arch-Gun Mod", "Arch-Melee Mod"],
                    "Aura": ["Aura Mod"],
                    "Necramech": ["Necramech Mod"],
                    "Railjack": ["Railjack Mod", "Plexus Mod"],
                    "Riven": ["Melee Riven Mod", "Rifle Riven Mod", "Shotgun Riven Mod", "Pistol Riven Mod", "Zaw Riven Mod", "Kitgun Riven Mod", "Companion Weapon Riven Mod", "Arch-Gun Riven Mod"],
                };
                const allowed = typeMap[modTypeFilter] ?? [modTypeFilter];
                list = list.filter((n) => allowed.includes(modMeta[n.toLowerCase()]?.type ?? ""));
            }
            const ob = modOrderBy;
            list = [...list].sort((a, b) => {
                if (ob === "price") {
                    const pa = itemsPrices.get(a); const pb = itemsPrices.get(b);
                    return ((pb?.sell ?? pb?.avg) ?? -1) - ((pa?.sell ?? pa?.avg) ?? -1);
                }
                if (ob === "rarity") {
                    return (RARITY_RANK[itemRarities.get(b.toLowerCase()) ?? ""] ?? -1) - (RARITY_RANK[itemRarities.get(a.toLowerCase()) ?? ""] ?? -1);
                }
                return a.localeCompare(b);
            });
        }
        if (activeTab === "arcanes") {
            if (arcaneTypeFilter) list = list.filter((n) => arcaneImages.get(normalizeSearchText(n))?.type === `${arcaneTypeFilter} Arcane`);
            const ob = arcaneOrderBy;
            list = [...list].sort((a, b) => {
                if (ob === "price") {
                    const pa = itemsPrices.get(a); const pb = itemsPrices.get(b);
                    return ((pb?.sell ?? pb?.avg) ?? -1) - ((pa?.sell ?? pa?.avg) ?? -1);
                }
                if (ob === "rarity") {
                    return (RARITY_RANK[itemRarities.get(b.toLowerCase()) ?? ""] ?? -1) - (RARITY_RANK[itemRarities.get(a.toLowerCase()) ?? ""] ?? -1);
                }
                return a.localeCompare(b);
            });
        }
        return list;
    }, [rawList, search, activeTab, modPolarityFilter, modTypeFilter, modMeta, arcaneTypeFilter, arcaneImages, modOrderBy, arcaneOrderBy, itemsPrices, itemRarities]);
    const selectedModImage = selectedModName ? modImages.get(normalizeSearchText(selectedModName)) : undefined;
    const selectedModRarity = selectedModName ? itemRarities.get(selectedModName.toLowerCase()) : undefined;
    const selectedArcaneImage = selectedArcaneName ? arcaneImages.get(normalizeSearchText(selectedArcaneName)) : undefined;
    const selectedArcaneRarity = selectedArcaneName ? itemRarities.get(selectedArcaneName.toLowerCase()) : undefined;
    const selectedPreviewName = activeTab === "mods" ? selectedModName : activeTab === "arcanes" ? selectedArcaneName : null;
    const selectedPreviewImage = activeTab === "mods" ? selectedModImage : activeTab === "arcanes" ? selectedArcaneImage : undefined;
    const selectedPreviewRarity = activeTab === "mods" ? selectedModRarity : activeTab === "arcanes" ? selectedArcaneRarity : undefined;
    const selectedPreviewType = activeTab === "mods" ? "mod" : "arcane";

    const itemMaxRank = useMemo(() => {
        const name = selectedPreviewName;
        if (!name) return null;
        if (activeTab === "arcanes") return 5;
        const localRank = modRanks.get(name);
        if (localRank !== undefined) return localRank;
        return selectedItemPrice?.maxRank ?? null;
    }, [selectedPreviewName, activeTab, modRanks, selectedItemPrice]);

    // Prime tracker groups
    const scannedSet = useMemo(() => new Set(inventory.prime_parts), [inventory.prime_parts]);
    const groups = useMemo(() => buildGroups(allPrimeParts), [allPrimeParts]);
    const filteredGroups = useMemo(() => {
        const q = search.trim().toLowerCase();
        const filtered = groups.filter((item) => {
            if (q && !item.name.toLowerCase().includes(q)) return false;
            const display = getDisplayParts(item);
            const have = display.filter((p) => scannedSet.has(p)).length;
            if (primeFilter === "completo") return have === display.length;
            if (primeFilter === "andamento") return have > 0 && have < display.length;
            const meta = vaultData[`${item.name} Set`] ?? vaultData[item.name];
            if (primeTypeFilter && meta?.category !== primeTypeFilter) return false;
            if (primeVaultFilter === "vaulted" && !meta?.vaulted) return false;
            if (primeVaultFilter === "unvaulted" && meta?.vaulted) return false;
            return true;
        });
        return [...filtered].sort((a, b) => {
            if (primeOrderBy === "price") {
                const pa = itemsPrices.get(a.name) ?? itemsPrices.get(`${a.name} Set`);
                const pb = itemsPrices.get(b.name) ?? itemsPrices.get(`${b.name} Set`);
                return ((pb?.sell ?? pb?.avg) ?? -1) - ((pa?.sell ?? pa?.avg) ?? -1);
            }
            if (primeOrderBy === "rarity") {
                const ma = vaultData[`${a.name} Set`] ?? vaultData[a.name];
                const mb = vaultData[`${b.name} Set`] ?? vaultData[b.name];
                return (mb?.vaulted ? 1 : 0) - (ma?.vaulted ? 1 : 0);
            }
            return a.name.localeCompare(b.name);
        });
    }, [groups, primeFilter, primeTypeFilter, primeVaultFilter, search, scannedSet, vaultData, primeOrderBy, itemsPrices]);

    const totalItems = groups.length;
    const completeItems = groups.filter((g) => { const d = getDisplayParts(g); return d.every((p) => scannedSet.has(p)); }).length;
    const inProgressItems = groups.filter((g) => { const d = getDisplayParts(g); const h = d.filter((p) => scannedSet.has(p)).length; return h > 0 && h < d.length; }).length;

    const statusText = () => {
        if (phase === "capturing") return `Capturing frames... ${liveCount} screens`;
        if (phase === "processing") return `Processing OCR... ${liveCount} items found`;
        return null;
    };

    return (
        <div className="wf-page h-screen overflow-hidden flex flex-col space-y-6">
            {/* Header */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 bg-gradient-to-r from-[#111119] to-[#12121e] p-5 rounded-xl border border-[#1e1e2d] items-center">
                <div className="lg:col-span-4">
                    <h2 className="text-xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
                        <Box size={20} className="text-indigo-400" />
                        My Item Inventory
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                        Track owned mods, arcanes, and Prime parts.
                    </p>
                </div>

                {/* Tabs */}
                <div className="lg:col-span-5 flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                    {(["mods", "arcanes", "prime_parts"] as ScanType[]).map((t) => (
                        <button key={t} onClick={() => { if (!busy) { setActiveTab(t); setSearch(""); } }}
                                className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
                                    activeTab === t ? 'bg-[#1a142c] text-indigo-400 border border-indigo-500/10' : 'text-slate-400 hover:text-slate-200'
                                } ${busy && activeTab !== t ? "cursor-not-allowed opacity-40" : ""}`}>
                            {tabLabels[t]}
                        </button>
                    ))}
                </div>

                {/* Search */}
                <div className="lg:col-span-3 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={15} />
                    <input type="text"
                           placeholder={`Search ${tabLabels[activeTab].toLowerCase()}...`}
                           value={search}
                           onChange={(e) => setSearch(e.target.value)}
                           className="w-full pl-9 pr-4 py-2 bg-slate-950/80 border border-slate-800 focus:border-indigo-500 rounded-lg text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/30" />
                </div>
            </div>

            {error && <p className="rounded border border-red-700/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">{error}</p>}

            {/* Scan instruction */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-600/30 bg-amber-950/10 px-4 py-2.5 text-xs text-slate-300">
                <Info size={14} className="mt-0.5 shrink-0 text-amber-400" />
                <p>
                    <span className="font-semibold text-slate-100">{tabLabels[activeTab]} scan:</span>{" "}
                    {scanInstructions[activeTab]}{" "}
                    <span className="font-semibold text-amber-300">
                        Keep Warframe in Windowed or Borderless Fullscreen so the app can capture the screen.
                    </span>
                </p>
            </div>

            {/* Main Grid */}
            <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-12 gap-5">
                {/* Content Pane */}
                <div className="xl:col-span-9 min-h-0 flex flex-col">

                    {/* PRIMES */}
                    {activeTab === "prime_parts" && (
                        <div className="bg-[#111119] rounded-xl border border-[#1e1e2d] shadow-lg flex flex-col min-h-0">
                            <div className="bg-slate-950/60 px-5 py-3 border-b border-[#1e1e2d] flex justify-between items-center">
                                <span className="text-xs font-mono font-bold text-slate-400 uppercase">PRIME INVENTORY</span>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-cyan-400 font-mono font-bold">{filteredGroups.length} items</span>
                                    {!busy ? (
                                        <button onClick={handleStart}
                                                className="text-[10px] font-bold text-indigo-400 bg-indigo-950/30 border border-indigo-500/15 px-2 py-0.5 rounded hover:bg-indigo-900/30 transition-colors">
                                            Scan
                                        </button>
                                    ) : scanning ? (
                                        <button onClick={handleStop}
                                                className="text-[10px] font-bold text-red-400 hover:bg-red-900/20 px-2 py-0.5 rounded transition-colors">
                                            Stop
                                        </button>
                                    ) : (
                                        <span className="text-[10px] text-indigo-400 animate-pulse">OCR...</span>
                                    )}
                                    <button onClick={() => { loadHistory(); setShowVoidHistory(true); }}
                                            className="text-[10px] font-bold text-cyan-400 bg-[#14232c] border border-cyan-500/15 px-2 py-0.5 rounded hover:bg-[#1a3446] transition-colors">
                                        <History size={11} className="inline" /> History
                                    </button>
                                    {/* Manage / Sell toggle */}
                                    <label className="flex items-center gap-1.5 cursor-pointer select-none" onClick={togglePrimeSellMode}>
                                        <span className={`text-[10px] font-bold font-mono transition-colors ${!primeSellMode ? "text-purple-400" : "text-slate-500"}`}>
                                            MANAGE
                                        </span>
                                        <div className={`relative w-7 h-3.5 rounded-full transition-colors ${!primeSellMode ? "bg-purple-500" : "bg-slate-700"}`}>
                                            <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${!primeSellMode ? "translate-x-3.5" : "translate-x-0"}`} />
                                        </div>
                                    </label>
                                </div>
                            </div>
                            {allPrimeParts.length > 0 && (
                                <div className="border-b border-[#1e1e2d]/50 bg-slate-950/30 px-5 py-2 flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Filter:</span>
                                    {(["todos", "andamento", "completo"] as PrimeFilter[]).map((f) => {
                                        const count = f === "todos" ? totalItems : f === "completo" ? completeItems : inProgressItems;
                                        const activeStyle = f === "todos" ? "bg-indigo-950/60 text-indigo-400 border-indigo-500/20"
                                            : f === "completo" ? "bg-emerald-950/60 text-emerald-400 border-emerald-500/20" : "bg-amber-950/60 text-amber-400 border-amber-500/20";
                                        return (
                                            <button key={f} onClick={() => setPrimeFilter(f)}
                                                    className={`px-2 py-0.5 text-[10px] font-bold font-mono rounded border transition-all ${
                                                        primeFilter === f ? activeStyle : 'bg-transparent text-slate-400 border-transparent hover:text-slate-200'
                                                    }`}>
                                                {f === "todos" ? "All" : f === "completo" ? "Complete" : "In Progress"}
                                                <span className="ml-1 text-[10px] font-semibold">{count}</span>
                                            </button>
                                        );
                                    })}

                                    {/* Sort buttons */}
                                    <div className="flex items-center gap-1 ml-auto">
                                        <span className="text-[9px] font-mono font-bold text-slate-600 uppercase mr-0.5">Sort:</span>
                                        {(["name", "price", "rarity"] as OrderBy[]).map((s) => (
                                            <button key={s} onClick={() => setPrimeOrderBy(s)}
                                                className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border capitalize transition-all ${
                                                    primeOrderBy === s ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30" : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                }`}>{s}</button>
                                        ))}
                                    </div>
                                    {/* Advanced filter button */}
                                    <div className="relative" ref={primeFilterMenuRef}>
                                        <button
                                            onClick={() => setShowPrimeFilterMenu((v) => !v)}
                                            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold font-mono rounded border transition-all ${
                                                primeTypeFilter || primeVaultFilter !== "all"
                                                    ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                    : "bg-transparent text-slate-500 border-transparent hover:text-slate-200"
                                            }`}>
                                            <SlidersHorizontal size={10} />
                                            {primeTypeFilter || primeVaultFilter !== "all" ? "Filtered" : "More"}
                                        </button>
                                        {showPrimeFilterMenu && (
                                            <div className="absolute right-0 top-full z-[200] mt-1 w-52 rounded-xl border border-slate-800 bg-[#0e0e16] shadow-2xl p-3 space-y-3">
                                                <div>
                                                    <p className="text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">Type</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {[null, "Warframe", "Primary", "Secondary", "Melee", "Archwing", "Sentinel", "Companion"].map((t) => (
                                                            <button key={t ?? "all"} onClick={() => setPrimeTypeFilter(t)}
                                                                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition-all ${
                                                                        primeTypeFilter === t
                                                                            ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                                    }`}>
                                                                {t ?? "All"}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">Vault</p>
                                                    <div className="flex gap-1">
                                                        {(["all", "unvaulted", "vaulted"] as const).map((v) => (
                                                            <button key={v} onClick={() => setPrimeVaultFilter(v)}
                                                                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition-all ${
                                                                        primeVaultFilter === v
                                                                            ? v === "vaulted" ? "bg-red-950/60 text-red-300 border-red-500/30"
                                                                                : v === "unvaulted" ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/30"
                                                                                : "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                                    }`}>
                                                                {v === "all" ? "All" : v === "unvaulted" ? "Unvaulted" : "Vaulted"}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                {(primeTypeFilter || primeVaultFilter !== "all") && (
                                                    <button onClick={() => { setPrimeTypeFilter(null); setPrimeVaultFilter("all"); }}
                                                            className="w-full text-[9px] font-mono font-bold text-slate-500 hover:text-slate-300 transition-colors text-center">
                                                        Clear filters
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                                {filteredGroups.length === 0 ? (
                                    <div className="flex items-center justify-center h-full">
                                        <p className="text-slate-400 text-xs">No Prime items match the active filter.</p>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {filteredGroups.map((item) => {
                                            const displayParts = getDisplayParts(item);
                                            const have = displayParts.filter((p) => scannedSet.has(p)).length;
                                            const total = displayParts.length;
                                            const complete = have === total;
                                            const isSetSelected = primeSellMode && primePanelSet?.name === item.name;
                                            return (
                                                <div key={item.name}
                                                     className={`bg-[#111119] rounded-xl border p-4 space-y-3.5 shadow-md ${
                                                         complete ? 'border-emerald-500/15 bg-gradient-to-tr from-emerald-950/5 to-transparent' : 'border-[#1e1e2d]'
                                                     } ${isSetSelected ? 'ring-1 ring-emerald-500/30' : ''}`}>
                                                    <div className="flex justify-between items-start gap-2">
                                                        <button
                                                            onClick={() => primeSellMode ? openPrimeSetPanel(item) : undefined}
                                                            className={`text-left ${primeSellMode ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
                                                        >
                                                            <h3 className="text-xs mb-2 font-black text-slate-200 font-mono tracking-wide uppercase">{item.name}</h3>
                                                            {(() => {
                                                                const p = itemsPrices.get(item.name) ?? itemsPrices.get(`${item.name} Set`);
                                                                if (!p) return null;
                                                                const parts = [];
                                                                const price = p.sell ?? p.avg;
                                                                if (price) parts.push(<span key="price" className="inline-flex items-center gap-1 text-1.5xs font-mono text-slate-400"><PlatIcon size={12}/>{Number(price).toFixed(0)}</span>);
                                                                const totalDucats = displayParts.reduce((sum, part) => {
                                                                    const pp = itemsPrices.get(part);
                                                                    return sum + (pp?.ducats ?? 0);
                                                                }, 0);
                                                                if (totalDucats > 0) parts.push(<span key="ducats" className="inline-flex items-center gap-1 text-1.5xs font-mono text-cyan-400"><DucatIcon size={12}/>{totalDucats}</span>);
                                                                return parts.length > 0 ? <span className="flex items-center gap-2 mt-0.5">{parts}</span> : null;
                                                            })()}
                                                        </button>
                                                        <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded shrink-0 ${
                                                            complete ? 'bg-emerald-950/40 text-emerald-400' : 'bg-slate-900 text-slate-400'
                                                        }`}>{have}/{total}</span>
                                                    </div>

                                                    <div className="w-full h-1 bg-slate-950 rounded-full overflow-hidden">
                                                        <div style={{ width: `${(have / total) * 100}%` }}
                                                             className={`h-full transition-all ${complete ? 'bg-emerald-400' : 'bg-indigo-400'}`} />
                                                    </div>

                                                    <div className="flex flex-wrap gap-2 pt-1">
                                                        {displayParts.map((part) => {
                                                            const owned = scannedSet.has(part);
                                                            const label = part.replace(`${item.name} `, "");
                                                            const isPartSelected = primeSellMode && primePanelPart === part;
                                                            const icon = getPartLocalIcon(part);
                                                            const pp = itemsPrices.get(part);
                                                            const partPrice = pp ? (pp.sell ?? pp.avg) : null;
                                                            return (
                                                                <div key={part} className="flex flex-col items-center gap-0.5">
                                                                <button
                                                                        onClick={() => primeSellMode
                                                                            ? openPrimeSellPanel(part)
                                                                            : (owned ? removePrimePart(part) : addPrimePart(part))
                                                                        }
                                                                        title={label}
                                                                        className={`relative flex h-12 w-12 flex-col items-center justify-center rounded-full border transition-all cursor-pointer ${
                                                                            owned
                                                                                ? 'border-emerald-500/40 bg-emerald-950/30'
                                                                                : 'border-slate-800 bg-slate-950/60 opacity-40 hover:opacity-70'
                                                                        } ${isPartSelected ? 'ring-2 ring-emerald-400/60' : ''}`}>
                                                                    {icon
                                                                        ? <img src={icon} alt={label} className="h-7 w-7 object-contain" style={{imageRendering: "pixelated"}} />
                                                                        : <span className="text-[9px] font-mono font-bold text-slate-400 text-center leading-tight px-1">{label}</span>
                                                                    }
                                                                </button>
                                                                {partPrice !== null && (() => {
                                                                    return (
                                                                        <span className="text-[11px] font-mono text-slate-500 text-center leading-tight flex items-center gap-1">
                                                                            <PlatIcon size={11}/>{Number(partPrice).toFixed(0)}
                                                                        </span>
                                                                    );
                                                                })()}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* MODS */}
                    {activeTab === "mods" && (
                        inventory.mods.length === 0 ? (
                            <div className="bg-[#111119] rounded-xl border border-[#1e1e2d] p-8 text-center shadow-lg">
                                <p className="text-xs text-slate-500">No mods found.</p>
                                {inventory.scanned_at && (
                                    <p className="text-xs text-slate-600 mt-2 font-mono">Last scan: {new Date(inventory.scanned_at).toLocaleString()}</p>
                                )}
                            </div>
                        ) : (
                            <div className="bg-[#111119] rounded-xl border border-[#1e1e2d] shadow-lg flex flex-col min-h-0">
                                <div className="bg-slate-950/60 px-5 py-3 border-b border-[#1e1e2d] flex justify-between items-center">
                                    <span className="text-xs font-mono font-bold text-slate-400 uppercase">MOD INVENTORY</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-cyan-400 font-mono font-bold">{currentList.length} items</span>
                                        {!busy ? (
                                            <button onClick={handleStart}
                                                    className="text-[10px] font-bold text-indigo-400 bg-indigo-950/30 border border-indigo-500/15 px-2 py-0.5 rounded hover:bg-indigo-900/30 transition-colors">
                                                Scan
                                            </button>
                                        ) : scanning ? (
                                            <button onClick={handleStop}
                                                    className="text-[10px] font-bold text-red-400 hover:bg-red-900/20 px-2 py-0.5 rounded transition-colors">
                                                Stop
                                            </button>
                                        ) : (
                                            <span className="text-[10px] text-indigo-400 animate-pulse">OCR...</span>
                                        )}
                                    </div>
                                </div>
                                <div className="border-b border-[#1e1e2d]/50 bg-slate-950/30 px-4 py-1.5 flex items-center gap-2">
                                    <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Sort:</span>
                                    {(["name", "price", "rarity"] as OrderBy[]).map((s) => (
                                        <button key={s} onClick={() => setModOrderBy(s)}
                                            className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border capitalize transition-all ${
                                                modOrderBy === s ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30" : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                            }`}>{s}</button>
                                    ))}
                                    <div className="relative ml-auto" ref={modFilterMenuRef}>
                                        <button
                                            onClick={() => setShowModFilterMenu((v) => !v)}
                                            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold font-mono rounded border transition-all ${
                                                modPolarityFilter || modTypeFilter
                                                    ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                    : "bg-transparent text-slate-500 border-transparent hover:text-slate-200"
                                            }`}>
                                            <SlidersHorizontal size={10} />
                                            {modPolarityFilter || modTypeFilter ? "Filtered" : "More"}
                                        </button>
                                        {showModFilterMenu && (
                                            <div className="absolute right-0 top-full z-[200] mt-1 w-64 rounded-xl border border-slate-800 bg-[#0e0e16] shadow-2xl p-3 space-y-3">
                                                <div>
                                                    <p className="text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">Polarity</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {[null, "madurai", "naramon", "vazarin", "zenurik", "unairu", "penjaga", "umbra", "aura", "universal"].map((p) => (
                                                            <button key={p ?? "all"} onClick={() => setModPolarityFilter(p)}
                                                                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border capitalize transition-all ${
                                                                        modPolarityFilter === p
                                                                            ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                                    }`}>
                                                                {p ?? "All"}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div>
                                                    <p className="text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">Type</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {[null, "Warframe", "Primary", "Secondary", "Melee", "Shotgun", "Companion", "Archwing", "Aura", "Riven", "Necramech", "Railjack"].map((t) => (
                                                            <button key={t ?? "all"} onClick={() => setModTypeFilter(t)}
                                                                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition-all ${
                                                                        modTypeFilter === t
                                                                            ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                                    }`}>
                                                                {t ?? "All"}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                {(modPolarityFilter || modTypeFilter) && (
                                                    <button onClick={() => { setModPolarityFilter(null); setModTypeFilter(null); }}
                                                            className="w-full text-[9px] font-mono font-bold text-slate-500 hover:text-slate-300 transition-colors text-center">
                                                        Clear filters
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                                {currentList.length === 0 ? (
                                    <p className="p-6 text-center text-xs text-slate-500">No mods match the active filter.</p>
                                ) : (
                                <div className="grid grid-cols-2 gap-1.5 p-2">
                                    {currentList.map((name) => {
                                        const rarity = itemRarities.get(name.toLowerCase());
                                        const selected = selectedModName === name;
                                        return (
                                            <button key={name} onClick={() => handleSelectMod(name)}
                                                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors h-10 ${
                                                    selected
                                                        ? "border-cyan-500/30 bg-indigo-950/30 ring-1 ring-inset ring-cyan-400/20"
                                                        : "border-slate-800 bg-slate-950/60 hover:border-slate-700 hover:bg-slate-900/20"
                                                }`}>
                                                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${selected ? "bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.8)]" : "bg-indigo-500"}`} />
                                                <span className="truncate font-bold text-slate-200">{name}</span>
                                                {rarity && <span className="shrink-0 text-[10px] font-mono uppercase text-slate-500">{rarity}</span>}
                                                {(() => {
                                                    const p = itemsPrices.get(name);
                                                    const price = p?.sell ?? p?.avg;
                                                    return price ? <span className="shrink-0 inline-flex items-center gap-0.5 text-[13px] font-mono text-slate-500"><PlatIcon size={12}/>{Number(price).toFixed(0)}</span> : null;
                                                })()}
                                            </button>
                                        );
                                    })}
                                </div>
                                )}
                                </div>
                            </div>
                        )
                    )}

                    {/* ARCANES */}
                    {activeTab === "arcanes" && (
                        inventory.arcanes.length === 0 ? (
                            <div className="bg-[#111119] rounded-xl border border-[#1e1e2d] p-8 text-center shadow-lg">
                                <p className="text-xs text-slate-500">No arcanes found.</p>
                                {inventory.scanned_at && (
                                    <p className="text-xs text-slate-600 mt-2 font-mono">Last scan: {new Date(inventory.scanned_at).toLocaleString()}</p>
                                )}
                            </div>
                        ) : (
                            <div className="bg-[#111119] rounded-xl border border-[#1e1e2d] shadow-lg flex flex-col min-h-0">
                                <div className="bg-slate-950/60 px-5 py-3 border-b border-[#1e1e2d] flex justify-between items-center">
                                    <span className="text-xs font-mono font-bold text-slate-400 uppercase">ARCANE INVENTORY</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-cyan-400 font-mono font-bold">{currentList.length} items</span>
                                        {!busy ? (
                                            <button onClick={handleStart}
                                                    className="text-[10px] font-bold text-indigo-400 bg-indigo-950/30 border border-indigo-500/15 px-2 py-0.5 rounded hover:bg-indigo-900/30 transition-colors">
                                                Scan
                                            </button>
                                        ) : scanning ? (
                                            <button onClick={handleStop}
                                                    className="text-[10px] font-bold text-red-400 hover:bg-red-900/20 px-2 py-0.5 rounded transition-colors">
                                                Stop
                                            </button>
                                        ) : (
                                            <span className="text-[10px] text-indigo-400 animate-pulse">OCR...</span>
                                        )}
                                    </div>
                                </div>
                                <div className="border-b border-[#1e1e2d]/50 bg-slate-950/30 px-4 py-1.5 flex items-center gap-2">
                                    <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Sort:</span>
                                    {(["name", "price", "rarity"] as OrderBy[]).map((s) => (
                                        <button key={s} onClick={() => setArcaneOrderBy(s)}
                                            className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border capitalize transition-all ${
                                                arcaneOrderBy === s ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30" : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                            }`}>{s}</button>
                                    ))}
                                    <div className="relative ml-auto" ref={arcaneFilterMenuRef}>
                                        <button
                                            onClick={() => setShowArcaneFilterMenu((v) => !v)}
                                            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold font-mono rounded border transition-all ${
                                                arcaneTypeFilter
                                                    ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                    : "bg-transparent text-slate-500 border-transparent hover:text-slate-200"
                                            }`}>
                                            <SlidersHorizontal size={10} />
                                            {arcaneTypeFilter ?? "More"}
                                        </button>
                                        {showArcaneFilterMenu && (
                                            <div className="absolute right-0 top-full z-[200] mt-1 w-56 rounded-xl border border-slate-800 bg-[#0e0e16] shadow-2xl p-3 space-y-3">
                                                <div>
                                                    <p className="text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 mb-1.5">Class</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {[null, "Warframe", "Operator", "Primary", "Secondary", "Melee", "Shotgun", "Bow", "Amp", "Kitgun", "Zaw"].map((t) => (
                                                            <button key={t ?? "all"} onClick={() => setArcaneTypeFilter(t)}
                                                                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold rounded border transition-all ${
                                                                        arcaneTypeFilter === t
                                                                            ? "bg-indigo-950/60 text-indigo-300 border-indigo-500/30"
                                                                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200"
                                                                    }`}>
                                                                {t ?? "All"}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                {arcaneTypeFilter && (
                                                    <button onClick={() => setArcaneTypeFilter(null)}
                                                            className="w-full text-[9px] font-mono font-bold text-slate-500 hover:text-slate-300 transition-colors text-center">
                                                        Clear filter
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                                {currentList.length === 0 ? (
                                    <p className="p-6 text-center text-xs text-slate-500">No arcanes match the active filter.</p>
                                ) : (
                                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                                    {currentList.map((name) => {
                                        const rarity = itemRarities.get(name.toLowerCase());
                                        const selected = selectedArcaneName === name;
                                        return (
                                            <button
                                                key={name}
                                                onClick={() => handleSelectArcane(name)}
                                                className={`space-y-2 rounded-xl border p-3.5 text-left transition-colors ${
                                                    selected
                                                        ? "border-cyan-500/30 bg-indigo-950/30 ring-1 ring-inset ring-cyan-400/20"
                                                        : "border-[#1e1e2d] bg-[#111119] hover:border-slate-700 hover:bg-slate-900/20"
                                                }`}
                                            >
                                                <div className="flex justify-between items-start gap-2">
                                                    <span className="text-xs font-bold text-slate-200 font-sans">{name}</span>
                                                    <div className="flex items-center gap-1.5 shrink-0">
                                                        {(() => {
                                                            const p = itemsPrices.get(name);
                                                            const price = p?.sell ?? p?.avg;
                                                            return price ? <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-slate-500"><PlatIcon size={10}/>{Number(price).toFixed(0)}</span> : null;
                                                        })()}
                                                    </div>
                                                </div>
                                                {rarity && (
                                                    <div className="flex justify-between items-center text-xs font-mono pt-1">
                                                        <span className={`font-bold uppercase text-xs ${
                                                            rarity === 'Legendary' ? 'text-amber-400' : rarity === 'Rare' ? 'text-purple-400' : 'text-slate-400'
                                                        }`}>{rarity}</span>
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                                )}
                                </div>
                            </div>
                        )
                    )}

                </div>

                {/* Prime sell panel */}
                {activeTab === "prime_parts" && (
                    <div className="xl:col-span-3 min-h-0 flex flex-col">
                        <div className="bg-[#111119] border border-[#1e1e2d] rounded-xl p-4 shadow-lg flex flex-1 flex-col min-h-0 space-y-3 overflow-y-auto custom-scrollbar">
                            <div className="border-b border-slate-950 pb-2 flex items-center justify-between">
                                <span className="text-xs font-bold font-mono tracking-wider text-emerald-400 uppercase">
                                    {primePanelPart ? "SELL PART" : "SET INFO"}
                                </span>
                                <button onClick={closePrimePanel} className="text-slate-500 hover:text-slate-200 text-base leading-none">✕</button>
                            </div>

                            {!primePanelPart && !primePanelSet && (
                                <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-4 text-center">
                                    <p className="text-xs font-mono uppercase tracking-wide text-slate-500">
                                        Select a part to sell or a set name for overview.
                                    </p>
                                </div>
                            )}

                            {primePanelPart && (() => {
                                return (
                                    <>
                                        <div className="flex w-full items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden py-3">
                                            {primePreviewImgUrl ? (
                                                <PrimePreviewImg primarySrc={primePreviewImgUrl} fallbackName={primePanelPart}
                                                     alt={primePanelPart}
                                                     className="w-24 h-24 object-contain"
                                                     style={{imageRendering: "pixelated"}} />
                                            ) : (
                                                <span className="text-xs text-slate-600 font-mono">No preview</span>
                                            )}
                                        </div>
                                        <div className="text-center">
                                            <h2 className="text-sm font-bold text-slate-100">{primePanelPart}</h2>
                                            {selectedItemPrice && (() => {
                                                const {unranked} = selectedItemPrice;
                                                const p = itemsPrices.get(primePanelPart) || {};
                                                const parts = [];
                                                if (p.ducats) parts.push(<span key="ducats" className="inline-flex items-center gap-1"><DucatIcon size={11}/>{p.ducats}</span>);
                                                return (
                                                    <div className="flex items-center gap-2 pt-1 justify-center">
                                                        <button onClick={() => navigate("/market", { state: { autoSearch: primePanelPart } })}
                                                                className="flex items-center gap-1 rounded border border-amber-500/20 bg-amber-950/30 px-2 py-0.5 text-[13px] font-bold text-amber-400 hover:bg-amber-900/40 transition-colors">
                                                            WTB <PlatIcon size={10}/> {unranked.sellPrice?.toFixed(0) ?? '—'}
                                                        </button>
                                                        <button onClick={() => navigate("/market", { state: { autoSearch: primePanelPart } })}
                                                                className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-[13px] font-bold text-emerald-400 hover:bg-emerald-900/40 transition-colors">
                                                            WTS <PlatIcon size={9}/> {unranked.buyPrice?.toFixed(0) ?? '—'}
                                                        </button>
                                                        <button className="flex items-center gap-1 rounded border border-yellow-500/20 bg-yellow-950/30 px-2 py-0.5 text-[13px] font-bold text-yellow-400 hover:bg-yellow-900/40 transition-colors">
                                                            {parts}
                                                        </button>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                        {!isLoggedIn ? (
                                            <p className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3 text-xs leading-relaxed text-amber-200/80">
                                                Log in to warframe.market in Settings to post orders.
                                            </p>
                                        ) : (
                                            <form className="space-y-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3"
                                                  onSubmit={(e) => { e.preventDefault(); void handleSellSubmit(); }}>
                                                <div className="flex flex-col gap-1">
                                                    <label className="text-xs text-slate-400">Market item</label>
                                                    <AutocompleteField
                                                        value={sellSlugQuery}
                                                        options={allItemSlugs}
                                                        onChange={(v) => { setSellSlugQuery(v); setSellSlug(null); setSellSuccess(null); }}
                                                        onSelect={(it) => { setSellSlugQuery(it.name); setSellSlug(it.slug); setSellSuccess(null); }}
                                                        placeholder="Search warframe.market..."
                                                        minQueryLength={2}
                                                    />
                                                </div>
                                                <div className="grid grid-cols-2 gap-2">
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-xs text-slate-400">Price (platinum)</label>
                                                        <input type="number" min={1} value={sellPrice}
                                                               onChange={(e) => { setSellPrice(Number(e.target.value)); setSellSuccess(null); }}
                                                               className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none" />
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-xs text-slate-400">Qty</label>
                                                        <input type="number" min={1} value={sellQuantity}
                                                               onChange={(e) => { setSellQuantity(Math.max(1, Number(e.target.value))); setSellSuccess(null); }}
                                                               className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none" />
                                                    </div>
                                                </div>
                                                {sellError && <p className="text-xs text-red-400">{sellError}</p>}
                                                {sellSuccess && <p className="text-xs text-emerald-400">{sellSuccess}</p>}
                                                <button type="submit"
                                                        disabled={sellSubmitting || !sellSlug || sellPrice < 1}
                                                        className="w-full rounded-lg bg-primary-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-50">
                                                    {sellSubmitting ? "Posting..." : "Post to market"}
                                                </button>
                                            </form>
                                        )}
                                    </>
                                );
                            })()}

                            {primePanelSet && (() => {
                                const displayParts = getDisplayParts(primePanelSet);
                                const have = displayParts.filter((p) => scannedSet.has(p)).length;
                                const total = displayParts.length;
                                const complete = have === total;
                                return (
                                    <>
                                        <div className="flex aspect-square w-full items-center justify-center rounded-xl border border-slate-800 bg-slate-950/60 overflow-hidden">
                                            {primePreviewImgUrl ? (
                                                <PrimePreviewImg primarySrc={primePreviewImgUrl} fallbackName={primePanelSet.name}
                                                     alt={primePanelSet.name}
                                                     className="w-full h-full object-contain p-3" />
                                            ) : (
                                                <span className="text-xs text-slate-600 font-mono">No preview</span>
                                            )}
                                        </div>
                                        <div className="text-center">
                                            <h2 className="text-sm font-bold text-slate-100">{primePanelSet.name}</h2>
                                            <p className="text-xs text-slate-500">Prime Set</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 h-1 bg-slate-950 rounded-full overflow-hidden">
                                                <div style={{ width: `${(have / total) * 100}%` }}
                                                     className={`h-full transition-all ${complete ? "bg-emerald-400" : "bg-indigo-400"}`} />
                                            </div>
                                            <span className={`text-xs font-mono font-bold ${complete ? "text-emerald-400" : "text-slate-400"}`}>{have}/{total}</span>
                                        </div>
                                            <div className="space-y-1.5">
                                                {displayParts.map((part) => {
                                                    const owned = scannedSet.has(part);
                                                    const label = part.replace(`${primePanelSet.name} `, "");
                                                    const pp = itemsPrices.get(part);
                                                    const partPrice = pp ? (pp.sell ?? pp.avg) : null;
                                                    return (
                                                        <div key={part} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded ${owned ? "text-slate-300" : "text-slate-600"}`}>
                                                            <span className={owned ? "text-emerald-400" : "text-slate-700"}>{owned ? "✓" : "✗"}</span>
                                                            <span>{label}</span>
                                                            {partPrice !== null && (
                                                                <span className="ml-auto text-[10px] font-mono text-slate-500 flex items-center gap-1">
                                                                    <PlatIcon size={10}/>{Number(partPrice).toFixed(0)}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                        </div>
                                        {selectedItemPrice && (() => {
                                            const {unranked} = selectedItemPrice;
                                            return (
                                                <div className="flex items-center gap-2 justify-center pt-1">
                                                    <button onClick={() => navigate("/market", { state: { autoSearch: primePanelSet.name } })}
                                                            className="flex items-center gap-1 rounded border border-amber-500/20 bg-amber-950/30 px-2 py-0.5 text-[13px] font-bold text-amber-400 hover:bg-amber-900/40 transition-colors">
                                                        WTB <PlatIcon size={10}/> {unranked.sellPrice?.toFixed(0) ?? '—'}
                                                    </button>
                                                    <button onClick={() => navigate("/market", { state: { autoSearch: primePanelSet.name } })}
                                                            className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-[13px] font-bold text-emerald-400 hover:bg-emerald-900/40 transition-colors">
                                                        WTS <PlatIcon size={9}/> {unranked.buyPrice?.toFixed(0) ?? '—'}
                                                    </button>
                                                </div>
                                            );
                                        })()}
                                        {!isLoggedIn ? (
                                            <p className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3 text-xs leading-relaxed text-amber-200/80">
                                                Log in to warframe.market in Settings to post orders.
                                            </p>
                                        ) : (
                                            <form className="space-y-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3"
                                                  onSubmit={(e) => { e.preventDefault(); void handleSellSubmit(); }}>
                                                <div className="flex flex-col gap-1">
                                                    <label className="text-xs text-slate-400">Market item</label>
                                                    <AutocompleteField
                                                        value={sellSlugQuery}
                                                        options={allItemSlugs}
                                                        onChange={(v) => { setSellSlugQuery(v); setSellSlug(null); setSellSuccess(null); }}
                                                        onSelect={(it) => { setSellSlugQuery(it.name); setSellSlug(it.slug); setSellSuccess(null); }}
                                                        placeholder="Search warframe.market..."
                                                        minQueryLength={2}
                                                    />
                                                </div>
                                                <div className="grid grid-cols-2 gap-2">
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-xs text-slate-400">Price (platinum)</label>
                                                        <input type="number" min={1} value={sellPrice}
                                                               onChange={(e) => { setSellPrice(Number(e.target.value)); setSellSuccess(null); }}
                                                               className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none" />
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-xs text-slate-400">Qty</label>
                                                        <input type="number" min={1} value={sellQuantity}
                                                               onChange={(e) => { setSellQuantity(Math.max(1, Number(e.target.value))); setSellSuccess(null); }}
                                                               className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none" />
                                                    </div>
                                                </div>
                                                {sellError && <p className="text-xs text-red-400">{sellError}</p>}
                                                {sellSuccess && <p className="text-xs text-emerald-400">{sellSuccess}</p>}
                                                <button type="submit"
                                                        disabled={sellSubmitting || !sellSlug || sellPrice < 1}
                                                        className="w-full rounded-lg bg-primary-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-50">
                                                    {sellSubmitting ? "Posting..." : "Post to market"}
                                                </button>
                                            </form>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                )}

                {/* Sync Panel for mods/arcanes */}
                {activeTab !== "prime_parts" && (
                    <div className="xl:col-span-3 min-h-0 flex flex-col">
                        <div className="bg-[#111119] border border-[#1e1e2d] rounded-xl p-4 shadow-lg flex flex-1 flex-col min-h-0 space-y-3">
                            <div className="border-b border-slate-950 pb-2 flex items-center justify-between">
                                <span className="text-xs font-bold font-mono tracking-wider text-slate-400 uppercase">WFHUB Sync</span>
                                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                            </div>
                            <p className="text-xs text-slate-400 leading-normal">
                                Status of your inventory sync with WFHUB Companion.
                            </p>
                            {busy ? (
                                <div className="space-y-2 bg-slate-950 p-3 rounded-lg border border-slate-800">
                                    <div className="flex justify-between text-xs font-mono font-bold">
                                        <span className="text-indigo-400 animate-pulse tracking-wide">
                                            {scanning ? 'CAPTURING...' : 'PROCESSING...'}
                                        </span>
                                        <span>{liveCount}</span>
                                    </div>
                                    <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden">
                                        <div className="bg-indigo-400 h-full transition-all duration-300" style={{ width: scanning ? '40%' : '80%' }} />
                                    </div>
                                </div>
                            ) : null}
                            {statusText() && (
                                <div className="flex items-center gap-1.5 text-xs text-slate-500 font-mono">
                                    <span className={`w-1.5 h-1.5 rounded-full ${scanning ? 'bg-indigo-400 animate-pulse' : 'bg-cyan-400'}`} />
                                    {statusText()}
                                </div>
                            )}
                            {inventory.scanned_at && (
                                <p className="text-xs text-slate-600 font-mono">
                                    Last scan: {new Date(inventory.scanned_at).toLocaleString()}
                                </p>
                            )}
                            {(activeTab === "mods" || activeTab === "arcanes") && (
                                <div className="border-t border-slate-900 pt-3">
                                    {!selectedPreviewName ? (
                                        <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-4 text-center">
                                            <p className="text-xs font-mono uppercase tracking-wide text-slate-500">
                                                        Select a {selectedPreviewType} to preview and list on the market.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="space-y-3 flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
                                            <div className="space-y-2">
                                                {activeTab === "arcanes" ? (
                                                    <ArcanePreviewCard arcane={selectedArcaneImage} name={selectedPreviewName} rarity={selectedPreviewRarity} />
                                                ) : (
                                                    <ModPreviewImage modImage={selectedPreviewImage} name={selectedPreviewName} />
                                                )}
                                                <div className="items-center justify-center text-center">
                                                    <h3 className="truncate text-sm font-bold text-slate-100">{selectedPreviewName}</h3>
                                                    {selectedItemPrice && (() => {
                                                        const {unranked, ranked, maxRank} = selectedItemPrice;
                                                        return (
                                                            <div className="flex flex-col items-center gap-1.5 pt-2">
                                                                <div className="flex items-center gap-2 justify-center">
                                                                    <button onClick={() => navigate("/market", { state: { autoSearch: selectedPreviewName } })}
                                                                            className="flex items-center gap-1 rounded border border-amber-500/20 bg-amber-950/30 px-2 py-0.5 text-[13px] font-bold text-amber-400 hover:bg-amber-900/40 transition-colors">
                                                                        WTB <PlatIcon size={10}/> {unranked.sellPrice?.toFixed(0) ?? '—'}
                                                                    </button>
                                                                    <button onClick={() => navigate("/market", { state: { autoSearch: selectedPreviewName } })}
                                                                            className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-[13px] font-bold text-emerald-400 hover:bg-emerald-900/40 transition-colors">
                                                                        WTS <PlatIcon size={9}/> {unranked.buyPrice?.toFixed(0) ?? '—'}
                                                                    </button>
                                                                </div>
                                                                {ranked && maxRank !== null && (
                                                                    <div className="flex items-center gap-2 justify-center">
                                                                        <button onClick={() => navigate("/market", { state: { autoSearch: selectedPreviewName } })}
                                                                                className="flex items-center gap-1 rounded border border-amber-500/20 bg-amber-950/30 px-2 py-0.5 text-[10px] font-bold text-amber-400/80 hover:bg-amber-900/40 transition-colors">
                                                                            WTB R{maxRank} <PlatIcon size={10}/> {ranked.sellPrice?.toFixed(0) ?? '—'}
                                                                        </button>
                                                                        <button onClick={() => navigate("/market", { state: { autoSearch: selectedPreviewName } })}
                                                                                className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-950/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400/80 hover:bg-emerald-900/40 transition-colors">
                                                                            WTS R{maxRank} <PlatIcon size={10}/> {ranked.buyPrice?.toFixed(0) ?? '—'}
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                            </div>

                                            {!isLoggedIn ? (
                                                <p className="rounded-lg border border-amber-500/20 bg-amber-950/10 p-3 text-xs leading-relaxed text-amber-200/80">
                                                    Log in to warframe.market in Settings to post orders.
                                                </p>
                                            ) : (
                                                <form
                                                    className="space-y-3 rounded-lg border border-slate-900 bg-slate-950/40 p-3"
                                                    onSubmit={(e) => {
                                                        e.preventDefault();
                                                        handleSellSubmit();
                                                    }}
                                                >
                                                    <div className="flex flex-col gap-1">
                                                        <label className="text-xs text-slate-400">Market item</label>
                                                        <AutocompleteField
                                                            value={sellSlugQuery}
                                                            options={allItemSlugs}
                                                            onChange={(v) => { setSellSlugQuery(v); setSellSlug(null); setSellSuccess(null); }}
                                                            onSelect={(item) => { setSellSlugQuery(item.name); setSellSlug(item.slug); setSellSuccess(null); }}
                                                            placeholder="Search warframe.market item..."
                                                            minQueryLength={2}
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-3 gap-2">
                                                        <div className="flex flex-col gap-1">
                                                            <label className="text-xs text-slate-400">Price</label>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                value={sellPrice}
                                                                onChange={(e) => { setSellPrice(Number(e.target.value)); setSellSuccess(null); }}
                                                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none"
                                                            />
                                                        </div>
                                                        <div className="flex flex-col gap-1">
                                                            <label className="text-xs text-slate-400">Qty</label>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                value={sellQuantity}
                                                                onChange={(e) => { setSellQuantity(Math.max(1, Number(e.target.value))); setSellSuccess(null); }}
                                                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none"
                                                            />
                                                        </div>
                                                        <div className="flex flex-col gap-1">
                                                            <label className="text-xs text-slate-400">Rank {itemMaxRank !== null && <span className="text-slate-600">(max R{itemMaxRank})</span>}</label>
                                                            <input
                                                                type="number"
                                                                min={0}
                                                                max={itemMaxRank ?? undefined}
                                                                placeholder={itemMaxRank !== null ? `0-${itemMaxRank}` : "optional"}
                                                                value={sellRank ?? ""}
                                                                onChange={(e) => {
                                                                    const v = e.target.value.trim();
                                                                    const num = v === "" ? null : Number(v);
                                                                    if (num !== null && itemMaxRank !== null && num > itemMaxRank) {
                                                                        setSellRank(itemMaxRank);
                                                                    } else {
                                                                        setSellRank(num);
                                                                    }
                                                                    setSellSuccess(null);
                                                                }}
                                                                className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 focus:border-primary-500 focus:outline-none"
                                                            />
                                                        </div>
                                                    </div>
                                                    {sellError && <p className="text-xs text-red-400">{sellError}</p>}
                                                    {sellSuccess && <p className="text-xs text-emerald-400">{sellSuccess}</p>}
                                                    <button
                                                        type="submit"
                                                        disabled={sellSubmitting || !sellSlug || sellPrice < 1}
                                                        className="w-full rounded-lg bg-primary-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-primary-400 disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        {sellSubmitting ? "Posting..." : "Post to market"}
                                                    </button>
                                                </form>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Void History Modal */}
            {showVoidHistory && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
                     onMouseDown={(e) => { if (e.target === e.currentTarget) setShowVoidHistory(false); }}>
                    <div className="bg-[#0b0b10] border border-[#1e1e2d] rounded-2xl w-full max-w-xl shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden text-slate-200">
                        <div className="bg-gradient-to-r from-[#111119] to-[#161625] px-6 py-4 border-b border-[#1e1e2d] flex justify-between items-center">
                            <div className="flex items-center gap-2 text-cyan-400">
                                <History size={16} />
                                <h3 className="font-bold text-sm uppercase tracking-wide">Void Reward History</h3>
                            </div>
                            <button onClick={() => setShowVoidHistory(false)}
                                    className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer text-xs uppercase font-mono font-bold">
                                Close [X]
                            </button>
                        </div>
                        <div className="p-6 space-y-4 max-h-[450px] overflow-y-auto custom-scrollbar">
                            {!historyLoaded ? (
                                <p className="text-sm text-slate-500">Loading...</p>
                            ) : rewardHistory.length === 0 ? (
                                <p className="text-sm text-slate-500">No rewards recorded yet. Play a mission!</p>
                            ) : (
                                <div className="space-y-3">
                                    {rewardHistory.map((entry, i) => {
                                        const best = entry.items.find((it) => it.is_best);
                                        return (
                                            <div key={i} className="bg-[#121219] border border-slate-900 rounded-xl p-3.5 space-y-2.5">
                                                <div className="flex justify-between items-start text-xs font-mono">
                                                    <span className="text-slate-400">{formatDate(entry.timestamp)}</span>
                                                    {best && best.platinum > 0 && (
                                                        <span className="text-cyan-400 font-bold bg-[#14232c] px-2 py-0.5 rounded border border-cyan-500/10">
                                                            <PlatIcon size={10}/> {best.platinum.toFixed(0)} PL
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    {entry.items.map((item, j) => (
                                                        <span key={j}
                                                              className={`text-xs px-2 py-1 rounded-md border font-mono ${
                                                                  item.is_best
                                                                      ? 'border-primary-500/60 bg-primary-500/10 text-primary-300'
                                                                      : 'border-slate-800 text-slate-400'
                                                              }`}>
                                                            {item.name}
                                                            {item.platinum > 0 && (
                                                                <span className="ml-1 inline-flex items-center gap-0.5 text-yellow-500/70">
                                                                    <PlatIcon size={9}/>{item.platinum.toFixed(1)}
                                                                </span>
                                                            )}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div className="bg-slate-950/60 p-4 border-t border-slate-900 text-center font-mono">
                            <span className="text-xs text-slate-400">
                                Auto-synced from local WFHUB shared memory.
                            </span>
                        </div>
                    </div>
                </div>
            )}


            {/* Add Prime Modal */}
            {showModal && (
                <AddPrimeModal allPrimeParts={allPrimeParts} owned={new Set(inventory.prime_parts)}
                               onAdd={addPrimePart} onClose={() => setShowModal(false)} />
            )}


        </div>
    );
}
