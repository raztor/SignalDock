/** Pure helpers for `ChipInput`. No React imports so they can be tested in node. */

export interface ChipCommitOptions {
  validate?: (value: string) => string | undefined;
  maxItems?: number;
}

export interface ChipCommitResult {
  /** The new list (unchanged when nothing was added). */
  values: string[];
  /** Text to keep in the input: entries that were rejected. */
  remaining: string;
  error?: string;
}

const SEPARATOR = /[,\n]/;

/** True when the typed text contains a separator that should create chips. */
export const hasChipSeparator = (text: string) => SEPARATOR.test(text);

/**
 * Turns typed text into chips. Text is split on commas and new lines, trimmed,
 * empty parts dropped and duplicates ignored case-insensitively (against the
 * existing list and within the text). Invalid entries and entries beyond
 * `maxItems` stay in `remaining` with an error.
 */
export function commitChipText(
  values: readonly string[],
  text: string,
  options: ChipCommitOptions = {},
): ChipCommitResult {
  const next = [...values];
  const seen = new Set(values.map((value) => value.toLocaleLowerCase()));
  const rejected: string[] = [];
  let error: string | undefined;
  for (const part of text.split(SEPARATOR)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    if (options.maxItems !== undefined && next.length >= options.maxItems) {
      rejected.push(value);
      error ??= `You can add up to ${options.maxItems} ${options.maxItems === 1 ? 'entry' : 'entries'}.`;
      continue;
    }
    const invalid = options.validate?.(value);
    if (invalid) {
      rejected.push(value);
      error ??= invalid;
      continue;
    }
    seen.add(key);
    next.push(value);
  }
  return {
    values: next,
    remaining: rejected.join(', '),
    ...(error ? { error } : {}),
  };
}

/** Removes the chip at `index` (or the last chip when omitted). */
export function removeChip(
  values: readonly string[],
  index = values.length - 1,
): string[] {
  if (index < 0 || index >= values.length) return [...values];
  return values.filter((_, position) => position !== index);
}
