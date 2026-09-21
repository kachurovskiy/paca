import { requireValue } from './validation';

// Shares have nine decimal places; USD prices/fees have twelve. Products fit
// exactly in this 24-place representation. Persist strings, never bigint/float.
const scale = 10n ** 24n;
export function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return (BigInt(whole) * scale + BigInt(fraction.padEnd(24, '0'))) * (negative ? -1n : 1n);
}
export function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : '', absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale).toString().padStart(24, '0').replace(/0+$/, '');
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}
export function validateDecimal(value: unknown, places: 9 | 12, allowZero = true, signed = false): asserts value is string {
  requireValue(typeof value === 'string' && /^-?(0|[1-9]\d{0,15})(\.\d*[1-9])?$/.test(value)
    && (value.split('.')[1]?.length ?? 0) <= places && value !== '-0', 'decimal', 'unsupported_decimal');
  const parsed = units(value);
  requireValue((signed || parsed >= 0n) && (allowZero || parsed !== 0n), 'decimal', 'invalid_decimal');
}
export function product(quantity: bigint, price: bigint): bigint {
  requireValue(quantity * price % scale === 0n, 'decimal', 'inexact_product');
  return quantity * price / scale;
}
export const cashTolerance = units('0.000001');
export const withinCashTolerance = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= cashTolerance;

/** Use only at the existing normalized-number boundary; unsupported facts reject. */
export function numberDecimal(value: number, places: 9 | 12, allowZero = true, signed = false): string {
  requireValue(Number.isFinite(value), 'decimal', 'non_finite');
  const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = whole + fraction, point = whole.length + Number(exponent);
  const expanded = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? digits + '0'.repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const result = (negative ? '-' : '') + expanded;
  validateDecimal(result, places, allowZero, signed);
  return result;
}
