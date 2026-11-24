# Pump.fun Paper Sprint — Early-Burst Paper Trading Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/novia2698/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/novia2698/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It trades pump.fun bonding curves on a replay of real chain data — no real money, no real funds, pure net PnL wins the pot.

## The strategy

Most new pump.fun coins bleed out after launch, and brief early spikes
usually reverse inside a single replay batch — a batch-end bot cannot catch
them, but it always catches the fall. So this bot buys the birth and holds
for the big move instead of scalping:

- **Enter on the first buy.** A mint qualifies only on its first buy trade
  (within its first 3 trades), spending up to 0.05 SOL but never more than
  the 1%-of-reserve order cap allows and never less than 0.01 SOL — and only
  when the batch-end price has not already run more than 5% past that first
  trade's own price. A spike inside the decision batch means the burst is
  spent before the buy can fill, so those are skipped, not chased.
- **Wide, mechanical exits.** Take-profit +100%, stop-loss −30%, a trailing
  exit once price gives back 20% from a peak at least +30% up, and a stale
  hold of 20000 batches. A +100% run lasts many batches, so a batch-end bot
  can actually see it; a brief +15% spike it cannot.
- **Fixed small size.** At most 5 open positions at once, so one bad coin can
  never eat the account — and breadth clears the 20-coin minimum bar.
- **Pure replay data.** No clock, no randomness, no network. The same replay
  always produces the same orders, which is what the harness requires (two
  runs must match byte for byte).

Dev-window result (grade-local, process driver): net PnL −0.06 SOL over 26
round trips, max drawdown 1.2%, guardrails met. The 90% interval straddles
zero — this is a near-breakeven lottery ticket on the final 6-hour window,
not a proven edge, and it is reported as such.

## Files

- `main.ts` — the harness wire loop (stdin/stdout, agent-fun/replay/v2).
- `strategy.ts` — the trading brain: entry filter, exit rules, position book.
- `vendor/makefun-bot.ts` — the vendored replay protocol shim from the kit.
- `system-prompt.txt` — the builder brief this entry was written from.

## Run it

```sh
node main.ts   # driven by the harness; on its own it waits on stdin
```

Grade locally with the kit CLI:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=bpr1tvsc&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>

<!-- Bounty: Pump.fun Paper Sprint: Any Bot Can Win — winner takes all ($2), ranked by net PnL on a 6-hour pump.fun replay. Entry: @sipakades. -->
