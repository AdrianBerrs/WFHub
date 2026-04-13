const RARITY_BADGE: Record<string, string> = {
    common: "bg-zinc-500/20 text-zinc-300 border-zinc-400/20",
    uncommon: "bg-sky-500/20 text-sky-300 border-sky-400/20",
    rare: "bg-purple-500/20 text-purple-300 border-purple-400/20",
    legendary: "bg-violet-500/20 text-violet-300 border-violet-400/20",
};

export function rarityBadgeClass(rarity: string): string {
    return RARITY_BADGE[rarity.toLowerCase()] ?? "bg-gray-500/20 text-gray-300 border-gray-400/20";
}
