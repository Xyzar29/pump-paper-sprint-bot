// Dawn Sniper — an early-launch paper-trading bot for the agent-fun/replay/v2
// pump.fun harness (Node 22, no dependencies, deterministic).
//
// Idea: on pump.fun almost every new coin dies within minutes and a few run
// 5-50x. Chasing strength after the move is already priced in (buying the
// top of a dump), so this bot does the opposite: it watches each launch in
// its first few slots, buys only the ones whose opening tape looks like real
// demand rather than a bundle, and then gets out fast — take profit on a
// quick pop, stop out on a small dip, never hold past a short clock. Small
// stakes, many coins, no hero trades. The replay flattens whatever is left
// at the end of the window, and completing curves close themselves.
//
// What counts as "real demand" in the opening tape:
//   - the curve already holds some real SOL (someone actually bought),
//   - the creator's own opening buy is modest, not a whale-sized bundle,
//   - only a few distinct non-creator wallets bought in (a launch swarmed by
//     many wallets in slot zero is usually the creator's cluster),
//   - the creator has not sold yet,
//   - sells so far are a small share of buys, with no single huge sell,
//   - the price has not already run away from its create price.
//
// Entries are one buy per coin (plus an optional add into strength). A coin
// that qualifies while all five position slots are full is not dropped: it
// stays eligible for a short retry window in case a slot frees up.
//
// Exits, checked before entries on every batch: full take-profit, stop-loss,
// a trailing stop once the position is up enough to arm it, a hard hold
// limit, an exit the moment the creator sells, an exit on a single huge
// sell (rug signal), and an exit when the coin goes quiet. A partial
// take-profit can bank part of a runner early and moves the rest to a
// breakeven-ish stop.
//
// Guardrail pacing: the replay ranks entries below the bar unless they make
// a round trip of at least 0.01 SOL on at least 20 coins, so when the bot's
// own coin count lags the pace of the window it opens tiny probe round
// trips (buy a little of a liquid coin, sell it as soon as the buy lands).
// Probes are a last resort, not the strategy.
//
// Determinism: no clock, no environment, no randomness. Iteration is only
// over insertion-ordered maps fed by the batch stream, and every decision
// derives from the batches the harness sends.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since the CreateEvent) at which a coin may be bought. */
  minAgeSlots: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAgeSlots: number;
  /** Slots a qualified-but-unbought coin stays eligible after maxAgeSlots. */
  retrySlots: number;
  /** Lamports to put into one coin on the first buy. */
  stakeLamports: number;
  /** Recent net inflow (lamports) at or above which the stake doubles, up to maxStakeLamports. */
  strongFlowLamports: number;
  /** Hard ceiling on lamports in one coin. */
  maxStakeLamports: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuyLamports: number;
  maxDevBuyLamports: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindowSlots: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Entry needs the price within this many bps of its high over highWindowSlots (0 = off). */
  maxDipFromHighBps: number;
  /** Entry needs the price at least this many bps below its high over highWindowSlots (0 = off). */
  minDipFromHighBps: number;
  highWindowSlots: number;
  /** A creator sale before entry disqualifies the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First partial take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the partial take-profit, the rest stops out at this much under its cost (bps; 0 = breakeven). */
  stopAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /** Exit when one recorded sell is at least this share (bps) of the real SOL reserve. */
  exitBigSellBps: number;
  /** Adds after the first buy, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelaySlots: number;
  /** Lamports per add. */
  addLamports: number;
  /** An add needs the recent net flow at least this. */
  addMinFlowLamports: number;
  /** Guardrail pacing: target coins and fills over the window's block time. */
  paceTargetCoins: number;
  paceTargetFills: number;
  paceWindowSecs: number;
  /** Probe round-trip size (lamports) used only when the pace lags. */
  probeLamports: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAgeSlots: 0,
  maxAgeSlots: 3,
  retrySlots: 6,
  stakeLamports: 100_000_000,
  strongFlowLamports: 1_000_000_000,
  maxStakeLamports: 200_000_000,
  minBuyLamports: 10_000_000,
  minRealSolLamports: 1_500_000_000,
  maxRealSolLamports: 30_000_000_000,
  minDevBuyLamports: 100_000_000,
  maxDevBuyLamports: 2_500_000_000,
  minBuyers: 2,
  maxBuyers: 3,
  minTrades: 0,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 15_000,
  flowWindowSlots: 10,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  maxDipFromHighBps: 0,
  minDipFromHighBps: 0,
  highWindowSlots: 10,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  stopAfterTp1Bps: 0,
  tpBps: 2_500,
  slBps: 300,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHoldSlots: 25,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  exitBigSellBps: 10_000,
  maxAdds: 0,
  addStepBps: 0,
  addDelaySlots: 2,
  addLamports: 100_000_000,
  addMinFlowLamports: 0,
  paceTargetCoins: 30,
  paceTargetFills: 0,
  paceWindowSecs: 21_600,
  probeLamports: 12_000_000,
  maxProbes: 1,
};

