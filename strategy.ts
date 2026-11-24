// Fresh strategy, v6 — "early rider" for the Pump.fun Paper Sprint replay.
//
// What the graded variants taught me, in order:
// - v1 chased coins already up 8%+: dev -7.5 SOL. Momentum does not continue.
// - v3 waited for 5 SOL of reserve, scalped tight: dev -1.09 SOL.
// - v4 bought the first trade with a drift filter: dev -0.82 SOL — the best
//   per-trip loss so far. Tight exits lose to the batch structure: brief +15%
//   spikes reverse inside one batch and a batch-end bot never sees them,
//   while falls persist and the stop always fires.
// - v5 kept the 5-SOL entry but held wide (TP +100% / SL -30%): dev -0.63 SOL,
//   the best absolute score, but only 102 trips — long holds starve the five
//   slots, so the few winners cannot pay for the losers.
// - This version takes the best entry (first trade, drift-filtered) and the
//   best exits (wide, ride the big move): buy the birth, hold for the double,
//   cut only on a real -30% break. A coin that doubles from its first trade
//   is exactly the one the batch-end bot can still catch, because a +100%
//   run lasts many batches.
//
// Rules of this version, all of them mechanical and all of them functions of
// the replay alone (no clock, no randomness, deterministic across runs):
// - Enter on a mint's first buy trade (within its first 3 trades), spending
//   up to 0.05 SOL but never more than the reserve cap allows and never less
//   than 0.01 SOL, and only when the batch-end price has not already run
//   more than 5% past the signal trade's own price.
// - Leave on take-profit +100%, stop-loss -30%, a give-back from the peak
//   once +30% up, or a stale hold of 20000 batches. No discretion.
// - At most five open at once, so breadth does the work and no single coin
//   can hurt the account.

import type { Batch, BotState, OrderInput, TradeEventRecord } from "./vendor/makefun-bot.ts";

/** Tunable knobs, kept in one place so a variant is a one-line change. */
export interface StrategyConfig {
  /** SOL (lamports) spent on each newborn coin, when the reserve cap allows. */
  buySizeLamports: bigint;
  /** Never spend less than this on an entry: a smaller round trip would not
      count toward the 20-coin guardrail bar. */
  minBuyLamports: bigint;
  /** Enter only if this is among the mint's first N trades (1-based). */
  maxEntryTradeIndex: number;
  /** Skip the entry when the batch-end price has already run this far past
      the signal trade's own price (bps): a spike inside the decision batch
      means the burst is spent before the buy can even fill. */
  maxDriftBps: number;
  /** Sell everything once the position is up this much from entry (bps). */
  takeProfitBps: number;
  /** Sell everything once the position is down this much from entry (bps). */
  stopLossBps: number;
  /** After the peak, sell once price has given back this much (bps of peak). */
  trailGivebackBps: number;
  /** Peak must be at least this far above entry before trailing arms (bps). */
  trailArmBps: number;
  /** Sell a position that has lived this many batches without hitting an exit.
      Batches track slots (one batch per slot with events, ~4.7 slots a second
      on this data), so this is a wall-clock hold cap — the trade-count version
      never fired, because most coins print fewer than 30 trades in total. */
  maxHoldBatches: number;
  /** Buys tolerate this much slippage; sells a little more so exits actually fill. */
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  buySizeLamports: 50_000_000n, // 0.05 SOL when the cap allows
  minBuyLamports: 10_000_000n, // 0.01 SOL floor: the guardrail minimum
  maxEntryTradeIndex: 3,
  maxDriftBps: 500, // +5% past the signal price, at most
  takeProfitBps: 10000, // +100%
  stopLossBps: 3000, // -30%
  trailGivebackBps: 2000, // -20% from the peak
  trailArmBps: 3000, // arms once +30% up
  maxHoldBatches: 20000, // ~70 minutes of replay time
  buySlippageBps: 500,
  sellSlippageBps: 1000,
};

/** Price of one token in SOL, as a plain number (lamports per token / 1e9). */
export function curvePrice(
  virtualQuoteReserves: bigint,
  virtualTokenReserves: bigint,
): number {
  if (virtualTokenReserves === 0n) return 0;
  return Number(virtualQuoteReserves) / Number(virtualTokenReserves);
}

/** One curve we are watching, with just enough memory to judge it. */
interface WatchedCurve {
  mint: string;
  createdPrice: number;
  lastPrice: number;
  peakPrice: number;
  trades: number;
  /** Real SOL sitting in the curve: what the 1% order cap is measured on. */
  realQuoteReserves: bigint;
  complete: boolean;
}

