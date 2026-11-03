import {
  Badge,
  Chip,
  ChipGroup,
  Icon,
  Pressable,
  Text,
  useTheme,
} from '@signaldock/ui';
import { View } from 'react-native';
import type { RadioGroupKeyboard } from '../../../shared/radio-group';
import type { ConnectorCardModel } from '../processing-model';
import { useProcessingStyles } from './styles';

/** Provider choice: name, description, capability chips, local/cloud and simulated badges. */
export function ConnectorCard({
  card,
  selected,
  onSelect,
  disabled = false,
  focusProps,
}: {
  card: ConnectorCardModel;
  selected: boolean;
  onSelect(): void;
  disabled?: boolean;
  /** Radio-group keyboard props (roving Tab stop, focus tracking). */
  focusProps?: ReturnType<RadioGroupKeyboard['item']>;
}) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  const unavailable = !card.selectable || disabled;
  return (
    <Pressable
      {...focusProps}
      accessibilityRole="radio"
      accessibilityLabel={card.accessibilityLabel}
      accessibilityState={{ checked: selected, disabled: unavailable }}
      disabled={unavailable}
      onPress={onSelect}
      feedback={card.selectable ? 'opacity' : 'none'}
      style={[
        styles.cardPressable,
        styles.gridItem,
        selected && styles.cardSelected,
        !card.selectable && styles.cardDisabled,
      ]}
    >
      <View style={styles.between}>
        <View style={[styles.titleRow, styles.grow]}>
          <Icon
            name={card.execution === 'local' ? 'server' : 'signal'}
            size={18}
            color={selected ? colors.primary : colors.textSecondary}
          />
          <Text numberOfLines={1} style={styles.label}>
            {card.title}
          </Text>
        </View>
        {selected ? (
          <Icon name="check" size={18} color={colors.primary} />
        ) : null}
      </View>
      <Text style={styles.caption}>{card.description}</Text>
      <View style={styles.row}>
        <Badge
          label={card.executionLabel}
          tone={card.execution === 'local' ? 'primary' : 'neutral'}
          icon={card.execution === 'local' ? 'lock' : 'signal'}
        />
        {card.simulated ? <Badge label="Simulated" tone="warning" /> : null}
      </View>
      <ChipGroup accessibilityLabel={`${card.title} capabilities`}>
        {card.capabilities.map((capability) => (
          <Chip
            key={capability.capability}
            label={capability.label}
            icon={capability.icon}
          />
        ))}
      </ChipGroup>
      {card.reason ? <Text style={styles.warning}>{card.reason}</Text> : null}
    </Pressable>
  );
}
