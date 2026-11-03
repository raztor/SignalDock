import { Platform, Share } from 'react-native';

export type ShareLinkResult = 'copied' | 'shared' | 'dismissed' | 'unavailable';

/** "Copy link" on web; the system share sheet (which offers Copy) on native. */
export const shareLinkLabel =
  Platform.OS === 'web' ? 'Copy link' : 'Share link';

/**
 * Hands the station address to the person: the browser clipboard on web, the
 * native share sheet elsewhere. Resolves 'unavailable' when neither works so
 * the caller can point to the selectable address instead.
 */
export async function shareStationLink(
  url: string,
  title: string,
): Promise<ShareLinkResult> {
  if (Platform.OS === 'web') {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) return 'unavailable';
    try {
      await clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }
  try {
    const result = await Share.share(
      Platform.OS === 'ios' ? { url, title } : { message: url, title },
      { dialogTitle: `Share ${title}` },
    );
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch {
    return 'unavailable';
  }
}
