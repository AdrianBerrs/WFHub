import {useDeferredValue, useEffect, useId, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {findFuzzyMatches} from "../lib/search";
import {Swords} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type StatEntry = { stat: string; displayName: string; value: number };

type ParsedRiven = {
    modName: string | null;
    weaponGuess: string | null;
    positives: StatEntry[];
    negative: StatEntry | null;
    rerolls: number;
    mastery: number;
};

type OcrResult =
    | { mode: "single"; riven: ParsedRiven }
    | { mode: "compare"; riven1: ParsedRiven; riven2: ParsedRiven }
    | { error: string };

type PositivePattern = { must: string[]; groups: string[][] };
type NegativePattern = { freeNegatives: string[][] };
type WeaponRule = { prefer: string[]; positivePatterns?: PositivePattern[]; freeNegatives: string[] };
type RivenRules = Record<string, Record<string, WeaponRule>>;

type StatRating = "must" | "preferred" | "ok";
type NegRating = "free" | "killer" | "none";
type Verdict = "god_roll" | "good" | "decent" | "bad" | "unknown";

type RivenEval = {
    cls: string;
    positiveRatings: (StatEntry & { rating: StatRating })[];
    negRating: NegRating;
    verdict: Verdict;
    weaponKey: string;
    matchedPattern?: PositivePattern;
    negativePattern?: NegativePattern;
    mustMatched: number;
    mustTotal: number;
    preferredMatched: number;
    preferredNeeded: number;
};

type AuctionAttribute = {
    positive: boolean;
    url_name: string;
    value: number;
};

type AuctionEntry = {
    id: string;
    buyout_price?: number | null;
    starting_price?: number | null;
    owner: { ingame_name: string; status: string };
    item: {
        weapon_url_name: string;
        re_rolls: number;
        attributes: AuctionAttribute[];
    };
};

type AuctionResponse = {
    payload?: { auctions?: AuctionEntry[] };
};

type ValuationTier = "perfect" | "good" | "okay";

type ValuationBucket = {
    label: string;
    color: string;
    auctions: AuctionEntry[];
    prices: number[];
    url: string | null;
};

type ValuationResult = Record<ValuationTier, ValuationBucket>;

type ValuationState =
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "result"; data: ValuationResult };

function hasDetectedStats(riven: ParsedRiven): boolean {
    return riven.positives.length > 0 || riven.negative !== null;
}

function hasDetectedRivens(ocr: OcrResult): boolean {
    if ("error" in ocr) return false;
    if (ocr.mode === "single") return hasDetectedStats(ocr.riven);
    return hasDetectedStats(ocr.riven1) || hasDetectedStats(ocr.riven2);
}

function toWeaponUrlName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function normalizeAuctionStat(urlName: string): string | null {
    const normalized = urlName.toLowerCase();
    const aliases: Record<string, string> = {
        critical_chance: "critical_chance",
        critical_damage: "critical_damage",
        multishot: "multishot",
        "base_damage_/_melee_damage": "damage",
        base_damage: "damage",
        "fire_rate_/_attack_speed": "fire_rate",
        status_chance: "status_chance",
        status_duration: "status_duration",
        toxin_damage: "toxin",
        heat_damage: "heat",
        cold_damage: "cold",
        electricity_damage: "electricity",
        slash_damage: "slash",
        impact_damage: "impact",
        puncture_damage: "puncture",
        reload_speed: "reload_speed",
        punch_through: "punch_through",
        magazine_capacity: "magazine",
        ammo_maximum: "max_ammo",
        zoom: "zoom",
        recoil: "recoil",
        projectile_speed: "projectile_speed",
    };

    return aliases[normalized] ?? null;
}

function toAuctionStatUrlName(stat: string): string | null {
    const aliases: Record<string, string> = {
        critical_chance: "critical_chance",
        critical_damage: "critical_damage",
        multishot: "multishot",
        damage: "base_damage_/_melee_damage",
        fire_rate: "fire_rate_/_attack_speed",
        status_chance: "status_chance",
        status_duration: "status_duration",
        toxin: "toxin_damage",
        heat: "heat_damage",
        cold: "cold_damage",
        electricity: "electricity_damage",
        slash: "slash_damage",
        impact: "impact_damage",
        puncture: "puncture_damage",
        reload_speed: "reload_speed",
        punch_through: "punch_through",
        magazine: "magazine_capacity",
        max_ammo: "ammo_maximum",
        zoom: "zoom",
        recoil: "recoil",
        projectile_speed: "projectile_speed",
    };

    return aliases[stat] ?? null;
}

function auctionPrice(auction: AuctionEntry): number | null {
    return auction.buyout_price ?? auction.starting_price ?? null;
}

