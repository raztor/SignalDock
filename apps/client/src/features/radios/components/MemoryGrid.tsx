import type { RadioMemory, Tuning } from '@signaldock/contracts';
import {
  Button,
  Chip,
  ChipGroup,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Heading,
  Icon,
  LoadingState,
  Overlay,
  Pressable,
  Text,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
  useToast,
} from '@signaldock/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import {
  formatTuning,
  useStation,
  type StationOperationResult,
} from '../../station';
import {
  activeMemoryLabel,
  activeMemoryState,
  filterMemoriesByBand,
  memoryAccess,
  memoryBandFilters,
  memoryDisplayName,
  memoryGridColumns,
  memoryTileSummary,
  overwriteMessage,
  storeCandidate,
  type ActiveMemoryState,
  type MemoryAccess,
} from './memory-grid-model';

export interface MemoryGridProps {
  /** Section heading; `null` hides it when the host already titles the section. */
  title?: string | null;
}

interface PendingStore {
  radioId: string;
  memory: RadioMemory;
  tuning: Tuning;
  inferred: boolean;
}

/**
 * iOS cannot present a modal while another is still being dismissed, so the
 * confirmation opens a moment after the options sheet closes.
 */
const MODAL_HANDOFF_MS = Platform.OS === 'ios' ? 350 : 0;

