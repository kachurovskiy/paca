

export class DomainValidationError extends Error {
  constructor(readonly path: string, readonly code: string) {
    super(`${path}: ${code}`);
    this.name = 'DomainValidationError';
  }
}

export function requireValue(condition: unknown, path: string, code: string): asserts condition {
  if (!condition) throw new DomainValidationError(path, code);
}

export function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, path, 'expected_plain_object');
  const result = value as Record<string, unknown>;
  requireValue(Object.keys(result).length === keys.length
    && keys.every(key => Object.hasOwn(result, key))
    && Reflect.ownKeys(result).length === keys.length, path, 'unexpected_or_missing_fields');
  requireValue(keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(result, key)!, 'value')),
    path, 'accessor_fields_not_supported');
  return result;
}

export function identifier(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value), path, 'invalid_identity');
}

export function finite(value: unknown, path: string): asserts value is number {
  requireValue(typeof value === 'number' && Number.isFinite(value), path, 'expected_finite_number');
}

export function integer(value: unknown, path: string, minimum = 1): asserts value is number {
  finite(value, path);
  requireValue(Number.isSafeInteger(value) && value >= minimum, path, 'invalid_integer');
}

export function instant(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), path, 'invalid_utc_instant');
  const date = new Date(value);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString() === value, path, 'invalid_utc_instant');
}

export function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): asserts value is T {
  requireValue(typeof value === 'string' && choices.includes(value as T), path, 'unsupported_value');
}
