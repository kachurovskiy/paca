import type { TradeActivity } from '../core/types';

export interface HistoryTrade {
  id: string;
  symbol: string;
  /** Earliest contributing buy order; simultaneous orders may share a trade. */
  buyOrderId: string;
  openedAt: string;
  lastActivityAt: string;
  lastSoldAt: string | null;
  closedAt: string | null;
  qty: number;
  openQty: number;
  soldQty: number;
  entryPrice: number;
  exitPrice: number | null;
  openCostBasis: number;
  realizedCostBasis: number;
  realizedPl: number;
}

/** The matched long portion of one sell fill, grouped by its assembled trade. */
export interface HistoryRealizedExit {
  id: string;
  tradeId: string;
  symbol: string;
  soldAt: string;
  qty: number;
  costBasis: number;
  realizedPl: number;
}

export interface ReconstructedTradeHistory {
  trades: HistoryTrade[];
  realizedExits: HistoryRealizedExit[];
  unmatchedSellQty: number;
  unmatchedSellCount: number;
  excludedOptionCount: number;
}

interface TradeTotals {
  trade: HistoryTrade;
  entryValue: number;
  exitValue: number;
}

interface BuyLot {
  totals: TradeTotals;
  qty: number;
  price: number;
}

interface Inventory {
  lots: BuyLot[];
  firstLot: number;
  shortQty: number;
}

// Alpaca supports nine decimal places in fractional quantities. Round every
// quantity update so normal floating-point subtraction cannot leave dust open.
function quantity(value: number): number {
  return Number(value.toFixed(9));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function subMillisecond(time: string): string {
  return (time.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i)?.[1] ?? '').slice(3).replace(/0+$/, '');
}

function compareTimes(a: string, b: string): number {
  const milliseconds = Date.parse(a) - Date.parse(b);
  if (milliseconds) return milliseconds;
  // Date.parse truncates sub-millisecond precision; broker fills can include it.
  return compareText(subMillisecond(a), subMillisecond(b));
}

// Alpaca option symbols use an OCC expiry/type/strike suffix. This also covers
// adjusted roots (such as AAPL1) and space-padded OCC symbols. Fill history has
// no contract multiplier or option lifecycle events, so do not price contracts
// as shares or guess their multiplier.
const optionSymbol = /^[A-Z][A-Z0-9.]* *\d{6}[CP]\d{8}$/i;

function buyOrderKey(fill: TradeActivity): string {
  return JSON.stringify([fill.symbol, fill.orderId]);
}

/** Connect partial orders and simultaneous buys before assigning any exits. */
function groupBuyOrders(fills: readonly TradeActivity[]): Map<string, TradeActivity> {
  const balances = new Map<string, number>();
  const firstBuys = new Map<string, TradeActivity>();
  const parents = new Map<string, string>();
  const sequence = new Map<string, number>();
  const atTime = new Map<string, string>();
  const root = (id: string): string => {
    let parent = parents.get(id)!;
    while (parent !== parents.get(parent)) parent = parents.get(parent)!;
    while (id !== parent) {
      const next = parents.get(id)!;
      parents.set(id, parent);
      id = next;
    }
    return parent;
  };

  for (const fill of fills) {
    // The signed balance identifies short covers without changing FIFO prices.
    const qty = quantity(fill.qty);
    const balance = quantity((balances.get(fill.symbol) ?? 0) + (fill.side === 'buy' ? qty : -qty));
    balances.set(fill.symbol, balance);
    // A buy used entirely to cover an unmatched sell contributes no long lot.
    if (fill.side !== 'buy' || balance <= 0) continue;
    const id = buyOrderKey(fill);
    if (!parents.has(id)) {
      parents.set(id, id);
      firstBuys.set(id, fill);
      sequence.set(id, sequence.size);
    }
    const instant = JSON.stringify([fill.symbol, Date.parse(fill.transactionTime), subMillisecond(fill.transactionTime)]);
    const previous = atTime.get(instant);
    if (previous) {
      const a = root(previous);
      const b = root(id);
      // Keep the earliest contributing buy as the stable trade identity, even
      // when a later partial fill connects two previously separate groups.
      if (sequence.get(a)! < sequence.get(b)!) parents.set(b, a);
      else parents.set(a, b);
    } else {
      atTime.set(instant, id);
    }
  }

  return new Map([...parents.keys()].map(id => [id, firstBuys.get(root(id))!]));
}

