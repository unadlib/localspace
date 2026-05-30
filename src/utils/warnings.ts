const emittedWarnings = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (emittedWarnings.has(key)) {
    return;
  }

  emittedWarnings.add(key);
  console.warn(message);
}
