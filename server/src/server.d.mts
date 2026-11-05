export function startBank(
  config: Record<string, unknown>,
  options?: { now?: () => number },
): Promise<{ close(): Promise<void> }>
