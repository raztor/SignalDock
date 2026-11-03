import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ClientSession, FeatureScreenProps } from '@signaldock/contracts';
import {
  Action,
  FeatureView,
  FormLayout,
  Heading,
  Icon,
  LoadingState,
  Pressable,
  ScrollView,
  Text,
  ThemeProvider,
  ToastProvider,
  createStyles,
  layout,
  radius,
  space as s,
  type,
  useTheme,
  type IconName,
} from '@signaldock/ui';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, View, useWindowDimensions } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { UserAdminScreen } from '../features/admin/UserAdminScreen';
import { AprsScreen } from '../features/aprs/AprsScreen';
import {
  BootstrapScreen,
  LoginScreen,
  SessionController,
  SessionListScreen,
  createPlatformAuthOptions,
  useAuthSession,
} from '../features/auth';
import {
  CommandPalette,
  paletteShortcutLabel,
  usePaletteShortcut,
} from '../features/command-palette';
import { HistoryScreen } from '../features/history/HistoryScreen';
import {
  IncidentsScreen,
  type IncidentFocusRequest,
} from '../features/incidents/IncidentsScreen';
import {
  MediaProvider,
  stopActiveMedia,
  stopActiveTransmit,
} from '../features/media';
import { NotificationsScreen } from '../features/notifications/NotificationsScreen';
import { ProcessingScreen } from '../features/processing/ProcessingScreen';
import { RadioDashboardScreen } from '../features/radios/RadioDashboardScreen';
import ServerConnectionScreen from '../features/servers/screens/ServerConnectionScreen';
import { StationProvider, useStation } from '../features/station';
import { StationStrip } from '../features/station/components/StationStrip';
import PlatformAccessibility from './PlatformAccessibility';
import { transmitPreparedSpeech } from './transmit-speech';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider storage={AsyncStorage}>
        <Application />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
function Application() {
  const { mode, setPreference } = useTheme();
  const styles = useShellStyles();
  const controller = useMemo(
    () =>
      new SessionController({
        ...createPlatformAuthOptions(),
        onContextChanging: () => stopActiveMedia('Account or server changed.'),
      }),
    [],
  );
  const auth = useAuthSession(controller);
  const [servers, showServers] = useState(true);
  const insets = useSafeAreaInsets();
  /** Height of the workspace's bottom dock (station strip + tab bar). */
  const [dock, setDock] = useState(0);
  useEffect(() => () => controller.dispose(), [controller]);
  const back = () => {
    void stopActiveMedia('Selecting a server.').then(() => showServers(true));
  };
  return (
    <SafeAreaView
      nativeID="signaldock-root"
      style={styles.page}
      edges={['top', 'left', 'right']}
    >
      <PlatformAccessibility />
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <ToastProvider
        insets={{
          bottom: Math.max(insets.bottom, !servers && auth.session ? dock : 0),
        }}
      >
        {servers ? (
          <ServerConnectionScreen
            onServerSelected={async (baseUrl, info) => {
              await controller.selectServer(baseUrl, info);
              await controller.restore();
              showServers(false);
            }}
            onServerRemoved={(server) => controller.forgetServer(server)}
          />
        ) : !auth.session ? (
          <FormLayout>
            <View style={styles.authHeader}>
              <Brand />
              <View style={styles.actions}>
                <Action label="Servers" onPress={back} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Switch color theme"
                  onPress={() =>
                    setPreference(mode === 'dark' ? 'light' : 'dark')
                  }
                  style={styles.iconButton}
                >
                  <Icon name={mode === 'dark' ? 'sun' : 'moon'} />
                </Pressable>
              </View>
            </View>
            {auth.status === 'signing_in' && (
              <LoadingState label="Signing in…" />
            )}
            {auth.bootstrapRequired ? (
              <BootstrapScreen controller={controller} />
            ) : (
              <LoginScreen controller={controller} />
            )}
          </FormLayout>
        ) : (
          <Workspace
            key={`${auth.session.baseUrl}:${auth.session.instanceId}:${auth.session.user.id}`}
            session={auth.session}
            displayName={auth.server?.info.displayName ?? 'Station'}
            mediaAvailable={auth.server?.info.features.liveAudio ?? false}
            onServers={back}
            onSignOut={() => {
              void controller.signOut();
            }}
            onDockLayout={setDock}
          />
        )}
      </ToastProvider>
    </SafeAreaView>
  );
}
type Section =
  | 'Radios'
  | 'History'
  | 'Incidents'
  | 'APRS'
  | 'Notifications'
  | 'Processing'
  | 'Sessions'
  | 'Administration';