function createEmptyBucket(label: string, color: string): ValuationBucket {
    return {label, color, auctions: [], prices: [], url: null};
}

function buildValuationResult(): ValuationResult {
    return {
        perfect: createEmptyBucket("Perfect Match", "text-green-300 border-green-500/30 bg-green-500/10"),
        good: createEmptyBucket("Good Match", "text-primary-300 border-primary-500/30 bg-primary-500/10"),
        okay: createEmptyBucket("Okay Match", "text-sky-300 border-sky-500/30 bg-sky-500/10"),
    };
}

function valuateAuctions(riven: ParsedRiven, exactAuctions: AuctionEntry[], broadAuctions: AuctionEntry[]): ValuationResult {
    const result = buildValuationResult();
    const targetPositives = new Set(riven.positives.map((stat) => stat.stat));
    const targetNegative = riven.negative?.stat ?? null;
    const totalPositives = targetPositives.size;
    const merged = new Map<string, { auction: AuctionEntry; sameNegative: boolean; matchedPositives: number }>();

    function addCandidate(auction: AuctionEntry, sameNegative: boolean) {
        const normalizedPositiveStats = new Set(
            auction.item.attributes
                .filter((attribute) => attribute.positive)
                .map((attribute) => normalizeAuctionStat(attribute.url_name))
                .filter((value): value is string => Boolean(value))
        );
        const matchedPositives = Array.from(targetPositives).filter((stat) => normalizedPositiveStats.has(stat)).length;
        if (matchedPositives === 0) return;

        const existing = merged.get(auction.id);
        if (!existing || matchedPositives > existing.matchedPositives || sameNegative) {
            merged.set(auction.id, {auction, sameNegative, matchedPositives});
        }
    }

    exactAuctions.forEach((auction) => addCandidate(auction, true));
    broadAuctions.forEach((auction) => {
        const normalizedNegativeStats = new Set(
            auction.item.attributes
                .filter((attribute) => !attribute.positive)
                .map((attribute) => normalizeAuctionStat(attribute.url_name))
                .filter((value): value is string => Boolean(value))
        );
        addCandidate(auction, targetNegative ? normalizedNegativeStats.has(targetNegative) : false);
    });

    for (const {auction, sameNegative, matchedPositives} of merged.values()) {
        const price = auctionPrice(auction);
        if (price === null) continue;

        let bucket: ValuationBucket | null = null;
        if (matchedPositives === totalPositives && (!targetNegative || sameNegative)) {
            bucket = result.perfect;
        } else if (matchedPositives >= Math.max(totalPositives - 1, 2) && (sameNegative || !targetNegative)) {
            bucket = result.good;
        } else if (matchedPositives >= 1) {
            bucket = result.okay;
        }

        if (!bucket) continue;
        bucket.auctions.push(auction);
        bucket.prices.push(price);
    }

    for (const bucket of Object.values(result)) {
        bucket.auctions.sort((left, right) => (auctionPrice(left) ?? Number.MAX_SAFE_INTEGER) - (auctionPrice(right) ?? Number.MAX_SAFE_INTEGER));
        bucket.prices.sort((left, right) => left - right);
    }

    const positiveStats = riven.positives.map((stat) => stat.stat);
    result.perfect.url = result.perfect.auctions.length > 0
        ? buildRivenMarketUrl(riven.weaponGuess ?? "", positiveStats, targetNegative)
        : null;
    result.good.url = result.good.auctions.length > 0
        ? buildRivenMarketUrl(riven.weaponGuess ?? "", positiveStats.slice(0, Math.max(positiveStats.length - 1, 1)), targetNegative)
        : null;
    result.okay.url = result.okay.auctions.length > 0
        ? buildRivenMarketUrl(riven.weaponGuess ?? "", positiveStats.slice(0, 1), null)
        : null;

    return result;
}

function formatPriceBand(prices: number[]): string {
    if (prices.length === 0) return "No comps";
    if (prices.length === 1) return `${prices[0]}p`;
    const floor = prices[0];
    const median = prices[Math.floor(prices.length / 2)];
    return `${floor}p - ${median}p`;
}

