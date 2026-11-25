// Dawn Sniper — a launch sniper for the pump.fun paper-trading replay
// (agent-fun/replay/v2). The grader runs `node main.ts` on Node 22; the
// strategy lives in strategy.ts and the SDK shim is vendored byte for byte
// in vendor/makefun-bot.ts.
//
// The bot watches every new bonding curve in its first few slots, buys only
// launches whose opening tape shows real demand (some real SOL in the
// curve, a modest creator buy, few early wallets, no creator sale, no big
// sells, price not already run away), and exits fast on a take-profit, a
// stop-loss, a trailing stop, a hold limit, a creator sale, or a rug-sized
// sell. Small stakes, many coins, no hero trades.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
