import type {FarmResult} from "./modSpecialSources";

export function sourceLabel(source: FarmResult["source"]): string {
    switch (source) {
        case "enemy":
            return "Enemy";
        case "mission":
            return "Mission";
        case "bounty":
            return "Bounty";
        case "special":
            return "Special";
        case "relic":
            return "Relic";
    }
}
