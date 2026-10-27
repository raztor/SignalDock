import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { ClientSession } from '@signaldock/contracts';
import { Action, theme } from '@signaldock/ui';
import ServerConnectionScreen from '../features/servers/screens/ServerConnectionScreen';
import {
  SessionController,
  createPlatformAuthOptions,
  useAuthSession,
  BootstrapScreen,
  LoginScreen,
  SessionListScreen,
} from '../features/auth';
import { UserAdminScreen } from '../features/admin/UserAdminScreen';
import { RadioDashboardScreen } from '../features/radios/RadioDashboardScreen';
import { MediaScreen, stopActiveMedia } from '../features/media';
import { HistoryScreen } from '../features/history/HistoryScreen';

export default function App() {
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
  useEffect(() => () => controller.dispose(), [controller]);
  if (servers)
    return (
      <ServerConnectionScreen
        onServerSelected={async (baseUrl, info) => {
          await controller.selectServer(baseUrl, info);
          await controller.restore();
          showServers(false);
        }}
        onServerRemoved={(server) => controller.forgetServer(server)}
      />
    );
  const back = () => {
    void stopActiveMedia('Selecting a server.').then(() => showServers(true));
  };
  if (!auth.session)
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>SignalDock</Text>
          <Action label="Servers" onPress={back} />
        </View>
        {auth.status === 'signing_in' && (
          <ActivityIndicator color={theme.accent} />
        )}
        {auth.bootstrapRequired ? (
          <BootstrapScreen controller={controller} />
        ) : (
          <LoginScreen controller={controller} />
        )}
      </View>
    );
  const key = `${auth.session.baseUrl}:${auth.session.instanceId}:${auth.session.user.id}`;
  return (
    <Workspace
      key={key}
      session={auth.session}
      mediaAvailable={auth.server?.info.features.liveAudio ?? false}
      displayName={auth.server?.info.displayName ?? 'Station'}
      onServers={back}
      onSignOut={() => {
        void controller.signOut();
      }}
    />
  );
}

type Section = 'Radios' | 'History' | 'Sessions' | 'Administration';
function Workspace({
  session,
  displayName,
  mediaAvailable,
  onServers,
  onSignOut,
}: {
  session: ClientSession;
  displayName: string;
  mediaAvailable: boolean;
  onServers: () => void;
  onSignOut: () => void;
}) {
  const [section, setSection] = useState<Section>('Radios');
  const [radioId, setRadioId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { width } = useWindowDimensions();
  const navigate = async (next: Section) => {
    if (next === section || busy) return;
    setBusy(true);
    try {
      await stopActiveMedia('Navigation changed.');
      setSection(next);
    } finally {
      setBusy(false);
    }
  };
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
    'Sessions',
    ...(session.user.role === 'administrator'
      ? ['Administration' as const]
      : []),
  ];
  return (
    <View style={styles.page}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
          <Text style={styles.brand}>SignalDock</Text>
          <Text style={styles.muted}>
            {displayName} · {session.user.username} · {session.user.role}
          </Text>
          <Text numberOfLines={1} style={styles.address}>
            {session.baseUrl}
          </Text>
        </View>
        <Action label="Servers" onPress={onServers} />
        <Action label="Sign out" onPress={onSignOut} />
      </View>
      <View style={styles.navigation}>
        {sections.map((name) => (
          <Action
            key={name}
            label={name}
            active={name === section}
            disabled={busy}
            onPress={() => {
              void navigate(name);
            }}
          />
        ))}
      </View>
      <View style={styles.content}>
        {section === 'Radios' && (
          <View
            style={{ flex: 1, flexDirection: width >= 1100 ? 'row' : 'column' }}
          >
            <View style={{ flex: 1, minHeight: 300 }}>
              <RadioDashboardScreen {...props} />
            </View>
            <ScrollView
              style={{
                backgroundColor: '#f1f5f9',
                ...(width >= 1100
                  ? { width: 340, flexGrow: 0 }
                  : { maxHeight: 330 }),
              }}
            >
              <MediaScreen {...props} mediaAvailable={mediaAvailable} />
            </ScrollView>
          </View>
        )}
        {section === 'History' && <HistoryScreen {...props} />}
        {section === 'Sessions' && <SessionListScreen {...props} />}
        {section === 'Administration' && <UserAdminScreen session={session} />}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.background },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    padding: 20,
    borderBottomColor: theme.border,
    borderBottomWidth: 1,
  },
  brand: {
    color: theme.text,
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.7,
  },
  muted: { color: theme.muted, fontSize: 13 },
  address: { color: theme.muted, fontSize: 11, maxWidth: 500 },
  navigation: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 8,
  },
  content: {
    flex: 1,
    backgroundColor: '#f8fafc',
    margin: 12,
    marginTop: 0,
    borderRadius: 14,
    overflow: 'hidden',
  },
});