const useStyles = createStyles((c) => ({
  section: { gap: space.md },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  count: { ...type.caption, color: c.textSecondary },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  reasonText: { ...type.caption, color: c.textSecondary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    minHeight: 84,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  tileActive: {
    borderWidth: 2,
    borderColor: c.primary,
    backgroundColor: c.selected,
  },
  tileUnconfirmed: { borderStyle: 'dashed', borderColor: c.warning },
  tileBody: {
    flex: 1,
    minHeight: 84,
    justifyContent: 'flex-start',
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    gap: 2,
    borderRadius: radius.md,
  },
  // Only the name shares its row with the options button.
  name: {
    ...type.label,
    fontSize: 13,
    lineHeight: 18,
    color: c.textPrimary,
    paddingRight: space.xl,
  },
  frequency: {
    fontFamily: type.frequency.fontFamily,
    fontVariant: ['tabular-nums'],
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: c.textPrimary,
  },
  detail: {
    ...type.caption,
    fontSize: 11,
    lineHeight: 16,
    color: c.textSecondary,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  activeText: {
    ...type.caption,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    color: c.primary,
  },
  unconfirmedText: { color: c.warning },
  pendingText: {
    ...type.caption,
    fontSize: 11,
    lineHeight: 16,
    color: c.warning,
  },
  more: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 36,
    minHeight: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  sheetTitle: { ...type.heading, color: c.textPrimary },
  sheetMeta: {
    fontFamily: type.frequency.fontFamily,
    fontVariant: ['tabular-nums'],
    fontSize: 15,
    lineHeight: 22,
    color: c.textSecondary,
  },
  sheetHint: { ...type.caption, color: c.textSecondary },
  sheetWarning: { ...type.caption, color: c.warning },
  sheetActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
  },
}));

/**
 * Channel memories for the selected radio as a grid of tiles. A press recalls
 * the memory (only with the control lease on a ready, idle radio); otherwise
 * the tiles are informational and say why. Overwriting a memory goes through
 * an options sheet and a confirmation. Results are reported as toasts.
 */
export function MemoryGrid({ title = 'Channel memories' }: MemoryGridProps) {
  const station = useStation();
  const {
    selected,
    memories,
    memoriesLoaded,
    memoriesError,
    editable,
    controlState,
    canControl,
    busy,
    recallMemory,
    storeMemory,
  } = station;
  const toast = useToast();
  const styles = useStyles();
  const { colors } = useTheme();

  const [band, setBand] = useState<string | undefined>();
  const [width, setWidth] = useState(0);
  const [pending, setPending] = useState<{
    memoryId: string;
    kind: 'recall' | 'store';
  } | null>(null);
  const [options, setOptions] = useState<RadioMemory | null>(null);
  const [confirm, setConfirm] = useState<PendingStore | null>(null);
  const handoff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const radioId = selected?.radioId;
  // A different radio has different memories: drop filters and open dialogs.
  useEffect(() => {
    setBand(undefined);
    setOptions(null);
    setConfirm(null);
    setPending(null);
    if (handoff.current) clearTimeout(handoff.current);
  }, [radioId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (handoff.current) clearTimeout(handoff.current);
    };
  }, []);

  const access: MemoryAccess = memoryAccess({
    radio: selected,
    editable,
    controlState,
    canControl,
    busy,
  });
  const filters = useMemo(() => memoryBandFilters(memories), [memories]);
  const activeBand = filters.some((item) => item.band === band)
    ? band
    : undefined;
  const visible = useMemo(
    () => filterMemoriesByBand(memories, activeBand),
    [memories, activeBand],
  );
  const { tileWidth } = memoryGridColumns(width, space.sm);
  const activeId = selected?.snapshot?.selectedMemoryId;
  const activeState = activeMemoryState(selected?.snapshot);
  const candidate = storeCandidate(selected?.snapshot);

  if (!selected || !access.readable) return null;

  const report = (result: StationOperationResult) => {
    toast.show(
      result.ok
        ? { message: result.message, tone: 'success' }
        : { message: result.error, tone: 'error' },
    );
  };

  const recall = async (memory: RadioMemory) => {
    if (!access.canRecall || pending) return;
    setPending({ memoryId: memory.memoryId, kind: 'recall' });
    const result = await recallMemory(memory.memoryId);
    if (!mounted.current) return;
    setPending(null);
    report(result);
  };

  const openOptions = (memory: RadioMemory) => setOptions(memory);
  const requestStore = (memory: RadioMemory) => {
    if (!access.canStore || !candidate.ok) return;
    const next: PendingStore = {
      radioId: selected.radioId,
      memory,
      tuning: candidate.tuning,
      inferred: candidate.inferred,
    };
    setOptions(null);
    if (handoff.current) clearTimeout(handoff.current);
    if (MODAL_HANDOFF_MS === 0) setConfirm(next);
    else
      handoff.current = setTimeout(() => {
        if (mounted.current) setConfirm(next);
      }, MODAL_HANDOFF_MS);
  };
  const store = async () => {
    const request = confirm;
    setConfirm(null);
    // The confirmation names one memory on one radio; never apply it elsewhere.
    if (!request || request.radioId !== selected.radioId) return;
    setPending({ memoryId: request.memory.memoryId, kind: 'store' });
    const result = await storeMemory(request.memory.memoryId, request.tuning);
    if (!mounted.current) return;
    setPending(null);
    report(result);
  };

  const headerCount =
    activeBand === undefined
      ? `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`
      : `${visible.length} of ${memories.length} memories`;

  return (
    <View style={styles.section}>
      {title !== null || memories.length > 0 ? (
        <View style={styles.header}>
          {title !== null && <Heading>{title}</Heading>}
          {memoriesLoaded && memories.length > 0 && (
            <Text style={styles.count}>{headerCount}</Text>
          )}
        </View>
      ) : null}

      {!memoriesLoaded ? (
        <LoadingState label="Loading memories…" />
      ) : memoriesError ? (
        <ErrorState message={memoriesError} />
      ) : !memories.length ? (
        <EmptyState
          title="No memories"
          message="This radio has no readable channel memories."
        />
      ) : (
        <>
          {access.recallReason && (
            <View
              style={styles.reason}
              accessible
              accessibilityLabel={`Memories are read-only. ${access.recallReason}`}
            >
              <Icon name="lock" size={14} color={colors.textSecondary} />
              <Text style={styles.reasonText}>{access.recallReason}</Text>
            </View>
          )}

          {filters.length > 0 && (
            <ChipGroup accessibilityLabel="Filter memories by band">
              <Chip
                label={`All · ${memories.length}`}
                accessibilityLabel={`All bands, ${memories.length} memories`}
                selected={activeBand === undefined}
                onPress={() => setBand(undefined)}
              />
              {filters.map((item) => (
                <Chip
                  key={item.band}
                  label={`${item.band} · ${item.count}`}
                  accessibilityLabel={`${item.band}, ${item.count} ${item.count === 1 ? 'memory' : 'memories'}`}
                  selected={activeBand === item.band}
                  onPress={() =>
                    setBand(activeBand === item.band ? undefined : item.band)
                  }
                />
              ))}
            </ChipGroup>
          )}

          <View
            style={styles.grid}
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          >
            {visible.map((memory) => (
              <MemoryTile
                key={memory.memoryId}
                memory={memory}
                width={width > 0 ? tileWidth : undefined}
                active={memory.memoryId === activeId}
                activeState={activeState}
                pending={
                  pending?.memoryId === memory.memoryId
                    ? pending.kind
                    : undefined
                }
                access={access}
                busy={busy || pending !== null}
                onRecall={() => void recall(memory)}
                onOptions={() => openOptions(memory)}
                styles={styles}
              />
            ))}
          </View>
        </>
      )}

      <Overlay
        visible={options !== null}
        onClose={() => setOptions(null)}
        accessibilityLabel={
          options
            ? `Options for ${memoryDisplayName(options)}`
            : 'Memory options'
        }
        maxWidth={layout.form}
      >
        {options && (
          <MemoryOptions
            memory={options}
            access={access}
            candidate={candidate}
            busy={busy || pending !== null}
            onStore={() => requestStore(options)}
            onClose={() => setOptions(null)}
            styles={styles}
          />
        )}
      </Overlay>

      <ConfirmDialog
        visible={confirm !== null}
        title="Overwrite memory?"
        message={
          confirm
            ? overwriteMessage(confirm.memory, confirm.tuning, confirm.inferred)
            : ''
        }
        confirmLabel="Overwrite"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void store()}
      />
    </View>
  );
}

