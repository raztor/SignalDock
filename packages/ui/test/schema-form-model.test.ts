import { describe, expect, it } from 'vitest';
import {
  asFormSchema,
  canStepNumber,
  describeSchemaFields,
  humanizeKey,
  parseNumberInput,
  SCHEMA_ROOT_KEY,
  stepNumber,
  validateSchemaListItem,
  validateSchemaValue,
  withSchemaDefaults,
  type FormSchema,
} from '../src/schema-form-model.js';

const schema: FormSchema = {
  type: 'object',
  required: ['endpoint', 'mode'],
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string', title: 'Endpoint', format: 'uri' },
    mode: { type: 'string', enum: ['fm', 'nfm', 'am'], default: 'fm' },
    band: {
      type: 'string',
      enum: ['10m', '6m', '2m', '1.25m', '70cm', '33cm'],
      'x-enum-labels': { '2m': '2 m' },
    },
    apiKey: { type: 'string', 'x-secret': true },
    credential: { type: 'string', 'x-credential-ref': true },
    pollIntervalMs: {
      type: 'integer',
      minimum: 100,
      maximum: 10000,
      multipleOf: 50,
      'x-unit': 'ms',
      default: 500,
    },
    gain: { type: 'number', exclusiveMinimum: 0, maximum: 2, 'x-step': 0.1 },
    enabled: { type: 'boolean', default: true },
    groups: {
      type: 'array',
      items: { type: 'string', minLength: 2 },
      maxItems: 3,
      uniqueItems: true,
    },
    channels: { type: 'array', items: { type: 'object' }, 'x-ui': 'hidden' },
    nested: { type: 'object', properties: {} },
  },
};

describe('asFormSchema', () => {
  it('accepts only object schemas', () => {
    expect(asFormSchema(schema)).toBe(schema);
    expect(asFormSchema({ type: 'object' })).toBeDefined();
    expect(asFormSchema({ type: 'string' })).toBeUndefined();
    expect(asFormSchema({ type: 'object', properties: [] })).toBeUndefined();
    expect(asFormSchema(null)).toBeUndefined();
    expect(asFormSchema('object')).toBeUndefined();
  });
});

describe('describeSchemaFields', () => {
  const fields = describeSchemaFields(schema);
  const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));

  it('keeps declaration order and marks required fields', () => {
    expect(fields.map((field) => field.key)).toEqual(
      Object.keys(schema.properties ?? {}),
    );
    expect(byKey.endpoint?.required).toBe(true);
    expect(byKey.band?.required).toBe(false);
  });

  it('classifies each property', () => {
    expect(
      Object.fromEntries(fields.map((field) => [field.key, field.kind])),
    ).toEqual({
      endpoint: 'text',
      mode: 'enum',
      band: 'enum',
      apiKey: 'text',
      credential: 'text',
      pollIntervalMs: 'number',
      gain: 'number',
      enabled: 'boolean',
      groups: 'string-list',
      channels: 'hidden',
      nested: 'unsupported',
    });
  });

  it('picks segmented controls for short enums and chips for long ones', () => {
    const mode = byKey.mode;
    const band = byKey.band;
    expect(mode?.kind === 'enum' && mode.presentation).toBe('segmented');
    expect(band?.kind === 'enum' && band.presentation).toBe('chips');
    expect(band?.kind === 'enum' && band.options[2]).toEqual({
      value: '2m',
      label: '2 m',
    });
  });

  it('derives text variants, numeric bounds and titles', () => {
    const variant = (key: string) => {
      const field = byKey[key];
      return field?.kind === 'text' ? field.variant : undefined;
    };
    expect(variant('endpoint')).toBe('uri');
    expect(variant('apiKey')).toBe('secret');
    expect(variant('credential')).toBe('credential-ref');
    expect(byKey.pollIntervalMs).toMatchObject({
      kind: 'number',
      integer: true,
      min: 100,
      max: 10000,
      step: 50,
      unit: 'ms',
      title: 'Poll interval ms',
    });
    expect(byKey.gain).toMatchObject({
      kind: 'number',
      integer: false,
      step: 0.1,
    });
    expect(byKey.gain).not.toHaveProperty('min');
  });

  it('treats arrays of objects and non-string enums as unsupported', () => {
    const fields = describeSchemaFields({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object' } },
        level: { type: 'integer', enum: [1, 2] },
        broken: 'nope' as never,
      },
    });
    expect(fields.map((field) => field.kind)).toEqual([
      'unsupported',
      'unsupported',
      'unsupported',
    ]);
  });
});

