import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useTheme } from './theme';
import { layout, radius as r, space as s, type } from './tokens';

/** Shared feature recipes. Layout variants express content hierarchy, never business rules. */
export function useFeatureStyles(
  kind:
    | 'radios'
    | 'history'
    | 'incidents'
    | 'aprs'
    | 'processing'
    | 'notifications'
    | 'admin'
    | 'auth'
    | 'servers',
) {
  const { colors: c } = useTheme();
  return useMemo(() => {
    const page = {
      width: '100%' as const,
      maxWidth: layout.content,
      alignSelf: 'center' as const,
      padding: s.lg,
      gap: s.lg,
      paddingBottom: s.xxxl,
    };
    const text = { ...type.body, color: c.textPrimary };
    const muted = { ...type.body, color: c.textSecondary };
    const input = {
      ...type.body,
      color: c.textPrimary,
      minHeight: layout.touch,
      backgroundColor: c.surface,
      borderColor: c.inputBorder,
      borderWidth: 1,
      borderRadius: r.md,
      padding: s.md,
      minWidth: 0,
    };
    const button = {
      minHeight: layout.touch,
      justifyContent: 'center' as const,
      paddingHorizontal: s.lg,
      paddingVertical: s.md,
      borderRadius: r.md,
      backgroundColor: c.surfaceElevated,
      alignSelf: 'flex-start' as const,
      maxWidth: '100%' as const,
    };
    const card = {
      backgroundColor: c.surface,
      borderRadius: r.md,
      padding: s.lg,
      gap: s.md,
    };
    const row = {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      flexWrap: 'wrap' as const,
      gap: s.md,
    };
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: c.background },
      page:
        kind === 'admin' || kind === 'incidents' || kind === 'auth'
          ? { flex: 1, backgroundColor: c.background }
          : page,
      content: {
        ...page,
        maxWidth: kind === 'auth' ? layout.form : layout.content,
      },
      title: { ...type.title, color: c.textPrimary },
      heading: { ...type.heading, color: c.textPrimary },
      cardTitle: { ...type.heading, color: c.textPrimary },
      label: { ...type.label, color: c.textPrimary, flexShrink: 1 },
      text,
      body: text,
      muted,
      small: { ...type.caption, color: c.textSecondary },
      error: { ...type.body, color: c.error },
      success: { ...type.body, color: c.success },
      warning: { ...type.body, color: c.warning },
      status: { ...type.body, color: c.warning },
      uncertain: { ...type.body, color: c.warning },
      row:
        kind === 'notifications'
          ? { ...row, justifyContent: 'space-between' as const }
          : row,
      card:
        kind === 'history'
          ? {
              paddingVertical: s.xl,
              gap: s.md,
              borderBottomWidth: 1,
              borderColor: c.border,
            }
          : card,
      cards: { gap: s.sm },
      panel: { ...card, gap: s.lg },
      selected: {
        borderLeftColor: c.primary,
        borderLeftWidth: 3,
        backgroundColor: c.selected,
      },
      frequency: { ...type.frequency, color: c.primary },
      memory: {
        paddingVertical: s.lg,
        borderTopWidth: 1,
        borderColor: c.border,
        gap: s.sm,
      },
      input,
      multiline: { minHeight: 96, textAlignVertical: 'top' as const },
      button,
      buttonText: { ...type.label, color: c.primary },
      active: { backgroundColor: c.selected, borderColor: c.primary },
      disabled: { opacity: 0.45 },
      secondary: { ...button, backgroundColor: c.surfaceElevated },
      secondaryText: { ...type.label, color: c.primary },
      choice: button,
      chosen: { backgroundColor: c.selected, borderColor: c.primary },
      filters: kind === 'aprs' ? row : { gap: s.sm },
      options: row,
      header: { ...row, justifyContent: 'space-between' as const },
      grid: { gap: s.sm },
      packet: {
        paddingVertical: s.lg,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        gap: s.xs,
      },
      link: { ...type.label, color: c.primary, paddingVertical: s.md },
      grow: { flex: 1, minWidth: 0 },
      section: { gap: s.md },
      evidence: {
        borderLeftWidth: 2,
        borderLeftColor: c.primary,
        paddingLeft: s.lg,
        gap: s.sm,
      },
      item: {
        borderTopWidth: 1,
        borderColor: c.border,
        paddingTop: s.lg,
        gap: s.sm,
      },
      empty: { paddingVertical: s.xl, gap: s.sm },
      emptyTitle: { ...type.heading, color: c.textPrimary },
      eyebrow: {
        ...type.caption,
        fontWeight: '600' as const,
        color: c.textSecondary,
      },
      badge: { ...type.caption, color: c.primary },
      transcript: {
        paddingLeft: s.lg,
        borderLeftWidth: 2,
        borderColor: c.border,
        gap: s.md,
      },
      brand: { ...type.heading, color: c.textPrimary },
      dot: { color: c.primary },
      intro: { gap: s.md, paddingVertical: s.lg },
      description: muted,
      connected: { borderLeftWidth: 3, borderColor: c.primary },
      fingerprint: { ...type.caption, color: c.textSecondary },
      hint: { ...type.caption, color: c.textSecondary },
      recent: {
        ...row,
        paddingVertical: s.lg,
        borderBottomWidth: 1,
        borderColor: c.border,
      },
      recentMain: { flex: 1, minWidth: 0, gap: s.xs },
      serverName: { ...type.label, color: c.textPrimary },
      remove: { padding: s.md },
      removeText: { ...type.label, color: c.textSecondary },
      footer: { ...type.caption, color: c.textSecondary, marginTop: s.xl },
    });
  }, [c, kind]);
}
