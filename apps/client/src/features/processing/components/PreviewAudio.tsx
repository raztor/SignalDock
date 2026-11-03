import { useScreenActive } from '@signaldock/ui';
import { createElement, useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Browser playback of an authenticated preview blob (object URL). Pauses when
 * the screen is hidden. `onPlay` fires when the user actually starts playback.
 */
export function PreviewAudio({
  url,
  label,
  onPlay,
}: {
  url: string;
  label: string;
  onPlay?(): void;
}) {
  const active = useScreenActive();
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  if (Platform.OS !== 'web') return null;
  return createElement('audio', {
    controls: true,
    ref: audio,
    src: url,
    'aria-label': label,
    onPlay,
    style: { width: '100%' },
  });
}
