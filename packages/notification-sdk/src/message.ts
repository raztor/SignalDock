function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, field]) => `${JSON.stringify(name)}:${canonical(field)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function relaySigningMessage(domain: string, payload: unknown): string {
  return `SignalDock relay v1:${domain}\n${canonical(payload)}`;
}
