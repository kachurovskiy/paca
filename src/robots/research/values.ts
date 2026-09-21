import type { RobotProposal, TemplateParameterContract, UnavailableForecast } from '../domain';
import { requireValue } from '../../core/validation';
import { validateProposal } from '../validation';

/**
 * Canonical JSON v1: plain JSON only, UTF-16 sorted object keys, array order retained,
 * ECMAScript JSON number/string encoding (-0 is 0). Undefined, non-finite numbers,
 * sparse arrays, cycles, custom prototypes, and symbol keys are rejected.
 */
export function canonicalSerialize(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown, depth: number): string => {
    requireValue(depth <= 64, 'serialization', 'maximum_depth');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      requireValue(Number.isFinite(item), 'serialization', 'non_finite_number');
      return JSON.stringify(item);
    }
    requireValue(typeof item === 'object' && item !== null, 'serialization', 'unsupported_json_value');
    requireValue(!ancestors.has(item), 'serialization', 'cyclic_value');
    requireValue(Object.values(Object.getOwnPropertyDescriptors(item)).every(descriptor => Object.hasOwn(descriptor, 'value')),
      'serialization', 'accessor_fields_not_supported');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      requireValue(Object.keys(item).length === item.length && Reflect.ownKeys(item).length === item.length + 1,
        'serialization', 'unsupported_array_fields');
      const values: string[] = [];
      for (let index = 0; index < item.length; index++) {
        requireValue(Object.hasOwn(item, index), 'serialization', 'sparse_array');
        values.push(encode(item[index], depth + 1));
      }
      result = `[${values.join(',')}]`;
    } else {
      requireValue(Object.getPrototypeOf(item) === Object.prototype, 'serialization', 'expected_plain_object');
      const keys = Object.keys(item).sort();
      requireValue(Reflect.ownKeys(item).length === keys.length, 'serialization', 'unsupported_object_fields');
      result = `{${keys.map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value, 0);
}

export function unavailableForecast(reason: string): UnavailableForecast {
  requireValue(reason.trim().length > 0, 'forecast.reason', 'expected_nonempty_text');
  return Object.freeze({ status: 'unavailable', reason, meanPnlCents: null, medianPnlCents: null,
    quantiles: null, probabilityOfProfit: null });
}

/** A revision is an immutable value, detached from the researcher's mutable inputs. */
export function snapshotProposal(input: unknown, templates: readonly TemplateParameterContract[]): RobotProposal {
  const proposal = structuredClone(input);
  validateProposal(proposal, templates);
  return proposal;
}

