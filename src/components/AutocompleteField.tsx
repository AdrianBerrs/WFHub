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
                    className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-500 focus:outline-none disabled:opacity-40"
                />
                {buttonLabel && onButtonClick && (
                    <button
                        type="button"
                        onClick={onButtonClick}
                        disabled={disabled}
                        className="rounded-lg border border-gray-700 px-3 py-2 text-sm font-semibold text-gray-200 transition-colors hover:bg-gray-800 disabled:opacity-40"
                    >
                        {buttonLabel}
                    </button>
                )}
            </div>

            {isOpen && suggestions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-gray-700 bg-gray-800 shadow-xl">
                    {suggestions.map((item) => (
                        <button
                            key={`${item.kind ?? "item"}:${item.name}`}
                            type="button"
                            onMouseDown={() => handleSelect(item)}
                            className="flex w-full items-center justify-between gap-3 border-b border-gray-700/50 px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 last:border-0"
                        >
                            <span className="truncate">{item.name}</span>
                            {item.kind && (
                                <span className="shrink-0 rounded-full border border-gray-600 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                                    {item.kind}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {showEmptyState && (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-400 shadow-xl">
                    {emptyText}
                </div>
            )}
        </div>
    );
}
