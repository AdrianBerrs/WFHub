export function wikiUrl(name: string): string {
    return `https://wiki.warframe.com/w/${name.replace(/\s+/g, "_")}`;
}
