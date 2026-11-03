import type { Conversation } from '@signaldock/contracts';
import {
  Chip,
  ChipGroup,
  Icon,
  Pressable,
  Text,
  TextInput,
  createStyles,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useState } from 'react';
import { View } from 'react-native';
import {
  DATE_RANGE_FILTERS,
  DIRECTION_FILTERS,
  FREQUENCY_CHIP_LIMIT,
  formatShortInstant,
  frequencyAccessibilityLabel,
  frequencyChipLabel,
  type DateRangeFilter,
  type DirectionFilter,
} from './history-model';

export interface HistoryFilterBarProps {
  searchText: string;
  onSearchText(text: string): void;
  /** Applies the search now instead of waiting for the debounce. */
  onSearchSubmit(): void;
  direction: DirectionFilter;
  onDirection(direction: DirectionFilter): void;
  range: DateRangeFilter;
  onRange(range: DateRangeFilter): void;
  /** Heatmap cut-off (ISO), shown as a removable chip. */
  before?: string;
  onClearBefore(): void;
  timeZone: string;
  conversations: readonly Conversation[];
  conversationId?: string;
  onConversation(conversation: Conversation | null): void;
  /** Radio display names, used when the list spans several radios. */
  radioName(radioId: string): string;
  /** True when every frequency group belongs to one radio. */
  singleRadio: boolean;
}

/** Live search plus chip groups for direction, frequency and date range. */
export function HistoryFilterBar(props: HistoryFilterBarProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [allFrequencies, setAllFrequencies] = useState(false);
  const selectedIndex = props.conversations.findIndex(
    (group) => group.id === props.conversationId,
  );
  const visible =
    allFrequencies || props.conversations.length <= FREQUENCY_CHIP_LIMIT
      ? props.conversations
      : props.conversations.filter(
          (_, index) => index < FREQUENCY_CHIP_LIMIT || index === selectedIndex,
        );
  const hidden = props.conversations.length - visible.length;
  return (
    <View style={styles.root}>
      <View style={styles.search}>
        <Icon name="search" size={18} color={colors.textSecondary} />
        <TextInput
          accessibilityLabel="Search transcripts, tags and notes"
          placeholder="Search transcripts, tags or notes"
          value={props.searchText}
          onChangeText={props.onSearchText}
          onSubmitEditing={props.onSearchSubmit}
          returnKeyType="search"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {!!props.searchText && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={6}
            onPress={() => props.onSearchText('')}
            style={styles.clear}
          >
            <Icon name="close" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      <ChipGroup accessibilityLabel="Direction">
        {DIRECTION_FILTERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={props.direction === option.value}
            onPress={() =>
              props.onDirection(
                props.direction === option.value ? 'all' : option.value,
              )
            }
          />
        ))}
      </ChipGroup>

      {props.conversations.length > 0 && (
        <ChipGroup accessibilityLabel="Frequency">
          <Chip
            label="All frequencies"
            selected={!props.conversationId}
            onPress={() => props.onConversation(null)}
          />
          {visible.map((group) => {
            const label = frequencyChipLabel(group.frequencyHz);
            const radio = props.singleRadio
              ? ''
              : ` · ${props.radioName(group.radioId)}`;
            const selected = props.conversationId === group.id;
            return (
              <Chip
                key={group.id}
                label={`${label}${radio}`}
                monospace={group.frequencyHz !== undefined}
                dashed={group.attribution !== 'confirmed'}
                selected={selected}
                accessibilityLabel={`${frequencyAccessibilityLabel(group.frequencyHz, group.attribution)}${radio}`}
                onPress={() => props.onConversation(selected ? null : group)}
              />
            );
          })}
          {(hidden > 0 || allFrequencies) &&
            props.conversations.length > FREQUENCY_CHIP_LIMIT && (
              <Chip
                label={allFrequencies ? 'Fewer' : `${hidden} more`}
                icon={allFrequencies ? 'chevron-up' : 'chevron-down'}
                accessibilityLabel={
                  allFrequencies
                    ? 'Show fewer frequencies'
                    : `Show ${hidden} more frequencies`
                }
                onPress={() => setAllFrequencies(!allFrequencies)}
              />
            )}
        </ChipGroup>
      )}

      <ChipGroup accessibilityLabel="Date range">
        {DATE_RANGE_FILTERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={props.range === option.value}
            onPress={() => props.onRange(option.value)}
          />
        ))}
        {props.before && (
          <Chip
            label={`Before ${formatShortInstant(Date.parse(props.before), props.timeZone)}`}
            icon="clock"
            tone="primary"
            onRemove={props.onClearBefore}
          />
        )}
      </ChipGroup>
      {props.conversations.some(
        (group) => group.attribution !== 'confirmed',
      ) && (
        <Text style={styles.hint}>
          Dashed frequencies are inferred or unknown, not confirmed by the
          radio.
        </Text>
      )}
    </View>
  );
}

const useStyles = createStyles((c) => ({
  root: { gap: space.md },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingLeft: space.md,
    paddingRight: space.xs,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.inputBorder,
    borderRadius: radius.md,
  },
  searchInput: {
    ...type.body,
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    borderWidth: 0,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
    color: c.textPrimary,
  },
  clear: {
    width: 40,
    minHeight: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  hint: { ...type.caption, color: c.textSecondary },
}));
