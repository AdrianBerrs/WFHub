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
      "Vendidos pelo Baro Ki'Teer (vendedor itinerante) que aparece a cada 15 dias em um Relay. Exige Ducats, obtidos vendendo itens Prime, e Créditos.",
  },
  {
    key: "galvanized",
    location: "Arbiters of Hexis",
    extra:
      "Comprados no terminal dos Arbiters of Hexis em qualquer Relay. Exige Vitus Essence, que cai apenas em missões de Arbitration, desbloqueadas após completar o Mapa Estelar.",
  },
  {
    key: "archon",
    location: "Chipper",
    extra:
      "Comprados com o NPC Chipper no Acampamento do Drifter. Exige Stock, moeda obtida ao completar as missões semanais do Kahl-175.",
  },
  {
    key: "amalgam",
    location: "Thermia Fractures / Ropalolyst",
    extra:
      "Recompensas de marcos de pontuação no evento Thermia Fractures, em Orbis Vallis, ou drops raros ao derrotar o chefe Ropalolyst em Júpiter.",
  },
  {
    key: "umbral",
    location: "Jornada O Sacrifício",
    extra:
      'Ganhos automaticamente como recompensa ao completar a jornada principal "O Sacrifício". Não podem ser farmados repetidamente; cópias extras são compradas com o Cephalon Simaris.',
  },
  {
    key: "sacrificial",
    location: "Jornada O Sacrifício",
    extra:
      'Também são recompensas exclusivas da jornada "O Sacrifício". São os equivalentes aos Umbral, mas instalados em armas brancas.',
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
    rarity: "Especial",
    extra: rule.extra,
  }));
}