type Styles = ReturnType<typeof useStyles>;

function MemoryTile({
  memory,
  width,
  active,
  activeState,
  pending,
  access,
  busy,
  onRecall,
  onOptions,
  styles,
}: {
  memory: RadioMemory;
  width: number | undefined;
  active: boolean;
  activeState: ActiveMemoryState;
  pending: 'recall' | 'store' | undefined;
  access: MemoryAccess;
  busy: boolean;
  onRecall: () => void;
  onOptions: () => void;
  styles: Styles;
}) {
  const { colors } = useTheme();
  const summary = memoryTileSummary(memory);
  const unconfirmed = active && activeState !== 'confirmed';
  const activeText = active ? activeMemoryLabel(activeState) : undefined;
  const body = (
    <>
      <Text style={styles.name} numberOfLines={2}>
        {summary.name}
      </Text>
      <Text style={styles.frequency} numberOfLines={1}>
        {summary.frequency}
      </Text>
      <Text style={styles.detail} numberOfLines={1}>
        {summary.detail}
      </Text>
      {pending ? (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={colors.warning} />
          <Text style={styles.pendingText}>
            {pending === 'recall' ? 'Recalling…' : 'Storing…'}
          </Text>
        </View>
      ) : activeText ? (
        <View style={styles.status}>
          <Icon
            name={unconfirmed ? 'alert' : 'check'}
            size={12}
            color={unconfirmed ? colors.warning : colors.primary}
          />
          <Text
            style={[styles.activeText, unconfirmed && styles.unconfirmedText]}
          >
            {activeText}
          </Text>
        </View>
      ) : null}
    </>
  );
  const spoken = `${summary.spoken}${activeText ? `, ${activeText}` : ''}`;
  return (
    <View
      style={[
        styles.tile,
        width === undefined ? { flexGrow: 1, flexBasis: 148 } : { width },
        active && styles.tileActive,
        unconfirmed && styles.tileUnconfirmed,
      ]}
    >
      {access.canRecall ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Recall ${spoken}`}
          accessibilityState={{ selected: active, busy: pending !== undefined }}
          disabled={busy}
          onPress={onRecall}
          onLongPress={access.writable ? onOptions : undefined}
          style={styles.tileBody}
        >
          {body}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={spoken}
          accessibilityState={{ selected: active }}
          style={styles.tileBody}
        >
          {body}
        </View>
      )}
      {access.writable && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Options for ${summary.name}`}
          hitSlop={6}
          onPress={onOptions}
          style={styles.more}
        >
          <Icon name="more" size={18} color={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
}

function MemoryOptions({
  memory,
  access,
  candidate,
  busy,
  onStore,
  onClose,
  styles,
}: {
  memory: RadioMemory;
  access: MemoryAccess;
  candidate: ReturnType<typeof storeCandidate>;
  busy: boolean;
  onStore: () => void;
  onClose: () => void;
  styles: Styles;
}) {
  const summary = memoryTileSummary(memory);
  const reason = !access.canStore
    ? access.storeReason
    : !candidate.ok
      ? candidate.reason
      : busy
        ? 'Another radio operation is in progress.'
        : undefined;
  return (
    <>
      <Text accessibilityRole="header" style={styles.sheetTitle}>
        {summary.name}
      </Text>
      <Text style={styles.sheetMeta}>
        {summary.frequency} MHz · {summary.detail}
      </Text>
      {candidate.ok && (
        <Text
          style={candidate.inferred ? styles.sheetWarning : styles.sheetHint}
        >
          Current tuning: {formatTuning(candidate.tuning)}
          {candidate.inferred ? ' · not confirmed by the radio' : ''}
        </Text>
      )}
      {reason && <Text style={styles.sheetHint}>{reason}</Text>}
      <View style={styles.sheetActions}>
        <Button
          variant="primary"
          label="Store current tuning here"
          disabled={reason !== undefined}
          onPress={onStore}
        />
        <Button variant="quiet" label="Cancel" onPress={onClose} />
      </View>
    </>
  );
}
