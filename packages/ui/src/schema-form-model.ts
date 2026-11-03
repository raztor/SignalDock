/**
 * Pure model for `SchemaForm`: a restricted JSON Schema subset that drivers and
 * connectors use to describe their settings. No React or React Native imports so
 * it can be unit tested in node and reused for Advanced JSON validation.
 */

export type FormSchemaType =
  'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null';

export interface FormSchemaProperty {
  type?: FormSchemaType | readonly FormSchemaType[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  items?: FormSchemaProperty;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, FormSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean | FormSchemaProperty;
  readOnly?: boolean;
  /** Render as a secure text entry; the value is a secret. */
  'x-secret'?: boolean;
  /** The value names a stored credential instead of containing the secret. */
  'x-credential-ref'?: boolean;
  /** Unit suffix shown next to numeric inputs, e.g. "ms" or "dB". */
  'x-unit'?: string;
  /** `'hidden'` skips the property in the form (it stays editable in Advanced JSON). */
  'x-ui'?: string;
  /** Step for numeric stepper buttons when `multipleOf` is not set. */
  'x-step'?: number;
  /** Human labels for string `enum` values. */
  'x-enum-labels'?: Record<string, string>;
  'x-placeholder'?: string;
}

/** Root schema accepted by `SchemaForm`: an object with properties. */
export interface FormSchema extends FormSchemaProperty {
  type: 'object';
}

/** Key used in validation results for errors about the whole value. */
export const SCHEMA_ROOT_KEY = '$root';

/** Enum options with at most this many entries render as a segmented control. */
export const SEGMENTED_ENUM_LIMIT = 5;

export type SchemaTextVariant = 'plain' | 'uri' | 'secret' | 'credential-ref';

interface SchemaFieldBase {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  readOnly: boolean;
  property: FormSchemaProperty;
}

export type SchemaField = SchemaFieldBase &
  (
    | {
        kind: 'enum';
        options: { value: string; label: string }[];
        presentation: 'segmented' | 'chips';
      }
    | { kind: 'text'; variant: SchemaTextVariant; placeholder?: string }
    | {
        kind: 'number';
        integer: boolean;
        min?: number;
        max?: number;
        step: number;
        unit?: string;
      }
    | { kind: 'boolean' }
    | { kind: 'string-list'; maxItems?: number; item: FormSchemaProperty }
    | { kind: 'hidden' }
    | { kind: 'unsupported' }
  );

export type SchemaFieldKind = SchemaField['kind'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/**
 * Narrows untrusted JSON (for example a driver's `configSchema`) to a
 * `FormSchema`. Returns undefined when it is not an object schema.
 */
export function asFormSchema(value: unknown): FormSchema | undefined {
  if (!isRecord(value) || value.type !== 'object') return undefined;
  if (value.properties !== undefined && !isRecord(value.properties))
    return undefined;
  return value as unknown as FormSchema;
}

/** "pollIntervalMs" / "poll_interval_ms" → "Poll interval ms". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function primaryType(property: FormSchemaProperty): FormSchemaType | undefined {
  const declared = property.type;
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared)) {
    const types = (declared as unknown[]).filter(
      (entry): entry is FormSchemaType =>
        typeof entry === 'string' && entry !== 'null',
    );
    return types.length === 1 ? types[0] : undefined;
  }
  if (Array.isArray(property.enum) && property.enum.length > 0)
    return property.enum.every((entry) => typeof entry === 'string')
      ? 'string'
      : undefined;
  return undefined;
}

function stringEnum(property: FormSchemaProperty): string[] | undefined {
  const values = property.enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values.every((entry): entry is string => typeof entry === 'string')
    ? (values as string[])
    : undefined;
}

function describeProperty(
  key: string,
  raw: unknown,
  required: boolean,
): SchemaField {
  const property: FormSchemaProperty = isRecord(raw)
    ? (raw as FormSchemaProperty)
    : {};
  const description = text(property.description);
  const base: SchemaFieldBase = {
    key,
    title: text(property.title) ?? humanizeKey(key),
    ...(description ? { description } : {}),
    required,
    readOnly: property.readOnly === true,
    property,
  };
  if (!isRecord(raw)) return { ...base, kind: 'unsupported' };
  if (property['x-ui'] === 'hidden') return { ...base, kind: 'hidden' };
  const kind = primaryType(property);
  if (kind === 'string') {
    const values = stringEnum(property);
    if (property.enum !== undefined) {
      if (!values) return { ...base, kind: 'unsupported' };
      const labels = isRecord(property['x-enum-labels'])
        ? property['x-enum-labels']
        : {};
      return {
        ...base,
        kind: 'enum',
        options: values.map((value) => ({
          value,
          label: text(labels[value]) ?? value,
        })),
        presentation:
          values.length <= SEGMENTED_ENUM_LIMIT ? 'segmented' : 'chips',
      };
    }
    const variant: SchemaTextVariant =
      property['x-secret'] === true
        ? 'secret'
        : property['x-credential-ref'] === true
          ? 'credential-ref'
          : property.format === 'uri' || property.format === 'url'
            ? 'uri'
            : 'plain';
    const placeholder = text(property['x-placeholder']);
    return {
      ...base,
      kind: 'text',
      variant,
      ...(placeholder ? { placeholder } : {}),
    };
  }
  if (kind === 'integer' || kind === 'number') {
    if (property.enum !== undefined) return { ...base, kind: 'unsupported' };
    const integer = kind === 'integer';
    const step = finite(property.multipleOf) ?? finite(property['x-step']) ?? 1;
    const exclusiveMin = finite(property.exclusiveMinimum);
    const exclusiveMax = finite(property.exclusiveMaximum);
    const min =
      finite(property.minimum) ??
      (integer && exclusiveMin !== undefined
        ? Math.floor(exclusiveMin) + 1
        : undefined);
    const max =
      finite(property.maximum) ??
      (integer && exclusiveMax !== undefined
        ? Math.ceil(exclusiveMax) - 1
        : undefined);
    const unit = text(property['x-unit']);
    return {
      ...base,
      kind: 'number',
      integer,
      step: step > 0 ? step : 1,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(unit ? { unit } : {}),
    };
  }
  if (kind === 'boolean') return { ...base, kind: 'boolean' };
  if (kind === 'array') {
    const item = isRecord(property.items)
      ? (property.items as FormSchemaProperty)
      : undefined;
    const itemType = item ? primaryType(item) : undefined;
    if (item && itemType === 'string') {
      const maxItems = finite(property.maxItems);
      return {
        ...base,
        kind: 'string-list',
        item,
        ...(maxItems !== undefined ? { maxItems } : {}),
      };
    }
    return { ...base, kind: 'unsupported' };
  }
  return { ...base, kind: 'unsupported' };
}

/** Lists the schema's properties in declaration order with how each one renders. */
export function describeSchemaFields(schema: FormSchema): SchemaField[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  );
  return Object.entries(properties).map(([key, property]) =>
    describeProperty(key, property, required.has(key)),
  );
}

const URI = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+[^\s]*$/i;

function formatNumber(value: number, unit?: string) {
  return unit ? `${value} ${unit}` : String(value);
}

function isMultipleOf(value: number, step: number) {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

function validateString(
  property: FormSchemaProperty,
  value: unknown,
  title: string,
): string | undefined {
  if (typeof value !== 'string') return `${title} must be text.`;
  const values = stringEnum(property);
  if (values && !values.includes(value))
    return `Choose one of the listed options for ${title}.`;
  const minLength = finite(property.minLength);
  if (minLength !== undefined && value.length < minLength)
    return `${title} must be at least ${minLength} characters.`;
  const maxLength = finite(property.maxLength);
  if (maxLength !== undefined && value.length > maxLength)
    return `${title} must be at most ${maxLength} characters.`;
  if (
    (property.format === 'uri' || property.format === 'url') &&
    !URI.test(value)
  )
    return `${title} must be a full URL including the scheme, such as https://host:port.`;
  if (typeof property.pattern === 'string') {
    let pattern: RegExp | undefined;
    try {
      pattern = new RegExp(property.pattern);
    } catch {
      pattern = undefined;
    }
    if (pattern && !pattern.test(value))
      return `${title} has an invalid format.`;
  }
  return undefined;
}

function validateNumber(
  property: FormSchemaProperty,
  value: unknown,
  title: string,
  integer: boolean,
): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `${title} must be a number.`;
  if (integer && !Number.isInteger(value))
    return `${title} must be a whole number.`;
  const unit = text(property['x-unit']);
  const minimum = finite(property.minimum);
  if (minimum !== undefined && value < minimum)
    return `${title} must be at least ${formatNumber(minimum, unit)}.`;
  const maximum = finite(property.maximum);
  if (maximum !== undefined && value > maximum)
    return `${title} must be at most ${formatNumber(maximum, unit)}.`;
  const exclusiveMinimum = finite(property.exclusiveMinimum);
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
    return `${title} must be greater than ${formatNumber(exclusiveMinimum, unit)}.`;
  const exclusiveMaximum = finite(property.exclusiveMaximum);
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum)
    return `${title} must be less than ${formatNumber(exclusiveMaximum, unit)}.`;
  const multipleOf = finite(property.multipleOf);
  if (
    multipleOf !== undefined &&
    multipleOf > 0 &&
    !isMultipleOf(value, multipleOf)
  )
    return `${title} must be a multiple of ${formatNumber(multipleOf, unit)}.`;
  return undefined;
}

