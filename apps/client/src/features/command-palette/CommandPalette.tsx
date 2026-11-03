import type { IncidentRecord } from '@signaldock/contracts';
import {
  Icon,
  Overlay,
  Pressable,
  Text,
  TextInput,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
  useToast,
  type ToastOptions,
} from '@signaldock/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  View,
  type ScrollViewInstance,
  type TextInputKeyPressEvent,
} from 'react-native';
import { useRadioMedia } from '../media/MediaProvider';
import { useStation } from '../station/StationProvider';
import {
  blockedToast,
  commandLabel,
  moveHighlight,
  operationToast,
  paletteResults,
  type PaletteAction,
  type PaletteCommand,
  type PaletteContext,
  type PaletteSectionOption,
  type PaletteToast,
} from './command-model';
import { fetchOpenIncidents } from './incident-source';
import { paletteShortcutLabel } from './usePaletteShortcut';

/** Fetched open incidents are reused for this long across openings. */
const INCIDENT_CACHE_MS = 30_000;

export interface CommandPaletteProps<S extends string = string> {
  visible: boolean;
  onClose(): void;
  /** Workspace sections the operator may open. */
  sections: readonly PaletteSectionOption<S>[];
  /** The section on screen (undefined while More is open). */
  currentSection?: S | undefined;
  /**
   * Opens a section through the workspace navigation (which stops any
   * transmission). Resolve `false` when navigation did not happen.
   */
  onNavigate(section: S): void | boolean | Promise<void | boolean>;
  /** Opens the Incidents section with that incident's detail. */
  onOpenIncident?(incidentId: string): void | boolean | Promise<void | boolean>;
}

interface IncidentCache {
  at: number;
  items: IncidentRecord[];
  error: string;
}

/**
 * ⌘K palette: type a frequency to tune, a memory to recall, a radio, section
 * or open incident to jump to it, or run control and listening actions. Must
 * be rendered inside `StationProvider` and `MediaProvider`. Every command
 * reports its result with a toast; blocked commands explain why instead.
 */
