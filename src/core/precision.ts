import { finite, integer, requireValue } from './validation';

const QUANTITY_SCALE = 1_000_000_000n;

/** Exact rational value of the number's shortest decimal representation, including exponents. */
function decimal(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const digits = BigInt(whole + fraction);
  return scale >= 0 ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}

/** Broker facts are rejected if unsupported, never rounded into zero or invented inventory. */
export function validateQuantity(value: unknown, allowZero = false): asserts value is number {
  finite(value, 'quantity');
  requireValue(allowZero ? value >= 0 : value > 0, 'quantity', 'invalid_quantity');
  const { numerator, denominator } = decimal(value);
  requireValue(numerator * QUANTITY_SCALE % denominator === 0n
    && numerator * QUANTITY_SCALE / denominator <= BigInt(Number.MAX_SAFE_INTEGER), 'quantity', 'unsupported_quantity_precision');
}

/** Floor a new order to 1e-9 shares using exact decimal arithmetic, never above budget. */
export function quantityWithinBudget(capitalCents: number, priceUsd: number): number {
  integer(capitalCents, 'capitalCents');
  finite(priceUsd, 'priceUsd');
  requireValue(priceUsd > 0, 'priceUsd', 'invalid_price');
  const price = decimal(priceUsd);
  let units = BigInt(capitalCents) * price.denominator * QUANTITY_SCALE / (100n * price.numerator);
  requireValue(units <= BigInt(Number.MAX_SAFE_INTEGER), 'quantity', 'unsupported_quantity_precision');
  // Conversion to a JS number can round up at large magnitudes. Conservatively step
  // down until its serialized decimal still fits the exact floored quantity.
  while (units > 0n) {
    const quantity = Number(units) / Number(QUANTITY_SCALE);
    const represented = decimal(quantity);
    if (represented.numerator * QUANTITY_SCALE <= units * represented.denominator
      && represented.numerator * QUANTITY_SCALE % represented.denominator === 0n) return quantity;
    units--;
  }
  return 0;
}
