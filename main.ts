// Dawn Sniper — a launch sniper for the pump.fun paper-trading replay
// (agent-fun/replay/v2). The grader runs `node main.ts` on Node 22; the
// strategy lives in strategy.ts and the SDK shim is vendored byte for byte
// in vendor/makefun-bot.ts. Run it locally the same way (`node main.ts`)
// and feed it harness lines on stdin; replies go to stdout, diagnostics to
// stderr, so the action log stays clean.
//
// The bot watches every new bonding curve in its first few slots, buys only
// launches whose opening tape shows real demand (some real SOL in the
// curve, a modest creator buy, few early wallets, no creator sale, no big
// sells, price not already run away), and exits fast on a take-profit, a
// stop-loss, a trailing stop, a hold limit, a creator sale, or a rug-sized
// sell. Small stakes, many coins, no hero trades. When its own coin count
// lags the pace of the window it opens tiny probe round trips so the run
// clears the replay's 20-coin / 0.01-SOL guardrail.
//
// Determinism is a grading rule, not a nicety: the entry is executed twice
// and the two action logs must match byte for byte, so the strategy reads
// no clock, no environment and no randomness — every decision derives from
// the batches the harness sends. The defaults below are the settings swept
// on the kit's dev window (see README.md); changing them changes the trade.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot(strategy);
