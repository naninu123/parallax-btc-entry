// Dip mean reversion, long only, single symbol (CBBTC).
//
//   - Keeps each symbol's closes. On every bar it computes the SMA of the last SPAN closes
//     (the current one included), so the only prices it reads are bars already delivered.
//   - Entry, on a bar's close (filled at the next open): the close is ENTRY_BPS under that
//     SMA. It buys the whole cash (one slot, caps.max_open_positions is 1), capped by
//     caps.max_weight_bps of equity and by fees.min_notional_quote_units. MAX_SLIPPAGE_BPS
//     refuses a fill that would slip more than 1% past the close it was decided on.
//   - Exit, the whole position at the next open: the position worth TAKE_BPS over its cost
//     or STOP_BPS under it, both read on the close. Each is read again on every bar, so a
//     sell the market refuses (no bar or a price past the slippage cap) is sent again on the
//     symbol's next bar while its reason still holds.
//   - Order cap and min notional come from state.hello.caps / state.hello.fees.
//
// Causal: every number comes from bars already delivered. float64 + - * / only, so the same
// bars give the same orders run after run.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The SMA the dip is measured against, in bars. */
const SPAN = 150;
/** The dip that arms an entry, in bps below the SMA. */
const ENTRY_BPS = 225;
/** Take profit / stop loss, in bps of the position's cost. */
const TAKE_BPS = 350;
const STOP_BPS = 250;
/** Refuse a fill more than 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

const closes = new Map<string, number[]>();

function push(bar: Bar): void {
  let arr = closes.get(bar.symbol);
  if (arr === undefined) closes.set(bar.symbol, (arr = []));
  arr.push(Number(bar.c));
  const keep = SPAN;
  if (arr.length > keep) arr.splice(0, arr.length - keep);
}

/** Mean of the last `n` entries; null until there are `n`. */
function sma(arr: number[], n: number): number | null {
  if (arr.length < n || n <= 0) return null;
  let sum = 0;
  for (let i = arr.length - n; i < arr.length; i++) sum += arr[i];
  return sum / n;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) push(bar);
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];
    const cap = caps.max_orders_per_bar;
    let cash = state.cash;

    for (const { symbol } of state.hello.symbols) {
      if (orders.length >= cap) break;
      const arr = closes.get(symbol);
      if (arr === undefined) continue;

      const held = state.positions.get(symbol);

      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const takeHit = value * 10000n >= held.cost * BigInt(10000 + TAKE_BPS);
        const stopHit = value * 10000n <= held.cost * BigInt(10000 - STOP_BPS);
        if (takeHit || stopHit) orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        continue;
      }

      if (state.positions.size >= caps.max_open_positions) continue;

      const mean = sma(arr, SPAN);
      if (mean === null) continue;
      const close = arr[arr.length - 1];
      // Both sides stay under 1e13 here (a CBBTC close is ~6.7e8 at price_scale 5), inside
      // the exact-integer range of a float64, so the comparison never rounds at the boundary.
      if (close * 10000 > mean * (10000 - ENTRY_BPS)) continue;

      let slice = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
    }

    return orders;
  },
});
