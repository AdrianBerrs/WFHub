import {useDeferredValue, useEffect, useMemo, useRef, useState} from "react";
import {findFuzzyMatches, normalizeSearchText, type NamedItem} from "../lib/search";

export interface AutocompleteOption extends NamedItem {
    kind?: string;
}

interface AutocompleteFieldProps<T extends AutocompleteOption> {
    value: string;
    options: T[];
    onChange: (value: string) => void;
    onSelect: (item: T) => void;
    placeholder: string;
    buttonLabel?: string;
    onButtonClick?: () => void;
    disabled?: boolean;
    autoFocus?: boolean;
    minQueryLength?: number;
    emptyText?: string;
}

export function resolveAutocompleteOption<T extends AutocompleteOption>(options: T[], query: string): T | null {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return null;

    const exact = options.find((option) => normalizeSearchText(option.name) === normalizedQuery);
    if (exact) return exact;

    return findFuzzyMatches(options, query, 1)[0] ?? null;
}

export default function AutocompleteField<T extends AutocompleteOption>({
    value,
    options,
    onChange,
    onSelect,
    placeholder,
    buttonLabel,
    onButtonClick,
    disabled = false,
    autoFocus = false,
    minQueryLength = 3,
    emptyText = "No matches found.",
}: AutocompleteFieldProps<T>) {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const deferredValue = useDeferredValue(value);

    const suggestions = useMemo(() => {
        if (disabled || deferredValue.trim().length < minQueryLength) {
            return [] as T[];
        }
        return findFuzzyMatches(options, deferredValue, 8);
    }, [deferredValue, disabled, minQueryLength, options]);

    useEffect(() => {
        if (!isOpen) return;

        function handleClick(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [isOpen]);

    function handleSelect(item: T) {
        onSelect(item);
        setIsOpen(false);
    }

    const showEmptyState = isOpen && value.trim().length >= minQueryLength && suggestions.length === 0;

    return (
        <div className="relative" ref={dropdownRef}>
            <div className="flex gap-2">
                <input
                    autoFocus={autoFocus}
                    type="text"
                    value={value}
                    onChange={(event) => {
                        onChange(event.target.value);
                        setIsOpen(true);
                    }}
                    onFocus={() => {
                        if (value.trim().length >= minQueryLength) {
                            setIsOpen(true);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            setIsOpen(false);
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            const firstSuggestion = suggestions[0] ?? resolveAutocompleteOption(options, value);
                            if (firstSuggestion) {
                                handleSelect(firstSuggestion);
                                return;
                            }
                            onButtonClick?.();
                        }
                    }}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="flex-1 rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs font-medium text-slate-100 placeholder-slate-500 transition-all focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500/30 disabled:opacity-40"
                />
                {buttonLabel && onButtonClick && (
                    <button
                        type="button"
                        onClick={onButtonClick}
                        disabled={disabled}
                        className="rounded-lg border border-cyan-500/20 bg-cyan-950/20 px-3 py-2 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-950/35 disabled:opacity-40"
                    >
                        {buttonLabel}
                    </button>
                )}
            </div>

            {isOpen && suggestions.length > 0 && (
                <div className="custom-scrollbar absolute left-0 right-0 top-full z-20 mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-800 bg-[#12121a] shadow-2xl">
                    {suggestions.map((item) => (
                        <button
                            key={`${item.kind ?? "item"}:${item.name}`}
                            type="button"
                            onMouseDown={() => handleSelect(item)}
                            className="flex w-full items-center justify-between gap-3 border-b border-slate-900/70 px-4 py-2.5 text-left text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-900/50 hover:text-cyan-300 last:border-0"
                        >
                            <span className="truncate">{item.name}</span>
                            {item.kind && (
                                <span className="shrink-0 rounded-full border border-slate-700 bg-slate-950/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                                    {item.kind}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {showEmptyState && (
                <div className="absolute left-0 right-0 top-full z-20 mt-2 rounded-lg border border-slate-800 bg-[#12121a] px-4 py-2 text-sm text-slate-400 shadow-xl">
                    {emptyText}
                </div>
            )}
        </div>
    );
}
