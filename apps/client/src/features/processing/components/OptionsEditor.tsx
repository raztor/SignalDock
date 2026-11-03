import {
  SchemaForm,
  SegmentedControl,
  Text,
  TextInput,
  type FormSchema,
} from '@signaldock/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  formatJson,
  optionsSafetyError,
  parseJsonObject,
} from '../processing-model';
import { Notice } from './common';
import { useProcessingStyles } from './styles';

type Mode = 'form' | 'json';

export interface OptionsEditorProps {
  /** Accessible name and heading, e.g. "Connection options". */
  label: string;
  /** Undefined → the Form option is shown disabled and Advanced JSON is used. */
  schema: FormSchema | undefined;
  value: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  /** Field errors from `validateSchemaValue`. */
  errors?: Record<string, string>;
  /** Reports unparsable Advanced JSON (undefined when valid). */
  onJsonError?(error: string | undefined): void;
  /** Shown when the schema has no properties. */
  emptyText: string;
  disabled?: boolean;
}

/**
 * Schema-driven settings with an "Advanced JSON" fallback. Invalid JSON never
 * reaches `onChange`; credential-shaped keys are flagged before the server
 * rejects them.
 */
export function OptionsEditor({
  label,
  schema,
  value,
  onChange,
  errors = {},
  onJsonError,
  emptyText,
  disabled = false,
}: OptionsEditorProps) {
  const styles = useProcessingStyles();
  const [mode, setMode] = useState<Mode>(schema ? 'form' : 'json');
  const [text, setText] = useState(() => formatJson(value));
  const [jsonError, setJsonError] = useState<string>();
  const effectiveMode: Mode = schema ? mode : 'json';

  useEffect(() => {
    if (!schema) setMode('json');
  }, [schema]);

  // Keep the JSON text in sync when the form (or a reset) changes the value.
  useEffect(() => {
    if (effectiveMode === 'form') {
      setText(formatJson(value));
      setJsonError(undefined);
    }
  }, [effectiveMode, value]);

  useEffect(() => {
    onJsonError?.(effectiveMode === 'json' ? jsonError : undefined);
  }, [effectiveMode, jsonError, onJsonError]);

  const editJson = (next: string) => {
    setText(next);
    const parsed = parseJsonObject(next);
    if (parsed.ok) {
      setJsonError(undefined);
      onChange(parsed.value);
    } else setJsonError(parsed.error);
  };

  const safety = optionsSafetyError(value);
  const empty =
    schema !== undefined && Object.keys(schema.properties ?? {}).length === 0;

  return (
    <View style={styles.section}>
      <View style={styles.between}>
        <Text accessibilityRole="header" style={styles.label}>
          {label}
        </Text>
        <SegmentedControl<Mode>
          size="compact"
          accessibilityLabel={`${label} editor`}
          value={effectiveMode}
          disabled={disabled}
          onChange={(next) => {
            if (next === 'json') setText(formatJson(value));
            setMode(next);
          }}
          options={[
            {
              value: 'form',
              label: 'Form',
              disabled: !schema,
              accessibilityLabel: schema
                ? 'Form'
                : 'Form (this provider does not describe its settings)',
            },
            { value: 'json', label: 'Advanced JSON' },
          ]}
        />
      </View>
      {effectiveMode === 'form' && schema ? (
        empty && Object.keys(value).length === 0 ? (
          <Text style={styles.muted}>{emptyText}</Text>
        ) : (
          <SchemaForm
            schema={schema}
            value={value}
            onChange={onChange}
            errors={errors}
            disabled={disabled}
          />
        )
      ) : (
        <View style={styles.field}>
          <Text style={styles.caption}>
            {schema
              ? 'Edit these settings as a JSON object.'
              : 'This provider does not describe these settings. Enter them as a JSON object.'}{' '}
            Never put API keys, tokens or passwords here.
          </Text>
          <TextInput
            accessibilityLabel={`${label} (JSON)`}
            style={[styles.input, styles.multiline, styles.json]}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            multiline
            editable={!disabled}
            value={text}
            onChangeText={editJson}
          />
          {jsonError ? (
            <Text accessibilityLiveRegion="polite" style={styles.errorCaption}>
              {jsonError}
            </Text>
          ) : Object.values(errors)[0] ? (
            <Text style={styles.errorCaption}>{Object.values(errors)[0]}</Text>
          ) : null}
        </View>
      )}
      {safety ? <Notice tone="error">{safety}</Notice> : null}
    </View>
  );
}
