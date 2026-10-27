import type { PositionRecord } from '@signaldock/contracts';

export interface AprsMapProps {
  positions: readonly PositionRecord[];
  styleUrl?: string;
  referenceTime?: number;
  onPacketSelect?: (packetId: string) => void;
}
