import { randomUUID } from 'expo-crypto';

/** Decimal MHz is converted without rounding a floating-point approximation. */
export function parseMegahertz(input: string): number {
  const value = input.trim();
  if (!/^\d{1,6}(?:\.\d{1,6})?$/.test(value))
    throw new Error('Enter MHz with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error('Frequency must be a positive integer number of Hz.');
  return result;
}
export function formatMegahertz(hz: number): string {
  return `${Math.floor(hz / 1000000)}.${String(hz % 1000000).padStart(6, '0')}`;
}
export function operationId(): string {
  return randomUUID();
}