const sectionIcons: Record<Section, IconName> = {
  Radios: 'radio',
  History: 'history',
  Incidents: 'alert',
  APRS: 'map',
  Notifications: 'bell',
  Processing: 'settings',
  Sessions: 'session',
  Administration: 'users',
};
const sectionLabels: Record<Section, string> = {
  Radios: 'Radios',
  History: 'History',
  Incidents: 'Incidents',
  APRS: 'Map & packets',
  Notifications: 'Notifications',
  Processing: 'Processing',
  Sessions: 'Sessions',
  Administration: 'Users & access',
};
const primary: Section[] = ['Radios', 'History', 'APRS', 'Notifications'];
function Brand() {
  const styles = useShellStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.brandRow}>
      <Icon name="radio" size={24} color={colors.primary} />
      <Text style={styles.brand}>SignalDock</Text>
    </View>
  );
}
function Workspace({
  session,
  displayName,
  onServers,
  onSignOut,
  mediaAvailable,
  onDockLayout,
}: {
  session: ClientSession;
  displayName: string;
  onServers: () => void;
  onSignOut: () => void;
  mediaAvailable: boolean;
  /** Reports the bottom dock height so toasts sit above it. */
  onDockLayout?: (height: number) => void;
}) {
  const [section, setSection] = useState<Section>('Radios');
  const [more, setMore] = useState(false);
  const [visited, setVisited] = useState<Set<Section>>(
    new Set(['Notifications']),
  );
  const { colors, mode, preference, setPreference } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useShellStyles();
  const [radioId, setRadioId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { width } = useWindowDimensions();
  /** Resolves false when navigation was skipped because another is running. */
  const navigate = async (next: Section): Promise<boolean> => {
    if (busy) return false;
    if (next === section) {
      // Closing More is navigation too: the station strip PTT stays mounted.
      setBusy(true);
      try {
        await stopActiveTransmit('Navigation changed.');
        setMore(false);
      } finally {
        setBusy(false);
      }
      return true;
    }
    setBusy(true);
    try {
      // Listening continues across sections; transmission never does.
      await stopActiveTransmit('Navigation changed.');
      setSection(next);
      setMore(false);
      setVisited((previous) => new Set([...previous, next]));
    } finally {
      setBusy(false);
    }
    return true;
  };
  const [palette, setPalette] = useState(false);
  const [incidentFocus, setIncidentFocus] = useState<IncidentFocusRequest>();
  /** Palette: open the Incidents section with that incident's detail. */
  const openIncident = async (incidentId: string) => {
    if (!(await navigate('Incidents'))) return false;
    setIncidentFocus((previous) => ({
      incidentId,
      requestId: (previous?.requestId ?? 0) + 1,
    }));
    return true;
  };
  usePaletteShortcut(palette, setPalette);
  const shortcut = paletteShortcutLabel();
  const selectRadio = async (id: string) => {
    if (id === radioId || busy) return;
    setBusy(true);
    try {
      await stopActiveMedia('Selected radio changed.');
      setRadioId(id);
    } finally {
      setBusy(false);
    }
  };
  const props = {
    session,
    ...(radioId ? { radioId } : {}),
    onSelectRadio: (id: string) => {
      void selectRadio(id);
    },
  };
  const sections: Section[] = [
    'Radios',
    'History',
    'Incidents',
    'APRS',
    'Notifications',
    'Sessions',
    ...(session.user.role === 'administrator'
      ? ['Processing' as const, 'Administration' as const]
      : []),
  ];

  const wide = width >= layout.wide;
  const navItem = (name: Section, compact = false) => (
    <Pressable
      key={name}
      accessibilityRole="tab"
      accessibilityState={{
        selected: name === section && !more,
        disabled: busy,
      }}
      accessibilityLabel={sectionLabels[name]}
      disabled={busy}
      onPress={() => {
        void navigate(name);
      }}
      style={[
        compact ? styles.bottomItem : styles.navItem,
        name === section && !more && styles.navSelected,
      ]}
    >
      <Icon
        name={sectionIcons[name]}
        color={
          name === section && !more ? colors.primary : colors.textSecondary
        }
      />
      <Text
        style={[
          styles.navLabel,
          name === section && !more && { color: colors.primary },
        ]}
      >
        {compact && name === 'APRS'
          ? 'Map'
          : compact && name === 'Notifications'
            ? 'Alerts'
            : sectionLabels[name]}
      </Text>
    </Pressable>
  );
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (more) {
          void stopActiveTransmit('Navigation changed.').then(() =>
            setMore(false),
          );
          return true;
        }
        if (section !== 'Radios') {
          void navigate('Radios');
          return true;
        }
        return false;
      },
    );
    return () => subscription.remove();
  }, [more, section, busy]);
  useEffect(() => () => onDockLayout?.(0), [onDockLayout]);
  const radiosVisible = section === 'Radios' && !more;
  return (
    <StationProvider
      session={session}
      {...(radioId ? { radioId } : {})}
      onSelectRadio={(id) => {
        void selectRadio(id);
      }}
    >
      <MediaProvider mediaAvailable={mediaAvailable}>
        <View style={styles.workspace}>
          {wide && (
            <View style={styles.sidebar}>
              <Brand />
              <Text style={styles.navCaption}>WORKSPACE</Text>
              <View accessibilityRole="tablist" style={styles.navList}>
                {sections.map((name) => navItem(name))}
              </View>
              <View style={styles.sidebarFooter}>
                <Text style={styles.account}>{session.user.username}</Text>
                <Text style={styles.muted}>{session.user.role}</Text>
                <Action
                  label="Change server"
                  variant="quiet"
                  onPress={onServers}
                />
                <Action label="Sign out" variant="quiet" onPress={onSignOut} />
              </View>
            </View>
          )}
          <View style={styles.main}>
            <View style={styles.workspaceHeader}>
              <View style={styles.headerTitle}>
                {!wide && <Brand />}
                <Text numberOfLines={1} style={styles.station}>
                  {displayName}
                </Text>
                {wide && (
                  <Text numberOfLines={1} style={styles.address}>
                    {session.baseUrl}
                  </Text>
                )}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open command palette"
                accessibilityHint={
                  shortcut
                    ? `Search commands or type a frequency. Shortcut ${shortcut}.`
                    : 'Search commands or type a frequency.'
                }
                onPress={() => setPalette(true)}
                style={wide ? styles.searchButton : styles.iconButton}
              >
                <Icon name="search" color={colors.textSecondary} />
                {wide && (
                  <Text style={styles.searchLabel}>
                    Search{shortcut ? ` · ${shortcut}` : ''}
                  </Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Switch color theme"
                onPress={() =>
                  setPreference(mode === 'dark' ? 'light' : 'dark')
                }
                style={styles.iconButton}
              >
                <Icon name={mode === 'dark' ? 'sun' : 'moon'} />
              </Pressable>
            </View>
            {more && (
              <ScrollView contentContainerStyle={styles.morePage}>
                <Heading>Station & account</Heading>
                <Text style={styles.muted}>
                  {session.user.username} · {session.user.role}
                </Text>
                {sections
                  .filter((name) => !primary.includes(name))
                  .map((name) => navItem(name))}
                <Heading>Appearance</Heading>
                <View style={styles.actions}>
                  {(['system', 'light', 'dark'] as const).map((value) => (
                    <Action
                      key={value}
                      label={value.charAt(0).toUpperCase() + value.slice(1)}
                      active={preference === value}
                      onPress={() => setPreference(value)}
                    />
                  ))}
                </View>
                <Text style={styles.muted}>{session.baseUrl}</Text>
                <Action label="Change server" onPress={onServers} />
                <Action label="Sign out" onPress={onSignOut} />
              </ScrollView>
            )}
            <View style={[styles.content, more && styles.hidden]}>
              {radiosVisible && (
                <View style={styles.radioContent}>
                  <RadioDashboardScreen />
                </View>
              )}
              {visited.has('History') && (
                <FeatureView active={section === 'History' && !more}>
                  <HistoryScreen {...props} />
                </FeatureView>
              )}
              {visited.has('Incidents') && (
                <FeatureView active={section === 'Incidents' && !more}>
                  <IncidentsScreen {...props} focusIncident={incidentFocus} />
                </FeatureView>
              )}
              {visited.has('APRS') && (
                <FeatureView active={section === 'APRS' && !more}>
                  <AprsScreen {...props} />
                </FeatureView>
              )}
              <FeatureView active={section === 'Notifications' && !more}>
                <NotificationsScreen
                  {...props}
                  onSelectRadio={(id) => {
                    void selectRadio(id).then(() => navigate('Radios'));
                  }}
                />
              </FeatureView>
              {visited.has('Processing') && (
                <FeatureView active={section === 'Processing' && !more}>
                  <ProcessingSection {...props} />
                </FeatureView>
              )}
              {visited.has('Sessions') && (
                <FeatureView active={section === 'Sessions' && !more}>
                  <SessionListScreen {...props} />
                </FeatureView>
              )}
              {visited.has('Administration') && (
                <FeatureView active={section === 'Administration' && !more}>
                  <UserAdminScreen session={session} />
                </FeatureView>
              )}
            </View>
            <View
              onLayout={(event) =>
                onDockLayout?.(event.nativeEvent.layout.height)
              }
            >
              {!radiosVisible && (
                <StationStrip
                  onOpenRadio={() => {
                    void navigate('Radios');
                  }}
                />
              )}
              {!wide && (
                <View
                  accessibilityRole="tablist"
                  style={[
                    styles.bottomNav,
                    { paddingBottom: Math.max(insets.bottom, s.sm) },
                  ]}
                >
                  {primary.map((name) => navItem(name, true))}
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{
                      selected: more || !primary.includes(section),
                      disabled: busy,
                    }}
                    disabled={busy}
                    accessibilityLabel="More station options"
                    onPress={() => {
                      void stopActiveTransmit('Navigation changed.').then(() =>
                        setMore(!more),
                      );
                    }}
                    style={[
                      styles.bottomItem,
                      (more || !primary.includes(section)) &&
                        styles.navSelected,
                    ]}
                  >
                    <Icon name="more" />
                    <Text style={styles.navLabel}>More</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        </View>
        <CommandPalette
          visible={palette}
          onClose={() => setPalette(false)}
          sections={sections.map((name) => ({
            key: name,
            label: sectionLabels[name],
            icon: sectionIcons[name],
          }))}
          currentSection={more ? undefined : section}
          onNavigate={navigate}
          onOpenIncident={openIncident}
        />
      </MediaProvider>
    </StationProvider>
  );
}
/**
 * Prepared speech takes its own bounded radio lease, so a station lease held
 * for the same radio is released first.
 */
function ProcessingSection(props: FeatureScreenProps) {
  const { session, lease, releaseControl } = useStation();
  const onTransmitSpeech = useCallback(
    async (jobId: string, radioId: string, signal: AbortSignal) => {
      if (lease?.radioId === radioId) {
        const released = await releaseControl();
        if (!released.ok) throw new Error(released.error);
      }
      await transmitPreparedSpeech(session, jobId, radioId, signal);
    },
    [session, lease, releaseControl],
  );
  return <ProcessingScreen {...props} onTransmitSpeech={onTransmitSpeech} />;
}
const useShellStyles = createStyles((c) => ({
  page: { flex: 1, backgroundColor: c.background },
  workspace: { flex: 1, flexDirection: 'row' },
  sidebar: {
    width: layout.sidebar,
    padding: s.lg,
    backgroundColor: c.surface,
    borderRightWidth: 1,
    borderColor: c.border,
    gap: s.xl,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: s.sm },
  brand: { ...type.heading, color: c.textPrimary, fontWeight: '700' },
  navCaption: { ...type.caption, color: c.textSecondary, marginTop: s.xl },
  navList: { gap: s.xs },
  navItem: {
    justifyContent: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: s.md,
    gap: s.md,
    minHeight: layout.touch,
  },
  navSelected: { backgroundColor: c.selected },
  navLabel: { ...type.caption, color: c.textSecondary, fontWeight: '600' },
  sidebarFooter: { marginTop: 'auto', gap: s.xs },
  account: { ...type.label, color: c.textPrimary },
  muted: { ...type.caption, color: c.textSecondary },
  main: { flex: 1, minWidth: 0 },
  workspaceHeader: {
    paddingHorizontal: s.lg,
    paddingVertical: s.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: s.md,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  headerTitle: { flex: 1, minWidth: 0, gap: s.xs },
  station: { ...type.label, color: c.textSecondary },
  address: { ...type.caption, color: c.textSecondary },
  iconButton: {
    width: layout.touch,
    minHeight: layout.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s.sm,
    minHeight: layout.touch,
    paddingHorizontal: s.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  searchLabel: { ...type.caption, color: c.textSecondary },
  authHeader: {
    padding: s.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: s.sm,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: s.sm,
  },
  content: { flex: 1, minHeight: 0 },
  hidden: { display: 'none' },
  radioContent: { flex: 1, minHeight: 180 },
  bottomNav: {
    flexDirection: 'row',
    paddingTop: s.sm,
    paddingHorizontal: s.xs,
    gap: s.xs,
    backgroundColor: c.surface,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  bottomItem: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.xs,
    paddingVertical: s.sm,
    borderRadius: radius.sm,
  },
  morePage: { padding: s.xl, gap: s.lg },
}));
