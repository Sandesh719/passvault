export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Contract violation: ${message}`);
  }
}

export function assertNever(value: never, message = "unreachable state"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