/** Reconstruct supported long trades from executed fills, using FIFO before fees. */
export function reconstructTrades(activities: readonly TradeActivity[]): ReconstructedTradeHistory {
  const seen = new Set<string>();
  const trades = new Map<string, TradeTotals>();
  const realizedExits: HistoryRealizedExit[] = [];
  const inventories = new Map<string, Inventory>();
  let unmatchedSellQty = 0;
  let unmatchedSellCount = 0;
  let excludedOptionCount = 0;
  const fills = [...activities].sort((a, b) => compareTimes(a.transactionTime, b.transactionTime) || compareText(a.id, b.id)).filter(fill => {
    if (seen.has(fill.id)) return false;
    seen.add(fill.id);
    if (!(quantity(fill.qty) > 0)) return false;
    if (optionSymbol.test(fill.symbol.trim())) {
      excludedOptionCount++;
      return false;
    }
    return true;
  });
  const buyGroups = groupBuyOrders(fills);

  for (const fill of fills) {
    let remaining = quantity(fill.qty);
    let inventory = inventories.get(fill.symbol);
    if (!inventory) {
      inventory = { lots: [], firstLot: 0, shortQty: 0 };
      inventories.set(fill.symbol, inventory);
    }

    if (fill.side === 'buy') {
      // An earlier unmatched sell can be a short sale (or missing historical
      // inventory). Exclude its subsequent cover rather than inventing a long
      // position or assigning a fabricated entry price to that earlier sell.
      const covered = Math.min(remaining, inventory.shortQty);
      remaining = quantity(remaining - covered);
      inventory.shortQty = quantity(inventory.shortQty - covered);
      if (!remaining) continue;

      const firstBuy = buyGroups.get(buyOrderKey(fill))!;
      const id = buyOrderKey(firstBuy);
      let totals = trades.get(id);
      if (!totals) {
        totals = {
          trade: {
            id, symbol: fill.symbol, buyOrderId: firstBuy.orderId,
            openedAt: fill.transactionTime, lastActivityAt: fill.transactionTime,
            lastSoldAt: null, closedAt: null, qty: 0, openQty: 0, soldQty: 0,
            entryPrice: 0, exitPrice: null, openCostBasis: 0,
            realizedCostBasis: 0, realizedPl: 0,
          },
          entryValue: 0,
          exitValue: 0,
        };
        trades.set(id, totals);
      }
      const trade = totals.trade;
      trade.qty = quantity(trade.qty + remaining);
      trade.openQty = quantity(trade.openQty + remaining);
      totals.entryValue += remaining * fill.price;
      trade.entryPrice = totals.entryValue / trade.qty;
      trade.openCostBasis = totals.entryValue - trade.realizedCostBasis;
      trade.lastActivityAt = fill.transactionTime;
      trade.closedAt = null;
      // Keep individual fill lots: a later fill of this order must not alter
      // the basis of shares already sold, or jump ahead of another buy order.
      inventory.lots.push({ totals, qty: remaining, price: fill.price });
      continue;
    }

    const fillExits = new Map<string, HistoryRealizedExit>();
    while (remaining > 0 && inventory.firstLot < inventory.lots.length) {
      const lot = inventory.lots[inventory.firstLot];
      const sold = Math.min(remaining, lot.qty);
      const trade = lot.totals.trade;
      let exit = fillExits.get(trade.id);
      if (!exit) {
        exit = { id: fill.id, tradeId: trade.id, symbol: fill.symbol, soldAt: fill.transactionTime, qty: 0, costBasis: 0, realizedPl: 0 };
        fillExits.set(trade.id, exit);
        realizedExits.push(exit);
      }
      exit.qty = quantity(exit.qty + sold);
      exit.costBasis += sold * lot.price;
      exit.realizedPl += sold * (fill.price - lot.price);
      remaining = quantity(remaining - sold);
      lot.qty = quantity(lot.qty - sold);
      trade.openQty = quantity(trade.openQty - sold);
      trade.soldQty = quantity(trade.soldQty + sold);
      trade.realizedCostBasis += sold * lot.price;
      trade.realizedPl += sold * (fill.price - lot.price);
      lot.totals.exitValue += sold * fill.price;
      trade.exitPrice = lot.totals.exitValue / trade.soldQty;
      trade.openCostBasis = trade.openQty ? lot.totals.entryValue - trade.realizedCostBasis : 0;
      trade.lastActivityAt = fill.transactionTime;
      trade.lastSoldAt = fill.transactionTime;
      trade.closedAt = trade.openQty ? null : fill.transactionTime;
      if (!lot.qty) inventory.firstLot++;
    }
    if (inventory.firstLot === inventory.lots.length) {
      inventory.lots = [];
      inventory.firstLot = 0;
    }
    if (remaining > 0) {
      unmatchedSellQty = quantity(unmatchedSellQty + remaining);
      unmatchedSellCount++;
      inventory.shortQty = quantity(inventory.shortQty + remaining);
    }
  }

  return {
    trades: [...trades.values()].map(({ trade }) => trade)
      .sort((a, b) => compareTimes(b.lastActivityAt, a.lastActivityAt) || compareText(a.id, b.id)),
    realizedExits,
    unmatchedSellQty,
    unmatchedSellCount,
    excludedOptionCount,
  };
}