/** Validates one entry of a `string-list` field (used by its ChipInput). */
export function validateSchemaListItem(
  field: SchemaField,
  item: string,
): string | undefined {
  if (field.kind !== 'string-list') return undefined;
  return validateString(field.item, item, `Each ${field.title} entry`);
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '');

function validateField(field: SchemaField, value: unknown): string | undefined {
  if (isEmpty(value)) {
    if (!field.required) return undefined;
    return field.kind === 'unsupported' || field.kind === 'hidden'
      ? `${field.title} is required. Set it in Advanced JSON.`
      : `${field.title} is required.`;
  }
  switch (field.kind) {
    case 'hidden':
    case 'unsupported':
      return undefined;
    case 'enum':
    case 'text':
      return validateString(field.property, value, field.title);
    case 'number':
      return validateNumber(field.property, value, field.title, field.integer);
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `${field.title} must be on or off.`;
    case 'string-list': {
      if (!Array.isArray(value)) return `${field.title} must be a list.`;
      const minItems = finite(field.property.minItems);
      if (field.required && value.length === 0)
        return `${field.title} needs at least one entry.`;
      if (minItems !== undefined && value.length < minItems)
        return `${field.title} needs at least ${minItems} ${minItems === 1 ? 'entry' : 'entries'}.`;
      if (field.maxItems !== undefined && value.length > field.maxItems)
        return `${field.title} allows at most ${field.maxItems} ${field.maxItems === 1 ? 'entry' : 'entries'}.`;
      if (
        field.property.uniqueItems === true &&
        new Set(value.map((entry) => JSON.stringify(entry))).size !==
          value.length
      )
        return `${field.title} must not contain duplicates.`;
      for (const entry of value) {
        const error = validateString(
          field.item,
          entry,
          `Each ${field.title} entry`,
        );
        if (error) return error;
      }
      return undefined;
    }
  }
}