const BPS = 10_000n;
/** Curve fees on a sale: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  /** Price (virtual SOL per virtual token) just after this trade. */
  price: number;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindowSlots slots; older ones are dropped as new ones come. */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** The coin qualified while the position slots were full; retry until this slot. */
  retryUntil: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Transaction fees paid on this position's fills so far. */
  txPaid: bigint;
  /** Best sell value seen (lamports, fees deducted). */
  best: bigint;
  /** Whether the creator had already sold when the first buy filled. */
  devSoldAtOpen: boolean;
  /** Whether the partial take-profit already fired. */
  tookTp1: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight: mint -> true once its sell is out. */
  const probes = new Map<Pubkey, boolean>();
  const minBuy = BigInt(p.minBuyLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let myFills = 0;
  const myCoins = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          retryUntil: -1,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindowSlots slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - p.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  /** Highest recorded price over the last `window` slots, or 0 when there is none. */
  function highOver(c: Coin, slot: number, window: number): number {
    let high = 0;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= slot - window) break;
      if (t.price > high) high = t.price;
    }
    return high;
  }

  /** The stake for a first buy: doubled on a strong early inflow, capped at maxStakeLamports. */
  function stakeFor(c: Coin, slot: number): bigint {
    let stake = BigInt(p.stakeLamports);
    if (flow(c, slot).net >= BigInt(p.strongFlowLamports)) {
      stake *= 2n;
      const cap = BigInt(p.maxStakeLamports);
      if (stake > cap) stake = cap;
    }
    return stake;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fold this batch's fills into the bookkeeping: count our own fills and
      // coins (harness closes start with '_'), track tx fees per position,
      // and open a Held record the first time a buy of ours fills.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) probes.delete(mint);
      }

      // --- Exits first: every held position is re-priced on this batch. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Bank half on the first pop, then guard the rest near breakeven.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
            const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(p.stopAfterTp1Bps) : BigInt(p.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= p.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flow(c, state.slot).net < -BigInt(p.exitFlowLamports)) exit = true;
          if (c.bigSellBps >= BigInt(p.exitBigSellBps)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Probe exits: sell a landed probe whole, immediately. If the sell
      // did not go through (rejected or failed), try again while we hold it.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) continue;
        if (curve === undefined || curve.complete) continue;
        if (hasPending(state, mint, 'sell') || hasPending(state, mint, 'buy')) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // --- Entries and adds. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd) {
          if (age > p.maxAgeSlots && state.slot > c.retryUntil) {
            c.done = true;
            continue;
          }
          if (age < p.minAgeSlots) continue;
        } else {
          if (c.buysSent > p.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && (p.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (isAdd) {
          // A second tranche only once the launch has shown it is not an instant dump.
          if (state.slot - c.lastBuySlot < p.addDelaySlots) continue;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + p.addStepBps)) continue;
          if (flow(c, state.slot).net < BigInt(p.addMinFlowLamports)) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const want = BigInt(p.addLamports);
          const amount = want < maxAdd ? want : maxAdd;
          if (amount < minBuy || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // The opening-tape filter: real SOL, modest dev buy, few early buyers,
        // no dev sale, sells a small share of buys, no single huge sell, and
        // the price has not already run away from its create price.
        if (open >= state.hello.caps.max_open_positions) {
          // No slot free right now: keep the coin eligible a little longer.
          if (c.retryUntil < 0) c.retryUntil = state.slot + p.retrySlots;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSolLamports) || rq > BigInt(p.maxRealSolLamports)) continue;
        if (c.devBuy < BigInt(p.minDevBuyLamports) || c.devBuy > BigInt(p.maxDevBuyLamports)) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(p.maxRunupBps) || runup < BigInt(p.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(p.minFlowLamports) || fl.buyers < p.minRecentBuyers) continue;
        if (p.maxDipFromHighBps > 0 || p.minDipFromHighBps > 0) {
          const high = highOver(c, state.slot, p.highWindowSlots);
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          if (high > 0 && p.maxDipFromHighBps > 0 && price < high * (1 - p.maxDipFromHighBps / 10_000)) continue;
          if (high > 0 && p.minDipFromHighBps > 0 && price > high * (1 - p.minDipFromHighBps / 10_000)) continue;
        }
        const stake = stakeFor(c, state.slot);
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }

      // --- Guardrail pacing: tiny probe round trips only when behind pace. ---
      if (probes.size < p.maxProbes && open < state.hello.caps.max_open_positions && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / p.paceWindowSecs);
        const needCoins = myCoins.size < Math.ceil(p.paceTargetCoins * pace);
        const needFills = myFills < Math.ceil(p.paceTargetFills * pace);
        if (needCoins || needFills) {
          const probe = BigInt(p.probeLamports);
          // Newest coins first: a probe wants a curve that is still liquid.
          // Done coins are fine here — the probe is only a guardrail round
          // trip, not a filtered entry.
          const mints = [...coins.keys()].reverse();
          for (const mint of mints) {
            const c = coins.get(mint)!;
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (c.complete || probes.has(c.mint) || held.has(c.mint)) continue;
            if (hasPending(state, c.mint, 'buy') || state.positions.has(c.mint)) continue;
            if (needCoins && !needFills && myCoins.has(c.mint)) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            // Only probe a curve liquid enough for the probe plus its fees.
            if (state.maxBuyLamports(c.mint) < probe) continue;
            if (free < probe + 2n * tx) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: probe, max_slippage_bps: p.buySlippageBps });
            probes.set(c.mint, false);
            free -= probe + tx;
          }
        }
      }
      return orders;
    },
  };
}
