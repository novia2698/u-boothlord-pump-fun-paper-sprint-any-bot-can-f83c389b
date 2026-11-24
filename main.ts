// Pump.fun Paper Sprint — paper-trading bot for the agent-fun/replay/v2 harness.
//
// The bot itself is thin on purpose: it speaks the replay protocol through the
// vendored shim and hands every trading decision to strategy.ts. Keeping the
// wire loop and the trading brain in separate files means the strategy can be
// retuned without ever touching the protocol code, and the protocol code never
// has to know what a "good trade" looks like.
//
// Run by the harness as `node main.ts` on Node 22 (type stripping is built
// in). It reads batches on stdin, answers with orders on stdout, and exits
// when the harness sends `done`. It never touches the network, the clock, or
// any file — the replay is the whole world, and the run is deterministic.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";
import { DEFAULT_CONFIG, PaperSprintStrategy } from "./strategy.ts";

// One strategy instance for the whole run. Its config is the default set in
// strategy.ts; retuning means changing the numbers there, not here.
const strategy = new PaperSprintStrategy(DEFAULT_CONFIG);

await runBot({
  onBatch(state: BotState, batch: Batch) {
    // Every decision the strategy makes comes only from this state and this
    // batch, so answering the same replay twice gives the same reply twice.
    return strategy.decide(state, batch);
  },
});

// Note on determinism: the harness executes each entry twice and requires the
// two action logs to match byte for byte. This file creates no randomness, reads
// no clock, and keeps no state outside the strategy instance above, so the
// second run replays the first exactly. If a future variant needs a tie-break
// that chance would normally settle, it must derive it from hello.seed —
// never from Math.random or Date.now.
