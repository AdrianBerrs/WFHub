import {useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";

export interface Inventory {
    mods: string[];
    arcanes: string[];
    scanned_at?: string;
}

export function useInventory(): Inventory {
    const [inventory, setInventory] = useState<Inventory>({mods: [], arcanes: []});

    useEffect(() => {
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
    }, []);

    return inventory;
}
