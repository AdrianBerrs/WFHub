export interface FarmResult {
  source: "enemy" | "mission" | "bounty" | "special" | "relic";
  itemName: string;
  location: string;
  chance: number;
  itemChance?: number;
  dropTableChance?: number;
  rarity: string;
  extra: string;
  planets?: string[];
  tilesets?: string[];
  missionNodes?: { node: string; planet: string }[];
}

const MOD_SPECIAL_RULES = [
  {
    key: "primed",
    location: "Baro Ki'Teer",
    extra:
      "Sold by Baro Ki'Teer (the Void Trader) who appears every two weeks at a Relay. Requires Ducats, obtained by selling Prime items, and Credits.",
  },
  {
    key: "galvanized",
    location: "Arbiters of Hexis",
    extra:
      "Purchased from the Arbiters of Hexis terminal at any Relay. Requires Vitus Essence, which only drops in Arbitration missions, unlocked after completing the Star Chart.",
  },
  {
    key: "archon",
    location: "Chipper",
    extra:
      "Purchased from the NPC Chipper at the Drifter's Camp. Requires Stock, a currency earned by completing Kahl-175's weekly missions.",
  },
  {
    key: "amalgam",
    location: "Thermia Fractures / Ropalolyst",
    extra:
      "Rewards from score milestones in the Thermia Fractures event on Orb Vallis, or rare drops from defeating the Ropalolyst boss on Jupiter.",
  },
  {
    key: "umbral",
    location: "The Sacrifice Quest",
    extra:
      'Automatically earned as rewards by completing the main quest "The Sacrifice". Cannot be farmed repeatedly; extra copies are purchased from Cephalon Simaris.',
  },
  {
    key: "sacrificial",
    location: "The Sacrifice Quest",
    extra:
      'Also exclusive rewards from the quest "The Sacrifice". These are the Umbral equivalents, but installed on melee weapons.',
  },
] as const;

export function getSpecialModSources(name: string): FarmResult[] {
  const lowered = name.toLowerCase().trim();

  return MOD_SPECIAL_RULES.filter((rule) =>
    lowered.startsWith(rule.key) || lowered.includes(rule.key)
  ).map((rule) => ({
    source: "special" as const,
    itemName: name,
    location: rule.location,
    chance: 100,
    rarity: "Special",
    extra: rule.extra,
  }));
}
