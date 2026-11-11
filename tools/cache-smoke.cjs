/*
 * Cache smoke: the per-Turn rebuild cache is bounded by BYTES, not just entries.
 *
 * A rebuilt Turn keeps every message of the window alive — measured ~18.5 MB per
 * Turn on a 21 k-record session, ~32 MB for the widest one — so "at most 40
 * entries" could retain hundreds of megabytes and make the browser collect while
 * the reader is scrolling what was just opened. What is asserted:
 *
 *   a) a Turn's size estimate is positive, and grows with the Turn;
 *   b) the estimate is in the right order of magnitude, not merely monotonic;
 *   c) the budget evicts: 40 oversized Turns cannot all survive;
 *   d) re-caching one key replaces its cost instead of adding another copy;
 *   e) a single Turn over budget is still kept (dropping it would make every
 *      open of that Turn a full rebuild) and evicts everything else.
 *
 * Run: node tools/cache-smoke.cjs
 */
const fs = require('fs');

globalThis.__DSH_PAYLOAD_TEST__ = true;
const reactStub = {
  createElement: () => null,
  Component: class {},
  Fragment: 'fragment',
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  memo: (component) => component,
};
globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => factory(() => reactStub),
  },
};
new Function('window', fs.readFileSync('./client.js', 'utf8'))(globalThis.window);
const api = globalThis.__DSH_PAYLOAD_INTERNALS__;
for (const name of ['buildTurnCalls', 'builtWeight', 'cacheStats', 'rememberBuilt']) {
  if (!api || typeof api[name] !== 'function') throw new Error(name + ' is not exposed to the test harness');
}

let problems = 0;
const expect = (ok, message) => {
  if (!ok) {
    problems += 1;
    console.log('PROBLEM:', message);
  }
};

/* ------------------------------------------------------------------ fixture */

const events = [];
let seq = 0;
const push = (type, data) => {
  seq += 1;
  events.push({ seq: seq, type: type, data: data, time: seq });
};

push('turn/start', { turn: 1 });
push('request/header', { reason: 'initial', header: { config: { model: 'model-a', provider: 'p' }, tools: [] } });
push('system/message', { message: { role: 'system', content: 'you are a helpful assistant' } });
push('user/message', { message: { role: 'user', content: 'first question' } });
for (let k = 1; k <= 2; k += 1) {
  push('step/start', { turn: 1, step: k });
  push('assistant/message', { turn: 1, step: k, message: { role: 'assistant', content: 'answer 1-' + k } });
}
push('turn/end', { turn: 1 });

push('turn/start', { turn: 2 });
push('user/message', { message: { role: 'user', content: 'second question' } });
for (let k = 1; k <= 12; k += 1) {
  push('step/start', { turn: 2, step: k });
  push('assistant/message', { turn: 2, step: k, message: { role: 'assistant', content: 'answer 2-' + k } });
  push('tool/call', { turn: 2, step: k, callId: 'c' + k, name: 'read_file', arguments: '{"path":"f' + k + '"}' });
  push('tool/result', { turn: 2, step: k, message: { role: 'tool', toolCallId: 'c' + k, content: 'contents of f' + k } });
}
push('turn/end', { turn: 2 });

const flat = api.collectEvents(events.map((event) => ({ type: 'event', event: event })));
const small = api.buildTurnCalls(flat, 1);
const large = api.buildTurnCalls(flat, 2);
expect(Boolean(small && large), 'fixture: the rebuild produced nothing');

/* --------------------------------------------------------- a) estimate moves */

const light = api.builtWeight(small);
const heavy = api.builtWeight(large);
expect(heavy > 0 && light > 0, 'a: builtWeight must return a positive size');
expect(heavy > light, 'a: a Turn with more calls must weigh more (' + heavy + ' vs ' + light + ')');
expect(api.builtWeight(null) === 0, 'a: builtWeight of nothing must be 0');

/* b) Order of magnitude. This fixture keeps a few dozen messages of a few dozen
   bytes each; a megabyte answer here would mean the estimate counts something
   twice. */
expect(heavy < 64 * 1024, 'b: estimate for a tiny Turn is absurdly large: ' + heavy + ' bytes');

/* ------------------------------------------------------------- c) the budget */

/* One shared string, counted once per entry: the budget must still bite even
   though the real heap cost of this test is a fraction of the estimate. */
const bulk = 'x'.repeat(5 * 1024 * 1024);
for (let i = 0; i < 40; i += 1) {
  api.rememberBuilt('bulk:' + i, {
    turn: i,
    calls: [{ index: 1, request: { messages: [{ role: 'system', content: bulk }] }, meta: {} }],
  });
}
const after = api.cacheStats();
expect(after.bytes <= after.budget, 'c: cache holds ' + after.bytes + ' bytes, over its ' + after.budget + ' budget');
expect(after.entries < 40, 'c: 40 oversized Turns must not all survive, kept ' + after.entries);

/* d) Pressing on one key must not leak its weight. */
const beforeRepeat = api.cacheStats();
for (let i = 0; i < 10; i += 1) {
  api.rememberBuilt('bulk:39', {
    turn: 39,
    calls: [{ index: 1, request: { messages: [{ role: 'system', content: bulk }] }, meta: {} }],
  });
}
const afterRepeat = api.cacheStats();
expect(
  afterRepeat.bytes <= beforeRepeat.bytes,
  'd: re-caching one Turn inflated the byte counter (' + beforeRepeat.bytes + ' → ' + afterRepeat.bytes + ')',
);

/* e) A single Turn over budget is still kept, and everything else goes. */
const huge = 'y'.repeat(120 * 1024 * 1024);
api.rememberBuilt('only:one', {
  turn: 99,
  calls: [{ index: 1, request: { messages: [{ role: 'system', content: huge }] }, meta: {} }],
});
const last = api.cacheStats();
expect(last.entries === 1, 'e: an oversized Turn must evict everything else, kept ' + last.entries);
expect(last.bytes > last.budget, 'e: the single oversized entry is expected to exceed the budget, got ' + last.bytes);

if (problems === 0) {
  console.log('=== cache smoke ok: the budget holds, re-caching one Turn does not leak ===');
} else {
  console.log('=== cache smoke: ' + problems + ' problem(s) ===');
  process.exitCode = 1;
}
