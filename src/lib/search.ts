export interface NamedItem {
  name: string;
}

interface IndexedNamedItem<T extends NamedItem> {
  item: T;
  normalizedName: string;
  compactName: string;
  wordCount: number;
  firstChar: string;
}

export interface NameSearchIndex<T extends NamedItem> {
  exact: Map<string, IndexedNamedItem<T>>;
  byFirstChar: Map<string, IndexedNamedItem<T>[]>;
  all: IndexedNamedItem<T>[];
}

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSearchChar(value: string): string {
  return value.match(/[a-z0-9]/)?.[0] ?? "";
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function similarityScore(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

export function fuzzyMatch(name: string, query: string): boolean {
  const normalizedName = normalizeSearchText(name);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return false;
  if (normalizedName.includes(normalizedQuery)) return true;

  const queryWords = normalizedQuery.split(" ").filter((word) => word.length > 2);
  if (queryWords.length === 0) return false;

  const nameWords = normalizedName.split(" ");
  return queryWords.every((queryWord) =>
    nameWords.some((nameWord) => levenshtein(queryWord, nameWord) <= 2)
  );
}

export function findFuzzyMatches<T extends NamedItem>(
  items: T[],
  query: string,
  limit = 8,
): T[] {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < 3) return [];

  const direct: Array<{ item: T; index: number; length: number }> = [];
  const fuzzy: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const normalizedName = normalizeSearchText(item.name);
    const matchIndex = normalizedName.indexOf(normalizedQuery);
    if (matchIndex >= 0) {
      direct.push({ item, index: matchIndex, length: normalizedName.length });
      continue;
    }

    if (fuzzyMatch(item.name, normalizedQuery)) {
      fuzzy.push({ item, score: similarityScore(normalizedName, normalizedQuery) });
    }
  }

  direct.sort((left, right) => left.index - right.index || left.length - right.length);
  fuzzy.sort((left, right) => right.score - left.score);

  return [...direct.map((entry) => entry.item), ...fuzzy.map((entry) => entry.item)].slice(0, limit);
}

export function buildNameSearchIndex<T extends NamedItem>(items: T[]): NameSearchIndex<T> {
  const exact = new Map<string, IndexedNamedItem<T>>();
  const byFirstChar = new Map<string, IndexedNamedItem<T>[]>();
  const all: IndexedNamedItem<T>[] = [];

  for (const item of items) {
    const normalizedName = normalizeSearchText(item.name);
    if (!normalizedName || exact.has(normalizedName)) {
      continue;
    }

    const indexed: IndexedNamedItem<T> = {
      item,
      normalizedName,
      compactName: normalizedName.replace(/\s+/g, ""),
      wordCount: normalizedName.split(" ").length,
      firstChar: firstSearchChar(normalizedName),
    };

    exact.set(normalizedName, indexed);
    const bucket = byFirstChar.get(indexed.firstChar) ?? [];
    bucket.push(indexed);
    byFirstChar.set(indexed.firstChar, bucket);
    all.push(indexed);
  }

  return { exact, byFirstChar, all };
}

export function candidateMatchesFromIndex<T extends NamedItem>(
  index: NameSearchIndex<T>,
  query: string,
  limit = 96,
): Array<{ item: T; normalizedName: string }> {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const exact = index.exact.get(normalizedQuery);
  if (exact) {
    return [{ item: exact.item, normalizedName: exact.normalizedName }];
  }

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const wordCount = normalizedQuery.split(" ").length;
  const baseBucket = index.byFirstChar.get(firstSearchChar(normalizedQuery)) ?? index.all;

  const narrow = baseBucket.filter((entry) =>
    Math.abs(entry.wordCount - wordCount) <= 1
    && Math.abs(entry.normalizedName.length - normalizedQuery.length) <= 12
  );

  const fallback = narrow.length > 0
    ? narrow
    : baseBucket.filter((entry) =>
      entry.compactName.includes(compactQuery.slice(0, 4))
      || compactQuery.includes(entry.compactName.slice(0, 4))
    );

  return (fallback.length > 0 ? fallback : baseBucket)
    .slice(0, limit)
    .map((entry) => ({ item: entry.item, normalizedName: entry.normalizedName }));
}