function titleCaseWeapon(name: string): string {
    return name.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatStatLabel(stat: string): string {
    return stat
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function getWeaponOptions(rules: RivenRules) {
    return Array.from(
        new Map(
            Object.values(rules).flatMap((weapons) =>
                Object.keys(weapons).map((name) => [
                    name,
                    {name, displayName: titleCaseWeapon(name)},
                ] as const)
            )
        ).values()
    );
}

function getMustHaveStats(weaponName: string | null, rules: RivenRules, sample?: ParsedRiven): string[] {
    if (!weaponName) return [];
    const found = findWeapon(weaponName, rules);
    if (!found) return [];
    if (sample) {
        const evaluated = evaluateRiven({...sample, weaponGuess: weaponName}, rules);
        if (evaluated?.matchedPattern?.must?.length) {
            return evaluated.matchedPattern.must;
        }
    }
    return found.rule.positivePatterns?.[0]?.must ?? [];
}

function getAlternativeGroups(weaponName: string | null, rules: RivenRules, sample?: ParsedRiven): string[][] {
    if (!weaponName) return [];
    const found = findWeapon(weaponName, rules);
    if (!found) return [];
    if (sample) {
        const evaluated = evaluateRiven({...sample, weaponGuess: weaponName}, rules);
        if (evaluated?.matchedPattern?.groups?.length) {
            return evaluated.matchedPattern.groups;
        }
    }
    return found.rule.positivePatterns?.[0]?.groups ?? [];
}

function getFreeNegativeGroups(weaponName: string | null, rules: RivenRules, sample?: ParsedRiven): string[][] {
    if (!weaponName) return [];
    const found = findWeapon(weaponName, rules);
    if (!found) return [];
    if (sample) {
        const evaluated = evaluateRiven({...sample, weaponGuess: weaponName}, rules);
        if (evaluated?.negativePattern?.freeNegatives?.length) {
            return [Array.from(new Set(evaluated.negativePattern.freeNegatives.flat()))];
        }
    }

    return found.rule.freeNegatives.length ? [found.rule.freeNegatives] : [];
}

function buildRivenMarketUrl(weaponName: string, positiveStats: string[], negativeStat: string | null): string {
    const params = new URLSearchParams({
        type: "riven",
        weapon_url_name: toWeaponUrlName(weaponName),
    });

    const positiveUrlNames = positiveStats
        .map((stat) => toAuctionStatUrlName(stat))
        .filter((value): value is string => Boolean(value));
    if (positiveUrlNames.length > 0) {
        params.set("positive_stats", positiveUrlNames.join(","));
    }

    const negativeUrlName = negativeStat ? toAuctionStatUrlName(negativeStat) : null;
    if (negativeUrlName) {
        params.set("negative_stats", negativeUrlName);
    }

    return `https://warframe.market/auctions/search?${params.toString()}`;
}

type AnalyzerState =
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "result"; ocr: OcrResult; rules: RivenRules };

// ─── Evaluation logic ─────────────────────────────────────────────────────────

function findWeapon(name: string, rules: RivenRules): { cls: string; rule: WeaponRule } | null {
    const key = name.toLowerCase().trim();
    for (const [cls, weapons] of Object.entries(rules)) {
        if (weapons[key]) return {cls, rule: weapons[key]};
    }
    return null;
}

function evaluatePattern(pattern: PositivePattern, positives: StatEntry[]) {
    const stats = positives.map((entry) => entry.stat);
    const positiveCount = positives.length;
    const mustSet = new Set(pattern.must);
    const mustMatchedSet = new Set(stats.filter((stat) => mustSet.has(stat)));

    let groupMatches = 0;
    const preferredSet = new Set<string>();
    for (const group of pattern.groups) {
        const matchedInGroup = group.filter((stat) => stats.includes(stat));
        if (matchedInGroup.length > 0) {
            groupMatches += 1;
            matchedInGroup.forEach((stat) => preferredSet.add(stat));
        }
    }

    const preferredPool = Array.from(new Set(pattern.groups.flat()));
    const preferredNeeded = Math.max(0, positiveCount - pattern.must.length);
    const preferredMatched = stats.filter((stat) => preferredPool.includes(stat)).length;
    const requiredGroupCoverage = Math.min(preferredNeeded, pattern.groups.length);
    const groupsSatisfied = groupMatches >= requiredGroupCoverage;
    const fullPreferredSatisfied = preferredMatched >= preferredNeeded;

    return {
        mustMatched: mustMatchedSet.size,
        mustTotal: pattern.must.length,
        preferredMatched,
        preferredNeeded,
        groupMatches,
        groupsSatisfied,
        fullPreferredSatisfied,
        mustSet,
        preferredSet,
        score: mustMatchedSet.size * 100 + Math.min(preferredMatched, preferredNeeded) * 10 + groupMatches,
    };
}

function evaluateRiven(riven: ParsedRiven, rules: RivenRules): RivenEval | null {
    if (!riven.weaponGuess) return null;
    const found = findWeapon(riven.weaponGuess, rules);
    if (!found) return null;

    const {cls, rule} = found;
    const patterns = rule.positivePatterns?.length
        ? rule.positivePatterns
        : [{must: [], groups: [rule.prefer]}];
    const bestPatternResult = patterns
        .map((pattern) => ({pattern, result: evaluatePattern(pattern, riven.positives)}))
        .sort((left, right) => right.result.score - left.result.score)[0];
    const matchedPattern = bestPatternResult?.pattern;
    const patternResult = bestPatternResult?.result;

    const positiveRatings = riven.positives.map((s) => {
        const rating: StatRating = patternResult?.mustSet.has(s.stat)
            ? "must"
            : patternResult?.preferredSet.has(s.stat)
                ? "preferred"
                : "ok";
        return {...s, rating};
    });

    const negRating: NegRating = riven.negative
        ? rule.freeNegatives.includes(riven.negative.stat)
            ? "free"
            : "killer"
        : "none";

    let verdict: Verdict;
    if (patternResult && patternResult.mustMatched === patternResult.mustTotal && patternResult.fullPreferredSatisfied && (negRating === "free" || negRating === "none")) {
        verdict = "god_roll";
    } else if (patternResult && patternResult.mustMatched === patternResult.mustTotal && patternResult.fullPreferredSatisfied && negRating === "killer") {
        verdict = "good";
    } else if (patternResult && patternResult.mustMatched === patternResult.mustTotal && patternResult.groupsSatisfied && negRating !== "killer") {
        verdict = "decent";
    } else {
        verdict = "bad";
    }

    return {
        cls,
        positiveRatings,
        negRating,
        verdict,
        weaponKey: riven.weaponGuess.toLowerCase().trim(),
        matchedPattern,
        mustMatched: patternResult?.mustMatched ?? 0,
        mustTotal: patternResult?.mustTotal ?? 0,
        preferredMatched: patternResult?.preferredMatched ?? 0,
        preferredNeeded: patternResult?.preferredNeeded ?? 0,
    };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const CLASS_LABELS: Record<string, string> = {
    primary: "Primary",
    secondary: "Secondary",
    melee: "Melee",
    archgun: "Archgun",
    robotic: "Robotic",
};

const VERDICT_CONFIG: Record<Verdict, { label: string; color: string }> = {
    god_roll: {label: "God Roll", color: "bg-primary-500/20 text-primary-400 border-primary-500/30"},
    good: {label: "Good", color: "bg-green-500/20 text-green-300 border-green-500/30"},
    decent: {label: "Decent", color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30"},
    bad: {label: "Bad", color: "bg-red-500/20 text-red-300 border-red-500/30"},
    unknown: {label: "Unknown weapon", color: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"},
};

function RivenCombinedCard({
                               preview,
                               riven,
                               rules,
                               label,
                           }: {
    preview?: string;
    riven: ParsedRiven;
    rules: RivenRules;
    label: string;
}) {
    return (
        <div className="group rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-4">

            {/* HEADER */}
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {label}
            </p>

            {/* PREVIEW */}
            {preview && (
                <div className="relative h-64 overflow-hidden rounded-xl border border-zinc-700 bg-black/30">
                    <img
                        src={preview}
                        className="h-full w-full object-contain"
                        alt={"Preview"}/>
                </div>
            )}

            {/* ANALYSIS */}
            <RivenCard
                riven={riven}
                rules={rules}
                variant="flat"
            />
        </div>
    );
}

type RivenCardVariant = "default" | "flat";

function RivenCard({
                       riven,
                       rules,
                       label,
                       variant = "default",
                   }: {
    riven: ParsedRiven;
    rules: RivenRules;
    label?: string;
    variant?: RivenCardVariant;
}) {
    const [valuationState, setValuationState] = useState<ValuationState>({phase: "idle"});
    const activeWeapon = riven.weaponGuess ?? null;

    useEffect(() => {
        setValuationState({phase: "idle"});
    }, [riven.weaponGuess, riven.modName]);

    const rivenForEval = {...riven, weaponGuess: activeWeapon};
    const evaluation = evaluateRiven(rivenForEval, rules);

    const verdict = evaluation?.verdict ?? "unknown";
    const {label: verdictLabel, color: verdictColor} = VERDICT_CONFIG[verdict];

    async function handleValuate() {
        const weaponName = activeWeapon?.trim();
        if (!weaponName) return;

        setValuationState({phase: "loading"});
        try {
            const weaponUrlName = toWeaponUrlName(weaponName);
            const negativeStat = riven.negative?.stat ?? null;
            const positiveStats = riven.positives
                .map((stat) => toAuctionStatUrlName(stat.stat))
                .filter((value): value is string => Boolean(value))
                .join(",");
            const [exactRaw, broadRaw] = await Promise.all([
                invoke<string>("fetch_riven_auctions", {weaponUrlName, positiveStats, negativeStats: negativeStat}),
                invoke<string>("fetch_riven_auctions", {weaponUrlName, positiveStats: null, negativeStats: null}),
            ]);

            const exact = JSON.parse(exactRaw) as AuctionResponse;
            const broad = JSON.parse(broadRaw) as AuctionResponse;
            const exactAuctions = exact.payload?.auctions ?? [];
            const broadAuctions = broad.payload?.auctions ?? [];
            setValuationState({
                phase: "result",
                data: valuateAuctions(rivenForEval, exactAuctions, broadAuctions),
            });
        } catch (error) {
            setValuationState({phase: "error", message: String(error)});
        }
    }

    return (
        <div
            className={`flex flex-col gap-4 flex-1
                 ${variant === "default"
                ? "rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5"
                : "p-1"
            }
            `}
        >
            {label && <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</p>}

            {/* Weapon header */}
            <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
            <span className="text-base text-zinc-400">
              {riven.modName ?? "Mod name not detected"}
            </span>
                    </div>
                </div>
                <span className={`ml-auto rounded-lg border px-3 py-1 text-sm font-bold ${verdictColor}`}>
          {verdictLabel}
        </span>
            </div>

            {/* Inside */}
            <div className="flex flex-col gap-4 flex-1">
                {/* Stats */}
                <div className="space-y-1.5">
                    {evaluation
                        ? evaluation.positiveRatings.map((s) => (
                            <div key={s.stat} className="flex items-center gap-2 text-sm">
                                <span className="text-zinc-100">+</span>
                                <span
                                    className={s.rating === "must" ? "text-primary-400" : s.rating === "preferred" ? "text-sky-400" : "text-yellow-400"}>
                  {s.displayName}
                </span>
                                <span className="ml-auto text-zinc-400">{s.value.toFixed(1)}%</span>
                                <span
                                    className={`text-xs ${s.rating === "must" ? "text-primary-400" : s.rating === "preferred" ? "text-sky-500" : "text-yellow-500"}`}>
                  {s.rating === "must" ? "Must Have" : s.rating === "preferred" ? "Preferred" : "Ok"}
                </span>
                            </div>
                        ))
                        : riven.positives.map((s) => (
                            <div key={s.stat} className="flex items-center gap-2 text-sm">
                                <span className="text-zinc-500">+</span>
                                <span className="text-zinc-300">{s.displayName}</span>
                                <span className="ml-auto text-zinc-400">{s.value.toFixed(1)}%</span>
                            </div>
                        ))}

                    {riven.negative ? (
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-red-300">−</span>
                            <span
                                className={
                                    evaluation
                                        ? evaluation.negRating === "free"
                                            ? "text-emerald-300"
                                            : "text-red-400"
                                        : "text-red-300"
                                }
                            >
                              {riven.negative.displayName}
                            </span>
                            <span className="ml-auto text-zinc-400">{riven.negative.value.toFixed(1)}%</span>
                            {evaluation && (
                                <span
                                    className={`text-xs ${evaluation.negRating === "free" ? "text-emerald-400" : "text-red-500"}`}>
                                    {evaluation.negRating === "free" ? "Free" : "Killer"}
                                  </span>
                            )}
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 text-sm text-zinc-500">
                            <span className="text-zinc-500">−</span>
                            <span>No negative</span>
                        </div>
                    )}
                </div>

                {/* Meta */}
                <div className="flex gap-4 text-xs text-zinc-600 mt-auto ">
                    {riven.rerolls > 0 && <span>Rerolls: {riven.rerolls}</span>}
                    {riven.mastery > 0 && <span>MR: {riven.mastery}</span>}
                    {evaluation && evaluation.mustTotal > 0 &&
                        <span>Must: {evaluation.mustMatched}/{evaluation.mustTotal}</span>}
                    {evaluation && evaluation.preferredNeeded > 0 &&
                        <span>Alt: {Math.min(evaluation.preferredMatched, evaluation.preferredNeeded)}/{evaluation.preferredNeeded}</span>}
                </div>
            </div>

            {/* Market Valuate */}
            <div className="border-t border-zinc-800 pt-4 space-y-3 mt-auto">
                <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Market Valuate</p>
                    <button
                        onClick={handleValuate}
                        disabled={!activeWeapon || valuationState.phase === "loading"}
                        className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {valuationState.phase === "loading" ? "Searching..." : "Evaluate Cost"}
                    </button>
                </div>

                {valuationState.phase === "error" && (
                    <p className="text-xs text-red-400 break-all">{valuationState.message}</p>
                )}

                {valuationState.phase === "result" && (
                    <div className="space-y-3">
                        <div className="grid gap-2 sm:grid-cols-3">
                            {(["perfect", "good", "okay"] as const).map((tier) => {
                                const bucket = valuationState.data[tier];
                                return (
                                    <div key={tier} className={`rounded-xl border px-3 py-3 ${bucket.color}`}>
                                        <p className="text-xs font-semibold uppercase tracking-wide">{bucket.label}</p>
                                        <p className="mt-2 text-lg font-bold">{formatPriceBand(bucket.prices)}</p>
                                        <p className="mt-1 text-[11px] text-zinc-400">
                                            {bucket.auctions.length > 0 ? `${bucket.auctions.length} comps` : "No comps"}
                                        </p>
                                        {bucket.auctions[0] && (
                                            <p className="mt-2 text-[11px] text-zinc-400 truncate">
                                                Lowest: {bucket.auctions[0].owner.ingame_name} • {auctionPrice(bucket.auctions[0])}p
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {Object.values(valuationState.data).some((bucket) => bucket.url) && (
                            <div className="flex flex-wrap gap-2">
                                {(["perfect", "good", "okay"] as const).map((tier) => {
                                    const bucket = valuationState.data[tier];
                                    if (!bucket.url) return null;
                                    return (
                                        <a
                                            key={tier}
                                            href={bucket.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center rounded-lg border border-zinc-700 bg-zinc-800/70 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700/70 hover:text-zinc-100"
                                        >
                                            View {bucket.label.toLowerCase()}
                                        </a>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function RivenImagePreview({src, label}: { src: string; label: string }) {
    return (
        <div className="h-full flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#121622]">
            <div className="border-b border-zinc-800 px-4 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</p>
            </div>
            <div
                className="bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.10),transparent_45%),linear-gradient(180deg,#141926,#0b1020)] p-4 flex-1 flex flex-col">
                <div className="relative flex-1 overflow-hidden rounded-xl border border-zinc-700 bg-black/30">
                    <img src={src} alt={label} className="h-full w-full object-contain"/>
                </div>
            </div>
        </div>
    );
}

async function splitImageInHalf(
    blob: Blob,
): Promise<{ original: string; left: string; right: string }> {
    const original = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to load image"));
        img.src = original;
    });

    const halfW = Math.floor(img.naturalWidth / 2);
    const h = img.naturalHeight;

    const makeHalf = (offsetX: number) =>
        new Promise<string>((resolve) => {
            const canvas = document.createElement("canvas");
            canvas.width = halfW;
            canvas.height = h;
            canvas.getContext("2d")!.drawImage(img, -offsetX, 0);
            canvas.toBlob((b) => resolve(URL.createObjectURL(b!)), "image/png");
        });

    const [left, right] = await Promise.all([makeHalf(0), makeHalf(halfW)]);
    return {original, left, right};
}

// ─── Riven Analyzer ───────────────────────────────────────────────────────────

function RivenAnalyzer() {
    const [state, setState] = useState<AnalyzerState>({phase: "idle"});
    const [weaponOverrides, setWeaponOverrides] = useState<Record<string, string>>({});
    const [previewUrls, setPreviewUrls] = useState<{ original: string; left: string; right: string } | null>(null);
    const [weaponInput, setWeaponInput] = useState("");
    const loadingRef = useRef(false);
    const deferredWeaponInput = useDeferredValue(weaponInput);
    const weaponListId = useId();

    useEffect(() => {
        return () => {
            setPreviewUrls((current) => {
                if (current) {
                    URL.revokeObjectURL(current.original);
                    URL.revokeObjectURL(current.left);
                    URL.revokeObjectURL(current.right);
                }
                return null;
            });
        };
    }, []);

    useEffect(() => {
        async function handlePaste(e: ClipboardEvent) {
            if (!e.clipboardData) return;
            const items = Array.from(e.clipboardData.items);
            const imageItem = items.find((item) => item.type.startsWith("image/"));
            if (!imageItem) return;

            e.preventDefault();
            if (loadingRef.current) return;
            loadingRef.current = true;
            setState({phase: "loading"});
            setWeaponOverrides({});
            setWeaponInput("");

            const blob = imageItem.getAsFile();
            if (!blob) {
                setState({phase: "error", message: "Could not read the image from clipboard."});
                loadingRef.current = false;
                return;
            }

            try {
                const urls = await splitImageInHalf(blob);
                setPreviewUrls((current) => {
                    if (current) {
                        URL.revokeObjectURL(current.original);
                        URL.revokeObjectURL(current.left);
                        URL.revokeObjectURL(current.right);
                    }
                    return urls;
                });

                const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result as string;
                        resolve(result.split(",")[1]);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });

                const RIVEN_PATH = "/tmp/wfhub_riven_input.png";
                await invoke("save_temp_image", {base64Data: base64, path: RIVEN_PATH});

                const [ocrRaw, rulesRaw] = await Promise.all([
                    invoke<string>("analyze_riven_image", {imagePath: RIVEN_PATH}),
                    invoke<string>("read_riven_weapon_rules"),
                ]);

                const ocr: OcrResult = JSON.parse(ocrRaw);
                const rules: RivenRules = JSON.parse(rulesRaw);

                if ("error" in ocr) {
                    setState({phase: "result", ocr, rules});
                    return;
                }

                if (!hasDetectedRivens(ocr)) {
                    setState({phase: "error", message: "No riven detected in the image."});
                    return;
                }

                setState({phase: "result", ocr, rules});
            } catch (err) {
                setState({phase: "error", message: String(err)});
            } finally {
                loadingRef.current = false;
            }
        }

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, []);

    function handleReset() {
        setState({phase: "idle"});
        setWeaponOverrides({});
        setWeaponInput("");
        setPreviewUrls((current) => {
            if (current) {
                URL.revokeObjectURL(current.original);
                URL.revokeObjectURL(current.left);
                URL.revokeObjectURL(current.right);
            }
            return null;
        });
    }

    if (state.phase === "idle") {
        return (
            <div className="flex h-full items-center justify-center">
                <div
                    className="flex flex-col w-full items-center gap-4 rounded-2xl border border-dashed border-slate-800 bg-[#111119]/70 p-12 text-center">
                    <p className="text-4xl">⚔️</p>
                    <div className="space-y-1">
                        <p className="text-base font-semibold text-slate-200">Paste your riven screenshot here</p>
                        <p className="text-sm text-slate-500">Cmd+V with the riven screenshot</p>
                        <p className="text-xs text-slate-600">Accepts 1 or 2 rivens in the same image</p>
                    </div>
                </div>
            </div>
        );
    }

    if (state.phase === "loading") {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-3 text-center">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"/>
                    <p className="text-sm text-zinc-400">Analyzing riven...</p>
                </div>
            </div>
        );
    }

    if (state.phase === "error") {
        return (
            <div className="flex h-full items-center justify-center">
                <div
                    className="flex flex-col items-center gap-4 rounded-2xl border border-red-900/40 bg-red-950/20 p-8 text-center max-w-md">
                    <p className="text-sm font-semibold text-red-400">Error analyzing image</p>
                    <p className="text-xs text-red-500/80 break-all">{state.message}</p>
                    <button
                        onClick={handleReset}
                        className="rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                        Try again
                    </button>
                </div>
            </div>
        );
    }

    // result phase
    const {ocr, rules} = state;

    function applySharedWeapon() {
        const trimmed = weaponInput.trim();
        if (!trimmed) return;
        setWeaponOverrides((prev) => ({...prev, shared: trimmed}));
        setWeaponInput(trimmed);
    }

    if ("error" in ocr) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <p className="text-sm text-red-400">{ocr.error}</p>
                    <button onClick={handleReset}
                            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                        Clear
                    </button>
                </div>
            </div>
        );
    }

    const weaponOptions = getWeaponOptions(rules);
    const defaultWeapon = ocr.mode === "single"
        ? ocr.riven.weaponGuess ?? null
        : ocr.riven1.weaponGuess ?? ocr.riven2.weaponGuess ?? null;
    const sharedWeapon = weaponOverrides.shared ?? defaultWeapon;
    const sharedWeaponMatch = sharedWeapon ? findWeapon(sharedWeapon, rules) : null;
    const sharedWeaponClass = sharedWeaponMatch?.cls ?? null;
    const shouldShowWeaponSelector = !sharedWeaponMatch;
    const weaponSuggestions =
        deferredWeaponInput.trim().length >= 2
            ? findFuzzyMatches(weaponOptions, deferredWeaponInput, 8)
            : [];
    const mustHaveStats = getMustHaveStats(sharedWeapon, rules, ocr.mode === "single" ? ocr.riven : ocr.riven1);
    const alternativeGroups = getAlternativeGroups(sharedWeapon, rules, ocr.mode === "single" ? ocr.riven : ocr.riven1);
    const freeNegatives = getFreeNegativeGroups(sharedWeapon, rules, ocr.mode === "single" ? ocr.riven : ocr.riven1);
    const hasMust = mustHaveStats.length > 0;
    const hasAlternatives = alternativeGroups.length > 0;
    const hasFreeNegatives = freeNegatives.length > 0;
    const hasHeaderHints = hasMust || hasAlternatives || hasFreeNegatives;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-600">
                    {ocr.mode === "compare" ? "2 rivens detected" : "1 riven detected"} — paste another screenshot to replace
                </p>
                <button onClick={handleReset} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                    Clear
                </button>
            </div>

            <div className="space-y-3 rounded-2xl border border-[#1e1e2d] bg-[#111119] p-4">
                <div className="flex flex-wrap items-center gap-2">
                    {sharedWeapon ? (
                        <span
                            className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-500">
              {titleCaseWeapon(sharedWeapon)}{sharedWeaponClass ? ` - ${CLASS_LABELS[sharedWeaponClass.toLowerCase()] || sharedWeaponClass}` : ""}
            </span>
                    ) : (
                        <span className="text-sm text-zinc-500">Weapon not detected</span>
                    )}
                </div>

                {shouldShowWeaponSelector && (
                    <div className="space-y-2">
                        <p className="text-sm text-amber-300">
                            {sharedWeapon
                                ? `Could not match "${titleCaseWeapon(sharedWeapon)}". Set the weapon manually to evaluate this riven.`
                                : "Weapon not detected. Set the weapon manually to evaluate this riven."}
                        </p>
                        <div className="flex gap-2">
                        <input
                            value={weaponInput}
                            onChange={(e) => setWeaponInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && applySharedWeapon()}
                            list={weaponListId}
                            placeholder={sharedWeapon ? "Change weapon" : "Search weapon to apply to the riven"}
                            className="flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:border-primary-500/50 focus:outline-none"
                        />
                        <datalist id={weaponListId}>
                            {weaponSuggestions.map((weapon) => (
                                <option key={weapon.name} value={weapon.displayName}/>
                            ))}
                        </datalist>
                        <button
                            onClick={applySharedWeapon}
                            className="rounded-lg bg-primary-500/20 border border-primary-500/30 px-3 py-2 text-xs font-medium text-primary-300 hover:bg-primary-500/30 transition-colors"
                        >
                            Apply
                        </button>
                        </div>
                    </div>
                )}

                <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500"></p>
                    {hasHeaderHints ? (
                        <div className="flex flex-wrap items-start gap-6">

                            {/* MUST HAVE */}
                            {hasMust && (
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                        Must Have
                                    </p>

                                    <div className="flex flex-wrap gap-2">
                                        {mustHaveStats.map((stat) => (
                                            <span
                                                key={stat}
                                                className="rounded-lg border border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-xs font-medium text-primary-400"
                                            >  {formatStatLabel(stat)}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* ALTERNATIVES */}
                            {hasAlternatives && (
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                        Alternatives
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {alternativeGroups.map((group, index) => (
                                            <span
                                                key={`${index}-${group.join("-")}`}
                                                className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300"
                                            >
                                              {`${group
                                                  .map(formatStatLabel)
                                                  .join(" | ")}`}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* FREE NEGATIVES */}
                            {hasFreeNegatives && (
                                <div className="flex flex-col gap-2">
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                                        Free Negatives
                                    </p>

                                    <div className="flex flex-wrap gap-2">
                                        {freeNegatives.map((stat, index) => (
                                            <span
                                                key={`${index}-${stat.join("-")}`}
                                                className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1 text-xs text-red-300"
                                            >
                                                {`${stat
                                                    .map(formatStatLabel)
                                                    .join(" | ")}`}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                        </div>
                    ) : (
                        <p className="text-sm text-zinc-500">
                            {sharedWeapon
                                ? "No priority data for the current pattern."
                                : "Select a weapon to see priorities."}
                        </p>
                    )}
                </div>
            </div>

            {ocr.mode === "single" ? (
                <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)] items-stretch">
                    {previewUrls && (
                        <div className="xl:sticky xl:top-0">
                            <RivenImagePreview src={previewUrls.original} label="Riven"/>
                        </div>
                    )}
                    <RivenCard
                        key={`single-${ocr.riven.modName ?? "none"}-${ocr.riven.weaponGuess ?? "none"}`}
                        riven={sharedWeapon ? {...ocr.riven, weaponGuess: sharedWeapon} : ocr.riven}
                        rules={rules}
                    />
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 items-stretch">
                    <RivenCombinedCard
                        preview={previewUrls?.left}
                        label="Riven 1"
                        rules={rules}
                        riven={
                            sharedWeapon
                                ? {...ocr.riven1, weaponGuess: sharedWeapon}
                                : ocr.riven1
                        }
                    />
                    <RivenCombinedCard
                        preview={previewUrls?.right}
                        label="Riven 2"
                        rules={rules}
                        riven={
                            sharedWeapon
                                ? {...ocr.riven2, weaponGuess: sharedWeapon}
                                : ocr.riven2
                        }
                    />
                </div>
            )}
        </div>
    );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RivenAdvisorPage() {
    return (
        <div className="wf-page flex min-h-full flex-col gap-5">
            <div className="wf-panel p-5">
                <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-100">
                    <Swords size={20} className="text-red-400" />
                    Riven Analyzer
                </h1>
                <p className="mt-1 text-xs text-slate-400">
                    Evaluate rivens by pasting a screenshot with Cmd+V.
                </p>
            </div>

            <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
                <RivenAnalyzer/>
            </div>
        </div>
    );
}