/**
 * Validates a settings value against the schema subset. Returns a map of
 * property key → English message; an empty object means valid. Errors about
 * the value as a whole use `SCHEMA_ROOT_KEY`.
 */
export function validateSchemaValue(
  schema: FormSchema,
  value: unknown,
): Record<string, string> {
  if (!isRecord(value))
    return { [SCHEMA_ROOT_KEY]: 'Settings must be a JSON object.' };
  const errors: Record<string, string> = {};
  const fields = describeSchemaFields(schema);
  for (const field of fields) {
    const error = validateField(field, value[field.key]);
    if (error) errors[field.key] = error;
  }
  if (schema.additionalProperties === false) {
    const known = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(value))
      if (!known.has(key)) errors[key] = `${key} is not a recognised setting.`;
  }
  return errors;
}

/**
 * Fills missing properties with valid schema defaults. Existing values are kept
 * untouched, including invalid ones, so validation can report them.
 */
export function withSchemaDefaults(
  schema: FormSchema,
  value: Record<string, unknown> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value };
  for (const field of describeSchemaFields(schema)) {
    if (next[field.key] !== undefined) continue;
    const fallback = field.property.default;
    if (fallback === undefined) continue;
    if (validateField({ ...field, required: true }, fallback) === undefined)
      next[field.key] = Array.isArray(fallback) ? [...fallback] : fallback;
  }
  return next;
}

export type NumberInputResult =
  { ok: true; value: number | undefined } | { ok: false; error: string };

/**
 * Parses numeric text typed by the user. Empty text clears the value. Accepts
 * a comma as decimal separator ("1,5").
 */
export function parseNumberInput(
  input: string,
  options: { integer?: boolean } = {},
): NumberInputResult {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (!trimmed) return { ok: true, value: undefined };
  const normalised = trimmed.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(normalised))
    return { ok: false, error: 'Enter a number.' };
  const value = Number(normalised);
  if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' };
  if (options.integer && !Number.isInteger(value))
    return { ok: false, error: 'Enter a whole number.' };
  return { ok: true, value };
}

function decimals(value: number) {
  const [, fraction = ''] = String(value).split('.');
  return fraction.length;
}

export interface NumberBounds {
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
}

/** Clamps a number into the optional bounds. */
export function clampNumber(value: number, bounds: NumberBounds): number {
  let next = value;
  if (bounds.min !== undefined && next < bounds.min) next = bounds.min;
  if (bounds.max !== undefined && next > bounds.max) next = bounds.max;
  return next;
}

/**
 * Moves `current` one step in `direction`, rounding away float noise and
 * clamping to the bounds. An empty value starts from the minimum (or 0).
 */
export function stepNumber(
  current: number | undefined,
  direction: 1 | -1,
  bounds: NumberBounds,
): number {
  const step = bounds.step !== undefined && bounds.step > 0 ? bounds.step : 1;
  if (current === undefined || !Number.isFinite(current))
    return clampNumber(bounds.min ?? 0, bounds);
  const precision = Math.min(10, Math.max(decimals(step), decimals(current)));
  let next = Number((current + direction * step).toFixed(precision));
  if (bounds.integer) next = Math.round(next);
  return clampNumber(next, bounds);
}

/** True when stepping would change the value (used to disable ± at the edges). */
export function canStepNumber(
  current: number | undefined,
  direction: 1 | -1,
  bounds: NumberBounds,
): boolean {
  if (current === undefined) return true;
  return stepNumber(current, direction, bounds) !== current;
}