describe('validateSchemaValue', () => {
  const valid = {
    endpoint: 'grpc://radio.local:50051',
    mode: 'nfm',
    pollIntervalMs: 250,
    gain: 1.5,
    enabled: false,
    groups: ['ops', 'net'],
  };

  it('accepts a valid value', () => {
    expect(validateSchemaValue(schema, valid)).toEqual({});
  });

  it('reports a non-object value at the root key', () => {
    expect(validateSchemaValue(schema, [])).toEqual({
      [SCHEMA_ROOT_KEY]: 'Settings must be a JSON object.',
    });
  });

  it('requires required fields and ignores empty optional ones', () => {
    expect(validateSchemaValue(schema, { endpoint: ' ', band: '' })).toEqual({
      endpoint: 'Endpoint is required.',
      mode: 'Mode is required.',
    });
  });

  it('checks formats, enums and numeric constraints', () => {
    const errors = validateSchemaValue(schema, {
      ...valid,
      endpoint: 'radio.local:50051',
      mode: 'usb',
      pollIntervalMs: 260,
      gain: 0,
    });
    expect(errors.endpoint).toMatch(/full URL/);
    expect(errors.mode).toBe('Choose one of the listed options for Mode.');
    expect(errors.pollIntervalMs).toBe(
      'Poll interval ms must be a multiple of 50 ms.',
    );
    expect(errors.gain).toBe('Gain must be greater than 0.');
    expect(
      validateSchemaValue(schema, { ...valid, pollIntervalMs: 50 })
        .pollIntervalMs,
    ).toBe('Poll interval ms must be at least 100 ms.');
    expect(
      validateSchemaValue(schema, { ...valid, pollIntervalMs: 100.5 })
        .pollIntervalMs,
    ).toBe('Poll interval ms must be a whole number.');
    expect(validateSchemaValue(schema, { ...valid, gain: '1' }).gain).toBe(
      'Gain must be a number.',
    );
  });

  it('accepts float steps without rounding noise', () => {
    expect(
      validateSchemaValue(
        {
          type: 'object',
          properties: { offset: { type: 'number', multipleOf: 0.1 } },
        },
        { offset: 0.3 },
      ),
    ).toEqual({});
  });

  it('validates string lists and their entries', () => {
    expect(
      validateSchemaValue(schema, { ...valid, groups: ['a'] }).groups,
    ).toBe('Each Groups entry must be at least 2 characters.');
    expect(
      validateSchemaValue(schema, {
        ...valid,
        groups: ['ab', 'cd', 'ef', 'gh'],
      }).groups,
    ).toBe('Groups allows at most 3 entries.');
    expect(
      validateSchemaValue(schema, { ...valid, groups: ['ab', 'ab'] }).groups,
    ).toBe('Groups must not contain duplicates.');
    expect(validateSchemaValue(schema, { ...valid, groups: 'ab' }).groups).toBe(
      'Groups must be a list.',
    );
    const groups = describeSchemaFields(schema).find(
      (field) => field.key === 'groups',
    );
    expect(groups && validateSchemaListItem(groups, 'x')).toMatch(
      /at least 2 characters/,
    );
    expect(groups && validateSchemaListItem(groups, 'ops')).toBeUndefined();
  });

  it('rejects unknown keys only when additional properties are closed', () => {
    expect(validateSchemaValue(schema, { ...valid, extra: 1 })).toEqual({
      extra: 'extra is not a recognised setting.',
    });
    expect(
      validateSchemaValue({ type: 'object', properties: {} }, { extra: 1 }),
    ).toEqual({});
  });

  it('points required unsupported settings to Advanced JSON', () => {
    expect(
      validateSchemaValue(
        {
          type: 'object',
          required: ['nested'],
          properties: { nested: { type: 'object' } },
        },
        {},
      ),
    ).toEqual({ nested: 'Nested is required. Set it in Advanced JSON.' });
  });

  it('ignores invalid patterns instead of throwing', () => {
    const patterned: FormSchema = {
      type: 'object',
      properties: {
        callsign: { type: 'string', pattern: '^[A-Z0-9]+$' },
        broken: { type: 'string', pattern: '([' },
      },
    };
    expect(
      validateSchemaValue(patterned, { callsign: 'ca1abc', broken: 'x' }),
    ).toEqual({ callsign: 'Callsign has an invalid format.' });
  });
});

describe('withSchemaDefaults', () => {
  it('fills only missing keys with valid defaults', () => {
    expect(withSchemaDefaults(schema, { mode: 'am' })).toEqual({
      mode: 'am',
      pollIntervalMs: 500,
      enabled: true,
    });
    expect(
      withSchemaDefaults({
        type: 'object',
        properties: { level: { type: 'integer', minimum: 1, default: 0 } },
      }),
    ).toEqual({});
  });
});

describe('number helpers', () => {
  it('parses typed numbers', () => {
    expect(parseNumberInput('')).toEqual({ ok: true, value: undefined });
    expect(parseNumberInput(' 12 ')).toEqual({ ok: true, value: 12 });
    expect(parseNumberInput('1,5')).toEqual({ ok: true, value: 1.5 });
    expect(parseNumberInput('-0.25')).toEqual({ ok: true, value: -0.25 });
    expect(parseNumberInput('1e3')).toEqual({
      ok: false,
      error: 'Enter a number.',
    });
    expect(parseNumberInput('1.5', { integer: true })).toEqual({
      ok: false,
      error: 'Enter a whole number.',
    });
  });

  it('steps within bounds without float noise', () => {
    expect(stepNumber(0.2, 1, { step: 0.1 })).toBe(0.3);
    expect(stepNumber(9950, 1, { step: 50, min: 100, max: 10000 })).toBe(10000);
    expect(stepNumber(10000, 1, { step: 50, max: 10000 })).toBe(10000);
    expect(stepNumber(100, -1, { step: 50, min: 100 })).toBe(100);
    expect(stepNumber(undefined, 1, { min: 100 })).toBe(100);
    expect(stepNumber(undefined, -1, {})).toBe(0);
    expect(canStepNumber(10000, 1, { step: 50, max: 10000 })).toBe(false);
    expect(canStepNumber(10000, -1, { step: 50, max: 10000 })).toBe(true);
    expect(canStepNumber(undefined, 1, {})).toBe(true);
  });
});

describe('humanizeKey', () => {
  it('turns keys into sentence-case titles', () => {
    expect(humanizeKey('deviceAddress')).toBe('Device address');
    expect(humanizeKey('poll_interval-ms')).toBe('Poll interval ms');
    expect(humanizeKey('')).toBe('');
  });
});