export function CommandPalette<S extends string>({
  visible,
  onClose,
  sections,
  currentSection,
  onNavigate,
  onOpenIncident,
}: CommandPaletteProps<S>) {
  const station = useStation();
  const media = useRadioMedia();
  const toast = useToast();
  const stationRef = useRef(station);
  stationRef.current = station;
  const mediaRef = useRef(media);
  mediaRef.current = media;

  const [incidents, setIncidents] = useState<IncidentCache>({
    at: 0,
    items: [],
    error: '',
  });
  const incidentRequest = useRef<AbortController | null>(null);
  const sessionKey = `${station.session.baseUrl}\0${station.session.instanceId}\0${station.session.user.id}`;
  // A different account never sees the previous account's incidents.
  useEffect(() => {
    setIncidents({ at: 0, items: [], error: '' });
    return () => incidentRequest.current?.abort();
  }, [sessionKey]);
  useEffect(() => {
    if (!visible) incidentRequest.current?.abort();
  }, [visible]);
  /** Lazily loads open incidents once the operator starts typing. */
  const loadIncidents = useCallback(() => {
    if (incidentRequest.current && !incidentRequest.current.signal.aborted)
      return;
    if (Date.now() - incidents.at < INCIDENT_CACHE_MS) return;
    const controller = new AbortController();
    incidentRequest.current = controller;
    fetchOpenIncidents(stationRef.current.session, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted)
          setIncidents({ at: Date.now(), items, error: '' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setIncidents({
          at: Date.now(),
          items: [],
          error:
            error instanceof Error
              ? error.message
              : 'Incidents are unavailable.',
        });
      })
      .finally(() => {
        if (incidentRequest.current === controller)
          incidentRequest.current = null;
      });
  }, [incidents.at]);

  const show = useCallback(
    (result: PaletteToast) => {
      const options: ToastOptions = {
        message: result.message,
        tone: result.tone,
      };
      const radioId = result.radioId;
      if (result.fix === 'take-control' && radioId)
        options.action = {
          label: 'Take control',
          onPress: () => {
            // The toast outlives the palette: refuse if the selection moved.
            if (stationRef.current.radioId !== radioId) {
              toast.show({
                message: 'The selected radio changed. Nothing was sent.',
                tone: 'warning',
              });
              return;
            }
            void stationRef.current
              .takeControl()
              .catch((error: unknown) => ({
                ok: false as const,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Could not take control.',
              }))
              .then((outcome) => {
                const next = operationToast(outcome);
                toast.show({ message: next.message, tone: next.tone });
              });
          },
        };
      toast.show(options);
    },
    [toast],
  );

  const run = useCallback(
    async (action: PaletteAction) => {
      const current = stationRef.current;
      const sameRadio = (radioId: string) => current.radioId === radioId;
      const changed: PaletteToast = {
        message: 'The selected radio changed. Nothing was sent.',
        tone: 'warning',
      };
      switch (action.type) {
        case 'tune':
          if (!sameRadio(action.radioId)) return show(changed);
          return show(operationToast(await current.tune(action.tuning)));
        case 'recall':
          if (!sameRadio(action.radioId)) return show(changed);
          return show(
            operationToast(await current.recallMemory(action.memoryId)),
          );
        case 'take-control':
          if (!sameRadio(action.radioId)) return show(changed);
          return show(operationToast(await current.takeControl()));
        case 'release-control':
          if (!sameRadio(action.radioId)) return show(changed);
          return show(operationToast(await current.releaseControl()));
        case 'select-radio': {
          // Selection goes through the workspace, which stops media first.
          const selected = await current.selectRadio(action.radioId);
          return show(
            selected
              ? {
                  message: `Selected ${action.radioName}. Its tuning was not changed.`,
                  tone: 'success',
                }
              : {
                  message: `Could not select ${action.radioName} right now. Nothing changed.`,
                  tone: 'warning',
                },
          );
        }
        case 'listen':
          if (!sameRadio(action.radioId)) return show(changed);
          mediaRef.current.listen();
          return show({
            message: `Connecting audio for ${action.radioName}…`,
            tone: 'neutral',
          });
        case 'stop-listening':
          mediaRef.current.stopListening();
          return show({
            message: `Stopped listening to ${action.radioName}.`,
            tone: 'neutral',
          });
        case 'navigate': {
          const done = await onNavigate(action.section as S);
          return show(
            done === false
              ? {
                  message: `Could not open ${action.label} right now. Try again.`,
                  tone: 'warning',
                }
              : { message: `Opened ${action.label}.`, tone: 'neutral' },
          );
        }
        case 'open-incident': {
          const done = onOpenIncident
            ? await onOpenIncident(action.incidentId)
            : false;
          return show(
            done === false
              ? {
                  message: `Could not open incident “${action.title}”.`,
                  tone: 'warning',
                }
              : {
                  message: `Opened Incidents · “${action.title}”.`,
                  tone: 'neutral',
                },
          );
        }
      }
    },
    [onNavigate, onOpenIncident, show],
  );

  const execute = useCallback(
    (command: PaletteCommand) => {
      onClose();
      if (command.blocked || !command.action) {
        show(blockedToast(command));
        return;
      }
      void run(command.action).catch((error: unknown) =>
        show({
          message:
            error instanceof Error ? error.message : 'The command failed.',
          tone: 'error',
        }),
      );
    },
    [onClose, run, show],
  );

  const context: Omit<PaletteContext, 'incidents'> = {
    radios: station.radios,
    selected: station.selected,
    memories: station.memories,
    controlState: station.controlState,
    controlOwnerLabel: station.controlOwnerLabel,
    canControl: station.canControl,
    busy: station.busy,
    editable: station.editable,
    leaseGeneration:
      station.lease && station.lease.radioId === station.radioId
        ? station.lease.generation
        : undefined,
    media: station.selected
      ? {
          supported: media.supported,
          configured: media.configured,
          listening: media.state.listening,
          canListen: media.access.canListen,
          listenReason: media.access.listenReason,
        }
      : undefined,
    sections,
    currentSection,
  };

  return (
    <Overlay
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Command palette"
      placement="top"
      maxWidth={600}
    >
      {visible ? (
        <PaletteBody
          context={{ ...context, incidents: incidents.items }}
          incidentError={incidents.error}
          onQuery={loadIncidents}
          onExecute={execute}
          onClose={onClose}
        />
      ) : null}
    </Overlay>
  );
}

