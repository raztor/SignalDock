import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  Chip,
  ChipGroup,
  ChipInput,
  NumberField,
  SegmentedControl,
} from './controls';
import { Text, TextInput } from './primitives';
import {
  describeSchemaFields,
  SCHEMA_ROOT_KEY,
  validateSchemaListItem,
  type FormSchema,
  type SchemaField,
} from './schema-form-model';
import { SettingToggle } from './setting-toggle';
import { useTheme } from './theme';
import { space, type } from './tokens';

export interface SchemaFormProps {
  schema: FormSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  /** Messages keyed by property (for example from `validateSchemaValue`). */
  errors?: Record<string, string>;
}

const textPlaceholder: Record<string, string> = {
  uri: 'https://host:port',
  'credential-ref': 'Stored credential name',
};

function FieldFrame({
  field,
  error,
  children,
  labelled = true,
}: {
  field: SchemaField;
  error: string | undefined;
  children: ReactNode;
  labelled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      {labelled && (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            gap: space.sm,
          }}
        >
          <Text style={type.label}>
            {field.title}
            {field.kind === 'text' && field.variant === 'credential-ref'
              ? ' (credential reference)'
              : ''}
          </Text>
          {!field.required && (
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              Optional
            </Text>
          )}
        </View>
      )}
      {field.description && (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          {field.description}
        </Text>
      )}
      {children}
      {error && (
        <Text
          accessibilityRole="alert"
          style={[type.caption, { color: colors.error }]}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

/**
 * Renders a driver or connector settings schema (restricted JSON Schema
 * subset) as native controls. Properties it cannot render show a note pointing
 * to Advanced JSON; `x-ui: 'hidden'` properties are skipped.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  disabled = false,
  errors = {},
}: SchemaFormProps) {
  const { colors } = useTheme();
  const fields = useMemo(() => describeSchemaFields(schema), [schema]);
  const set = (key: string, next: unknown) => {
    const copy = { ...value };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  const visible = fields.filter((field) => field.kind !== 'hidden');
  const rootError = errors[SCHEMA_ROOT_KEY];
  if (!visible.length)
    return (
      <Text style={[type.body, { color: colors.textSecondary }]}>
        {schema.additionalProperties === false
          ? 'This driver has no settings.'
          : 'This driver does not describe its settings. Use Advanced JSON to edit them.'}
      </Text>
    );
  return (
    <View style={{ gap: space.lg }}>
      {rootError && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {rootError}
        </Text>
      )}
      {visible.map((field) => {
        const current = value[field.key];
        const error = errors[field.key];
        const inactive = disabled || field.readOnly;
        const fallback = field.property.default;
        switch (field.kind) {
          case 'enum': {
            const selected =
              typeof current === 'string'
                ? current
                : typeof fallback === 'string'
                  ? fallback
                  : undefined;
            return (
              <FieldFrame key={field.key} field={field} error={error}>
                {field.presentation === 'segmented' ? (
                  <SegmentedControl
                    accessibilityLabel={field.title}
                    options={field.options}
                    value={selected}
                    disabled={inactive}
                    onChange={(next) => set(field.key, next)}
                  />
                ) : (
                  <ChipGroup accessibilityLabel={field.title}>
                    {field.options.map((option) => (
                      <Chip
                        key={option.value}
                        label={option.label}
                        selected={option.value === selected}
                        disabled={inactive}
                        onPress={() =>
                          set(
                            field.key,
                            option.value === current && !field.required
                              ? undefined
                              : option.value,
                          )
                        }
                      />
                    ))}
                  </ChipGroup>
                )}
              </FieldFrame>
            );
          }
          case 'text': {
            const placeholder =
              field.placeholder ??
              textPlaceholder[field.variant] ??
              (typeof fallback === 'string' ? fallback : undefined);
            const literal = field.variant !== 'plain';
            return (
              <FieldFrame key={field.key} field={field} error={error}>
                <TextInput
                  value={typeof current === 'string' ? current : ''}
                  editable={!inactive}
                  accessibilityLabel={
                    field.variant === 'credential-ref'
                      ? `${field.title}, credential reference`
                      : field.title
                  }
                  {...(placeholder ? { placeholder } : {})}
                  secureTextEntry={field.variant === 'secret'}
                  autoCapitalize={literal ? 'none' : 'sentences'}
                  autoCorrect={!literal}
                  {...(field.variant === 'uri'
                    ? {
                        keyboardType: 'url' as const,
                        inputMode: 'url' as const,
                      }
                    : {})}
                  {...(field.variant === 'secret'
                    ? {
                        // 'off' is ignored for password inputs; 'new-password'
                        // stops browsers filling the user's own credentials.
                        autoComplete: 'new-password' as const,
                        textContentType: 'none' as const,
                      }
                    : {})}
                  onChangeText={(text) =>
                    set(field.key, text === '' ? undefined : text)
                  }
                />
                {field.variant === 'credential-ref' && (
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    Enter the name of a stored credential, not the secret
                    itself.
                  </Text>
                )}
              </FieldFrame>
            );
          }
          case 'number':
            return (
              <FieldFrame key={field.key} field={field} error={error}>
                <NumberField
                  accessibilityLabel={field.title}
                  value={typeof current === 'number' ? current : undefined}
                  {...(typeof fallback === 'number'
                    ? { placeholder: String(fallback) }
                    : {})}
                  integer={field.integer}
                  step={field.step}
                  {...(field.min !== undefined ? { min: field.min } : {})}
                  {...(field.max !== undefined ? { max: field.max } : {})}
                  {...(field.unit ? { unit: field.unit } : {})}
                  disabled={inactive}
                  onChange={(next) => set(field.key, next)}
                />
              </FieldFrame>
            );
          case 'boolean':
            return (
              <FieldFrame
                key={field.key}
                field={field}
                error={error}
                labelled={false}
              >
                <SettingToggle
                  label={field.title}
                  value={
                    typeof current === 'boolean' ? current : fallback === true
                  }
                  disabled={inactive}
                  onValueChange={(next) => set(field.key, next)}
                />
              </FieldFrame>
            );
          case 'string-list':
            return (
              <FieldFrame key={field.key} field={field} error={error}>
                <ChipInput
                  accessibilityLabel={field.title}
                  placeholder="Type and press Enter"
                  values={
                    Array.isArray(current)
                      ? current.filter(
                          (entry): entry is string => typeof entry === 'string',
                        )
                      : []
                  }
                  validate={(item) => validateSchemaListItem(field, item)}
                  {...(field.maxItems !== undefined
                    ? { maxItems: field.maxItems }
                    : {})}
                  disabled={inactive}
                  onChange={(next) =>
                    set(
                      field.key,
                      next.length || field.required ? next : undefined,
                    )
                  }
                />
              </FieldFrame>
            );
          default:
            return (
              <FieldFrame key={field.key} field={field} error={error}>
                <Text style={[type.caption, { color: colors.textSecondary }]}>
                  Edit this setting in Advanced JSON.
                </Text>
              </FieldFrame>
            );
        }
      })}
    </View>
  );
}