/** One position we opened, with the facts we need to exit it. */
interface OpenTrade {
  mint: string;
  entryPrice: number;
  peakPrice: number;
  entryBatch: number;
  tokens: bigint;
  costLamports: bigint;
}

export class PaperSprintStrategy {
  private readonly cfg: StrategyConfig;
  private readonly curves = new Map<string, WatchedCurve>();
  private readonly trades = new Map<string, OpenTrade>();
  /** Mints whose first buy we already answered (bought, skipped, or rejected). */
  private readonly decided = new Set<string>();

  constructor(cfg: StrategyConfig = DEFAULT_CONFIG) {
    this.cfg = cfg;
  }

  /** Fold one batch of events into the per-curve picture. */
  observe(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.event === "CreateEvent") {
        const price = curvePrice(
          BigInt(ev.virtual_quote_reserves),
          BigInt(ev.virtual_token_reserves),
        );
        this.curves.set(ev.mint, {
          mint: ev.mint,
          createdPrice: price,
          lastPrice: price,
          peakPrice: price,
          trades: 0,
          realQuoteReserves: 0n,
          complete: false,
        });
      } else if (ev.event === "TradeEvent") {
        const c = this.getOrSeed(ev.mint, ev);
        const price = curvePrice(
          BigInt(ev.virtual_quote_reserves),
          BigInt(ev.virtual_token_reserves),
        );
        c.lastPrice = price;
        if (price > c.peakPrice) c.peakPrice = price;
        c.trades += 1;
        c.realQuoteReserves = BigInt(ev.real_quote_reserves);
      } else if (ev.event === "CompleteEvent") {
        const c = this.curves.get(ev.mint);
        if (c !== undefined) c.complete = true;
      }
    }
  }

  /** A curve we first met through a trade: seed it at its current price. */
  private getOrSeed(mint: string, ev: TradeEventRecord): WatchedCurve {
    let c = this.curves.get(mint);
    if (c === undefined) {
      const price = curvePrice(
        BigInt(ev.virtual_quote_reserves),
        BigInt(ev.virtual_token_reserves),
      );
      c = {
        mint,
        createdPrice: price,
        lastPrice: price,
        peakPrice: price,
        trades: 0,
        realQuoteReserves: BigInt(ev.real_quote_reserves),
        complete: false,
      };
      this.curves.set(mint, c);
    }
    return c;
  }

  /** Refresh our open-trade book from the account the harness reports. */
  syncPositions(state: BotState, batch: Batch): void {
    for (const mint of [...this.trades.keys()]) {
      if (!state.positions.has(mint)) this.trades.delete(mint);
    }
    for (const [mint, holding] of state.positions) {
      const c = this.curves.get(mint);
      const price = c !== undefined ? c.lastPrice : 0;
      const existing = this.trades.get(mint);
      if (existing === undefined) {
        const costPerToken =
          holding.token_amount > 0n
            ? Number(holding.cost_lamports) / Number(holding.token_amount)
            : price;
        this.trades.set(mint, {
          mint,
          entryPrice: costPerToken,
          peakPrice: Math.max(costPerToken, price),
          entryBatch: batch.seq,
          tokens: holding.token_amount,
          costLamports: holding.cost_lamports,
        });
      } else {
        // A just-filled intent: re-anchor the entry on what the fill really
        // cost per token, not on the price we guessed at decision time.
        if (existing.tokens === 0n && holding.token_amount > 0n) {
          const costPerToken =
            Number(holding.cost_lamports) / Number(holding.token_amount);
          existing.entryPrice = costPerToken;
          existing.peakPrice = Math.max(costPerToken, price);
        }
        existing.tokens = holding.token_amount;
        existing.costLamports = holding.cost_lamports;
        if (price > existing.peakPrice) existing.peakPrice = price;
      }
    }
  }

  /** Decide this batch's orders: exits first, then newborn entries. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    // Trade counts per mint as they stood before this batch, so the entry
    // scan below can tell a mint's 1st trade from its 50th even when a whole
    // burst of its trades lands in one batch.
    const tradesBefore = new Map<string, number>();
    for (const [mint, c] of this.curves) tradesBefore.set(mint, c.trades);
    this.observe(batch);
    this.syncPositions(state, batch);
    const orders: OrderInput[] = [];
    const cfg = this.cfg;

    // ---- Exits: every open trade gets one mechanical reason to leave. ----
    for (const trade of [...this.trades.values()]) {
      const c = this.curves.get(trade.mint);
      if (c === undefined || c.complete) continue; // harness closes completes itself
      if (trade.tokens === 0n) continue; // buy still in flight: nothing to sell yet
      const price = c.lastPrice;
      if (price <= 0 || trade.entryPrice <= 0) continue;
      const moveBps = Math.round(((price - trade.entryPrice) / trade.entryPrice) * 10_000);
      const fromPeakBps =
        trade.peakPrice > 0
          ? Math.round(((trade.peakPrice - price) / trade.peakPrice) * 10_000)
          : 0;
      const heldBatches = batch.seq - trade.entryBatch;
      const takeProfit = moveBps >= cfg.takeProfitBps;
      const stopLoss = moveBps <= -cfg.stopLossBps;
      const trailing =
        trade.peakPrice >= trade.entryPrice * (1 + cfg.trailArmBps / 10_000) &&
        fromPeakBps >= cfg.trailGivebackBps;
      const stale = heldBatches >= cfg.maxHoldBatches;
      if (takeProfit || stopLoss || trailing || stale) {
        orders.push({
          side: "sell",
          mint: trade.mint,
          token_amount: trade.tokens,
          max_slippage_bps: cfg.sellSlippageBps,
        });
        this.trades.delete(trade.mint);
      }
    }

    // ---- Entries: a newborn coin's first buy trade, one ticket each. ----
    // The scan replays this batch's trades one by one with a running
    // per-mint counter, so a mint whose first trades share a batch is still
    // judged on its true trade index. A mint skipped for a small cap or a
    // spent spike is NOT written off: it is reconsidered on its next buy
    // while it is still inside its first few trades.
    const freeCash = state.freeCashLamports();
    if (freeCash <= cfg.minBuyLamports) return orders;
    if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;

    const seenThisBatch = new Map<string, number>();
    for (const ev of batch.events) {
      if (ev.event !== "TradeEvent") continue;
      const idx =
        (tradesBefore.get(ev.mint) ?? 0) + (seenThisBatch.get(ev.mint) ?? 0);
      seenThisBatch.set(ev.mint, (seenThisBatch.get(ev.mint) ?? 0) + 1);
      if (!ev.is_buy) continue;
      const c = this.curves.get(ev.mint);
      if (c === undefined || c.complete) continue;
      if (this.decided.has(ev.mint)) continue;
      if (idx + 1 > cfg.maxEntryTradeIndex) {
        this.decided.add(ev.mint); // entry window passed for good
        continue;
      }
      // The signal trade's own price, straight from its reserves: the batch
      // groups several slots, so the batch-end price may already have run far
      // past the burst this buy is meant to catch. Skip those — do not chase.
      const sigPrice = curvePrice(
        BigInt(ev.virtual_quote_reserves),
        BigInt(ev.virtual_token_reserves),
      );
      if (sigPrice > 0 && c.lastPrice > sigPrice) {
        const driftBps = Math.round(((c.lastPrice - sigPrice) / sigPrice) * 10_000);
        if (driftBps > cfg.maxDriftBps) continue;
      }
      if (this.trades.has(ev.mint) || state.positions.has(ev.mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === ev.mint)) continue;
      // Spend the full ticket when the reserve cap allows, otherwise whatever
      // the cap admits — but never a dust ticket that would not count.
      const cap = state.maxBuyLamports(ev.mint);
      const size = cfg.buySizeLamports < cap ? cfg.buySizeLamports : cap;
      if (size < cfg.minBuyLamports) continue;
      if (state.committedPositionCount() + orders.filter((o) => o.side === "buy").length >= state.hello.caps.max_open_positions) break;
      if (freeCash - BigInt(orders.filter((o) => o.side === "buy").length) * cfg.buySizeLamports <= cfg.minBuyLamports) break;
      this.decided.add(ev.mint);
      orders.push({
        side: "buy",
        mint: ev.mint,
        quote_lamports: size,
        max_slippage_bps: cfg.buySlippageBps,
      });
      // Record the intent now so this same batch cannot double-book the mint;
      // the real fill updates the book on the next batch.
      this.trades.set(ev.mint, {
        mint: ev.mint,
        entryPrice: c.lastPrice,
        peakPrice: c.lastPrice,
        entryBatch: batch.seq,
        tokens: 0n,
        costLamports: size,
      });
    }
    return orders;
  }
}
