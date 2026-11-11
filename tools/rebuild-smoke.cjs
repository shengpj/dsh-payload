/*
 * Rebuild smoke: a long Turn's rebuild can be sliced, and slicing changes nothing
 * except who gets the thread back.
 *
 * A Turn with a hundred calls takes ~190 ms to rebuild here, and a task that long
 * cannot paint anything — not the spinner, not the progress line that is supposed
 * to say the work is moving. So the rebuild is cut into slices with a painted
 * frame between them. What is asserted:
 *
 *   a) a sliced rebuild is byte-for-byte the same result as the synchronous one;
 *   b) progress moves strictly forward and always names the same total, and a
 *      rebuild that never yields reports nothing (correctness must not depend on
 *      progress being reported);
 *   c) closing the dialog abandons the work instead of finishing it.
 *
 * Run: node tools/rebuild-smoke.cjs
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
for (const name of ['buildTurnCalls', 'buildTurnCallsChunked']) {
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

/* An earlier Turn, so the fold has real history before the Turn under test. */
push('turn/start', { turn: 1 });
push('request/header', { reason: 'initial', header: { config: { model: 'model-a', provider: 'p' }, tools: [] } });
push('system/message', { message: { role: 'system', content: 'you are a helpful assistant' } });
push('user/message', { message: { role: 'user', content: 'first question' } });
for (let k = 1; k <= 3; k += 1) {
  push('step/start', { turn: 1, step: k });
  push('assistant/message', { turn: 1, step: k, message: { role: 'assistant', content: 'answer 1-' + k } });
}
push('turn/end', { turn: 1 });

/* The Turn under test: 25 calls, each with a tool round-trip. */
const STEPS = 25;
push('turn/start', { turn: 2 });
push('user/message', { message: { role: 'user', content: 'second question' } });
for (let k = 1; k <= STEPS; k += 1) {
  push('step/start', { turn: 2, step: k });
  push('assistant/message', { turn: 2, step: k, message: { role: 'assistant', content: 'answer 2-' + k } });
  push('tool/call', { turn: 2, step: k, callId: 'c' + k, name: 'read_file', arguments: '{"path":"f' + k + '"}' });
  push('tool/result', { turn: 2, step: k, message: { role: 'tool', toolCallId: 'c' + k, content: 'contents of f' + k } });
}
push('turn/end', { turn: 2 });

const flat = api.collectEvents(events.map((event) => ({ type: 'event', event: event })));

/* ------------------------------------------------------- a) same answer, twice */

const sync = api.buildTurnCalls(flat, 2);
expect(Boolean(sync), 'a: the synchronous rebuild produced nothing');
expect(sync && sync.calls.length === STEPS, 'a: expected ' + STEPS + ' calls, got ' + (sync ? sync.calls.length : 'none'));

const runChunked = async (options) => api.buildTurnCallsChunked(flat, 2, undefined, undefined, options);

(async () => {
  const progress = [];
  const chunked = await runChunked({
    sliceMs: 0,
    onProgress: (done, total) => progress.push([done, total]),
  });

  const syncJSON = JSON.stringify(sync);
  const chunkedJSON = JSON.stringify(chunked);
  expect(syncJSON === chunkedJSON, 'a: sliced rebuild differs from the synchronous one');
  expect(syncJSON.length > 1000, 'a: the fixture rebuilt into something suspiciously small');

  /* ----------------------------------------------------------- b) progress */

  expect(progress.length >= 2, 'b: expected several progress slices, got ' + progress.length);
  let rising = true;
  for (let i = 1; i < progress.length; i += 1) {
    if (!(progress[i][0] > progress[i - 1][0])) rising = false;
  }
  expect(rising, 'b: progress must move strictly forward: ' + JSON.stringify(progress));
  expect(progress.every((entry) => entry[1] === STEPS), 'b: progress must report the same total every time');

  /* Without a forced yield the fast fixture finishes in one slice and reports
     nothing — correctness must not depend on progress being reported. */
  const quiet = [];
  const unsliced = await runChunked({ onProgress: (done) => quiet.push(done) });
  expect(JSON.stringify(unsliced) === syncJSON, 'b: a rebuild that never yields must still match');
  expect(quiet.length === 0, 'b: a single-slice rebuild must not report progress, got ' + quiet.length);

  /* ---------------------------------------------------------- c) abandoned */

  let slices = 0;
  const abandoned = await runChunked({
    sliceMs: 0,
    onProgress: () => {
      slices += 1;
    },
    abandoned: () => slices >= 2,
  });
  expect(abandoned === null, 'c: closing the dialog must abandon the rebuild, not finish it');
  expect(slices <= 3, 'c: abandoning should stop within a slice or two, took ' + slices);

  /* A listener that throws must not strand the rebuild. */
  const survivor = await runChunked({
    sliceMs: 0,
    onProgress: () => {
      throw new Error('broken listener');
    },
  });
  expect(JSON.stringify(survivor) === syncJSON, 'c: a throwing progress listener must not break the rebuild');

  if (problems === 0) {
    console.log('=== rebuild smoke ok: slicing matches the sync pass, progress rises, closing stops ===');
  } else {
    console.log('=== rebuild smoke: ' + problems + ' problem(s) ===');
    process.exitCode = 1;
  }
})();