/** Mounted only while open, so every opening starts with an empty query. */
function PaletteBody({
  context,
  incidentError,
  onQuery,
  onExecute,
  onClose,
}: {
  context: PaletteContext;
  incidentError: string;
  onQuery(): void;
  onExecute(command: PaletteCommand): void;
  onClose(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const results = useMemo(
    () => paletteResults(query, context),
    [query, context],
  );
  const active = Math.min(highlight, Math.max(results.length - 1, 0));
  const web = Platform.OS === 'web';
  const shortcut = paletteShortcutLabel();

  const list = useRef<ScrollViewInstance>(null);
  const rows = useRef<{ y: number; height: number }[]>([]);
  const viewport = useRef({ offset: 0, height: 0 });
  useEffect(() => {
    const row = rows.current[active];
    if (!row) return;
    const { offset, height } = viewport.current;
    if (row.y < offset) list.current?.scrollTo({ y: row.y, animated: false });
    else if (height && row.y + row.height > offset + height)
      list.current?.scrollTo({
        y: row.y + row.height - height,
        animated: false,
      });
  }, [active]);

  const onKeyPress = (event: TextInputKeyPressEvent) => {
    const key = event.nativeEvent.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      setHighlight(
        moveHighlight(active, key === 'ArrowDown' ? 1 : -1, results.length),
      );
    } else if (key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  const submit = () => {
    const command = results[active];
    if (command) onExecute(command);
  };
  const optionId = (index: number) => `signaldock-palette-option-${index}`;
  const listboxId = 'signaldock-palette-results';

  return (
    <>
      <View style={styles.queryRow}>
        <Icon name="search" size={18} color={colors.textSecondary} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setHighlight(0);
            if (text.trim()) onQuery();
          }}
          onKeyPress={onKeyPress}
          onSubmitEditing={submit}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel="Search commands, or type a frequency"
          placeholder="Type a frequency, memory, radio or section…"
          style={styles.input}
          {...(web
            ? ({
                role: 'combobox',
                'aria-expanded': results.length > 0,
                ...(results.length > 0 ? { 'aria-controls': listboxId } : {}),
                'aria-autocomplete': 'list',
                ...(results[active]
                  ? { 'aria-activedescendant': optionId(active) }
                  : {}),
              } as object)
            : {})}
        />
        {web ? <Text style={styles.kbd}>esc</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close command palette"
          onPress={onClose}
          style={styles.close}
        >
          <Icon name="close" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
      <ScrollView
        ref={list}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        onLayout={(event) => {
          viewport.current.height = event.nativeEvent.layout.height;
        }}
        onScroll={(event) => {
          viewport.current.offset = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={32}
        // The listbox exists only while it holds options; the empty state is
        // plain text and the footer announces it.
        {...(results.length === 0
          ? {}
          : web
            ? ({ nativeID: listboxId, role: 'listbox' } as object)
            : { accessibilityRole: 'list' as const })}
      >
        {results.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {query.trim()
                ? `No commands match “${query.trim()}”.`
                : 'Nothing to run right now.'}
            </Text>
            <Text style={styles.caption}>
              Type a frequency like 146.52, a memory, radio, section or open
              incident.
            </Text>
          </View>
        ) : (
          results.map((command, index) => (
            <ResultRow
              key={command.id}
              command={command}
              highlighted={index === active}
              showEnter={web && index === active}
              nativeID={optionId(index)}
              onLayout={(y, height) => {
                rows.current[index] = { y, height };
              }}
              onHover={() => setHighlight(index)}
              onPress={() => onExecute(command)}
            />
          ))
        )}
      </ScrollView>
      <View accessibilityLiveRegion="polite" style={styles.footer}>
        <Text style={styles.caption}>
          {results.length === 0
            ? query.trim()
              ? 'No commands match'
              : ''
            : `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
          {query.trim() && incidentError
            ? ' · Incident search unavailable.'
            : ''}
        </Text>
        {web ? (
          <Text style={styles.caption}>
            ↑↓ move · ↵ run · esc close{shortcut ? ` · ${shortcut} toggle` : ''}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function ResultRow({
  command,
  highlighted,
  showEnter,
  nativeID,
  onLayout,
  onHover,
  onPress,
}: {
  command: PaletteCommand;
  highlighted: boolean;
  showEnter: boolean;
  nativeID: string;
  onLayout(y: number, height: number): void;
  onHover(): void;
  onPress(): void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const blocked = command.blocked;
  const iconColor = blocked
    ? colors.textSecondary
    : highlighted
      ? colors.primary
      : colors.textSecondary;
  return (
    <Pressable
      nativeID={nativeID}
      accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
      {...(Platform.OS === 'web' ? ({ role: 'option' } as object) : {})}
      accessibilityLabel={commandLabel(command)}
      accessibilityState={{ selected: highlighted }}
      {...(blocked
        ? { accessibilityHint: 'Explains why this is unavailable.' }
        : {})}
      focusable={Platform.OS !== 'web'}
      onHoverIn={onHover}
      onPress={onPress}
      onLayout={(event) =>
        onLayout(event.nativeEvent.layout.y, event.nativeEvent.layout.height)
      }
      style={[styles.row, highlighted && styles.rowHighlighted]}
    >
      <Icon
        name={blocked ? 'lock' : command.icon}
        size={18}
        color={iconColor}
      />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.title}>
          {command.title}
          {command.value ? (
            <Text style={styles.value}> {command.value}</Text>
          ) : null}
        </Text>
        {blocked ? (
          <Text numberOfLines={2} style={[styles.caption, styles.reason]}>
            {blocked.reason}
          </Text>
        ) : command.subtitle ? (
          <Text numberOfLines={1} style={styles.caption}>
            {command.subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={styles.hint}>
        {showEnter && !blocked
          ? '↵'
          : blocked
            ? blocked.fix === 'take-control'
              ? 'Needs control'
              : 'Unavailable'
            : command.hint}
      </Text>
    </Pressable>
  );
}

const useStyles = createStyles((c) => ({
  queryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  input: {
    flex: 1,
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: c.surface,
    paddingHorizontal: space.sm,
  },
  kbd: {
    ...type.caption,
    color: c.textSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
  },
  close: {
    width: layout.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { flexGrow: 0, maxHeight: 420 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  rowHighlighted: { backgroundColor: c.selected },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...type.label, color: c.textPrimary },
  value: {
    ...type.label,
    fontFamily: type.frequency.fontFamily,
    fontVariant: ['tabular-nums'],
    color: c.textPrimary,
    fontWeight: '700',
  },
  caption: { ...type.caption, color: c.textSecondary },
  reason: { color: c.warning },
  hint: { ...type.caption, color: c.textSecondary },
  empty: { padding: space.lg, gap: space.xs },
  emptyTitle: { ...type.label, color: c.textPrimary },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.sm,
  },
}));
