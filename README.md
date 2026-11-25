# Dawn Sniper — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Xyzar29/pump-paper-sprint-bot/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Xyzar29/pump-paper-sprint-bot/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on [make.fun](https://make.fun): it paper-trades pump.fun bonding curves on a 6-hour replay, ranked by net PnL. No real funds, no entry fee.

## Strategy

On pump.fun almost every new coin dies within minutes and a few run far.
Chasing strength after the move is already priced in, so Dawn Sniper does
the opposite: it watches each launch in its first few slots, buys only the
ones whose opening tape looks like real demand, and gets out fast.

**Entry (first few slots after a `CreateEvent`):**

- the curve already holds 1.5–30 SOL of real SOL (someone actually bought),
- the creator's own opening buy is 0.1–2.5 SOL (skin in the game, not a whale bundle),
- 2–3 distinct non-creator wallets bought in (a launch swarmed by many wallets in slot zero is usually the creator's cluster waiting to dump),
- the creator has not sold yet,
- sells so far are a small share of buys, with no single huge sell,
- the price has not already run more than 50% past its create price.

One buy per coin, 0.1 SOL (doubled to 0.2 SOL when the recent net inflow
tops 1 SOL), never below the 0.01 SOL round-trip minimum the replay's
guardrail needs. A coin that qualifies while all five position slots are
full stays eligible for a short retry window instead of being dropped.

**Exits (checked before entries on every batch):** take-profit at +25%,
stop-loss at −3%, a 25-slot hold limit, an exit the moment the creator
sells, and an exit on a single rug-sized sell. No partial take-profit, no
trailing stop, no adds — on the dev window every one of those gave the
gains back to the dump.

**Guardrail pacing:** the replay ranks entries below the bar unless they
make a round trip of at least 0.01 SOL on at least 20 coins, so when the
bot's own coin count lags the pace of the window it opens tiny 0.012 SOL
probe round trips on liquid curves (buy, sell as soon as the buy lands).
Probes are a last resort, not the strategy.

## Practice-data score (kit dev window, 24 h)

| | |
|---|---|
| Net PnL | **−0.084 SOL** (halves +0.020 / −0.104) |
| Coins traded | 101 (94 filtered entries + 7 probes) |
| Round trips | 101, 12 wins |
| Max drawdown | 1.4% (guardrail: ≤ 50%) |
| Best coin | +0.028 SOL |

Variants tried on the same window, all worse: late momentum (−9.5 SOL),
dip-reversion (−1.6 SOL), the kit sniper pilot (−0.14 SOL), micro-momentum
entries at age 4–15 slots (−0.06 SOL on 39 coins — too few to clear the
20-coin guardrail safely), long holds with trailing stops (−0.42 SOL),
pyramid adds (−0.20 SOL). The entry filter that mattered most was the
run-up cap (buying after a big pop is buying the top) plus requiring a
modest creator buy and 2–3 early buyers.

## Layout

- `main.ts` — entrypoint; the grader runs `node main.ts` (Node 22).
- `strategy.ts` — the strategy (deterministic: no clock, no environment, no randomness).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte for byte.

## License

MIT — see [LICENSE](LICENSE).
