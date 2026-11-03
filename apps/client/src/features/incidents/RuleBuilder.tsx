import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  ChipInput,
  ConfirmDialog,
  Heading,
  Icon,
  Pressable,
  Text,
  TextInput,
  radius,
  space,
  type,
  useTheme,
  useToast,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { FrequencyRange } from '../station/station-model';
import { FrequencyRangePicker } from './FrequencyRangePicker';
import type { IncidentClient, RuleSummary } from './data/incident-client';
import {
  ANY_FREQUENCY,
  PHRASES_MAX,
  RULE_NAME_MAX,
  parsePhrases,
  rangeLabel,
  ruleBody,
  validatePhrase,
  type FrequencyRangeDraft,
} from './incident-model';

export interface RuleBuilderProps {
  client: IncidentClient;
  /** Selected radio: new rules are scoped to it. */
  radioId?: string | undefined;
  radioName?: string | undefined;
  /** Frames the range picker (the selected radio's tuning ranges). */
  scale?: readonly FrequencyRange[] | undefined;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed.';

/**
 * Administrator-only local detection rules: literal phrases as chips and an
 * optional frequency range. New rules are enabled, high priority and scoped
 * to the selected radio (if any), as before.
 */
export function RuleBuilder({
  client,
  radioId,
  radioName,
  scale,
}: RuleBuilderProps) {
  const { colors } = useTheme();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<RuleSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [phrases, setPhrases] = useState<string[]>([]);
  const [range, setRange] = useState<FrequencyRangeDraft>(ANY_FREQUENCY);
  const [attempted, setAttempted] = useState(false);
  const [removing, setRemoving] = useState<RuleSummary | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  /**
   * Run `action` (a save or delete), then reload the list. Resolves true when
   * the action itself succeeded, even if the reload afterwards failed, so a
   * saved rule is never reported as failed (and retried into a duplicate).
   */
  async function run(action?: () => Promise<void>) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    if (action) setSaving(true);
    else setLoading(true);
    let mutated = false;
    try {
      if (action) {
        await action();
        mutated = true;
      }
      const rows = await client.rules(controller.signal);
      if (mounted.current && !controller.signal.aborted) setRules(rows);
      return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          mutated
            ? 'The change was saved, but the rule list could not be refreshed.'
            : message(failure),
        );
      return mutated;
    } finally {
      if (mounted.current && request.current === controller) {
        setSaving(false);
        setLoading(false);
      }
    }
  }

  const draft = ruleBody({ name, phrases, range, radioId });
  const busy = saving || loading;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderColor: colors.border,
        paddingTop: space.md,
        gap: space.md,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          const next = !open;
          setOpen(next);
          if (next && rules === null) void run();
        }}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: space.md,
        }}
      >
        <Heading>Local detection rules</Heading>
        <Icon
          name={open ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={colors.textSecondary}
        />
      </Pressable>
      {open && (
        <View style={{ gap: space.lg }}>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Literal phrases with an optional radio and frequency scope. No
            custom executable expressions. Removing the last configured rule
            disables local incident detection by default.
          </Text>
          {loading && (
            <ActivityIndicator
              accessibilityLabel="Loading detection rules"
              color={colors.primary}
            />
          )}
          {rules?.length === 0 && !loading && (
            <Text style={{ color: colors.textSecondary }}>
              No rules configured.
            </Text>
          )}
          {rules?.map((rule) => (
            <View
              key={rule.id}
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                padding: space.md,
                gap: space.sm,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: space.sm,
                }}
              >
                <Text style={[type.label, { color: colors.textPrimary }]}>
                  {rule.name}
                </Text>
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    gap: space.xs,
                  }}
                >
                  <Badge
                    label={rule.priority}
                    tone={
                      rule.priority === 'critical'
                        ? 'error'
                        : rule.priority === 'high'
                          ? 'warning'
                          : 'neutral'
                    }
                  />
                  <Badge
                    label={rule.enabled ? 'Enabled' : 'Disabled'}
                    tone={rule.enabled ? 'primary' : 'neutral'}
                  />
                </View>
              </View>
              <ChipGroup accessibilityLabel={`Phrases of ${rule.name}`}>
                {rule.phrases.map((phrase) => (
                  <Chip key={phrase} label={phrase} />
                ))}
              </ChipGroup>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {rangeLabel({
                  ...(rule.minHz !== undefined ? { minHz: rule.minHz } : {}),
                  ...(rule.maxHz !== undefined ? { maxHz: rule.maxHz } : {}),
                })}
                {' · '}
                {rule.radioIds?.length
                  ? rule.radioIds.length === 1 && rule.radioIds[0] === radioId
                    ? `Selected radio${radioName ? ` (${radioName})` : ''}`
                    : `${rule.radioIds.length} radio${rule.radioIds.length === 1 ? '' : 's'}`
                  : 'All radios'}
              </Text>
              <Button
                label={`Remove rule ${rule.name}`}
                variant="danger"
                disabled={busy}
                onPress={() => setRemoving(rule)}
              />
            </View>
          ))}

          <View style={{ gap: space.md }}>
            <Heading>New rule</Heading>
            <View style={{ gap: space.xs }}>
              <Text style={[type.label, { color: colors.textPrimary }]}>
                Name
              </Text>
              <TextInput
                accessibilityLabel="Rule name"
                value={name}
                onChangeText={setName}
                placeholder="e.g. Distress calls"
                maxLength={RULE_NAME_MAX}
                editable={!saving}
              />
            </View>
            <View style={{ gap: space.xs }}>
              <Text style={[type.label, { color: colors.textPrimary }]}>
                Phrases
              </Text>
              <ChipInput
                accessibilityLabel="Distress phrases"
                placeholder="Add phrase, press Enter"
                values={phrases}
                onChange={(values) => setPhrases(parsePhrases(values))}
                validate={validatePhrase}
                maxItems={PHRASES_MAX}
                disabled={saving}
              />
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                Matched literally in transcripts, ignoring case.
              </Text>
            </View>
            <FrequencyRangePicker
              value={range}
              onChange={setRange}
              {...(scale ? { scale } : {})}
              disabled={saving}
            />
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: space.sm,
              }}
            >
              <Badge label="▲ High priority" tone="warning" />
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {radioId
                  ? `Scoped to the selected radio${radioName ? `, ${radioName}` : ''}.`
                  : 'No radio selected: the rule applies across this instance.'}
              </Text>
            </View>
            {attempted && !draft.ok && (
              <Text
                accessibilityLiveRegion="polite"
                style={[type.caption, { color: colors.warning }]}
              >
                {draft.error}
              </Text>
            )}
            {!!error && (
              <Text accessibilityRole="alert" style={{ color: colors.error }}>
                {error}
              </Text>
            )}
            <Button
              label="Add high-priority rule"
              variant="primary"
              loading={saving}
              disabled={loading}
              onPress={() => {
                setAttempted(true);
                if (!draft.ok) return;
                const body = draft.body;
                void run(() => client.saveRule({ ...body })).then((saved) => {
                  if (!saved || !mounted.current) return;
                  setName('');
                  setPhrases([]);
                  setRange(ANY_FREQUENCY);
                  setAttempted(false);
                  toast.show({
                    message: `Rule “${body.name}” added.`,
                    tone: 'success',
                  });
                });
              }}
            />
          </View>
        </View>
      )}
      <ConfirmDialog
        visible={removing !== null}
        title="Remove detection rule?"
        message={
          removing
            ? `“${removing.name}” stops matching new transcripts. Existing incidents stay.${
                rules?.length === 1
                  ? ' It is the last rule: removing it disables local incident detection by default.'
                  : ''
              }`
            : ''
        }
        confirmLabel="Remove rule"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const rule = removing;
          setRemoving(null);
          if (!rule) return;
          void run(() => client.removeRule(rule.id)).then((removed) => {
            if (removed)
              toast.show({ message: `Rule “${rule.name}” removed.` });
          });
        }}
      />
    </View>
  );
}
