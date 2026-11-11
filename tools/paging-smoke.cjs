/*
 * Paging smoke: the dialog needs the WHOLE event window, so it walks older pages
 * before it can rebuild a call. That walk is the slow part of the first open in a
 * long conversation, and it is invisible in the render tests — so it gets its own
 * harness with fake bindings that page like the Host does.
 *
 * What is asserted:
 *   a) with a jump loader, one `loadThrough(0)` replaces the page-by-page storm;
 *   b) without one, the plain loop still walks to the oldest page;
 *   c) a jump that throws falls back instead of failing the open;
 *   d) a jump that reports success but loads nothing falls back too;
 *   e) a jump that lands but leaves `hasMore` set still finishes with loadOlder;
 *   f) the flattened window is seq-ordered and free of transient entries.
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
const internals = globalThis.__DSH_PAYLOAD_INTERNALS__;
if (!internals || typeof internals.loadFullWindow !== 'function') {
  throw new Error('loadFullWindow is not exposed to the test harness');
}

let problems = 0;
const expect = (ok, message) => {
  if (!ok) {
    problems += 1;
    console.log('PROBLEM:', message);
  }
};

/* One "page" is a block of PAGE_SIZE records; the Host hands them out oldest-last
   and publishes the newest page first. */
const PAGE_SIZE = 3;
const PAGES = 5;
const TOTAL = PAGE_SIZE * PAGES;

const record = (seq) => ({
  seq: seq,
  type: seq % 7 === 0 ? 'turn/start' : 'assistant/message',
  data: { message: { id: 'm' + seq, role: 'assistant', content: 'step ' + seq }, turn: 1, step: seq },
  time: seq,
});

const makeBinding = (options) => {
  const config = Object.assign({ jump: 'full', throwOnJump: false, jumpNoop: false }, options || {});
  let loadedPages = 1;
  const calls = { loadOlder: 0, loadThrough: [] };
  const entries = () => {
    const from = TOTAL - loadedPages * PAGE_SIZE;
    const out = [];
    for (let seq = from; seq < TOTAL; seq += 1) out.push({ type: 'event', event: record(seq) });
    /* A transient entry must never reach the rebuild. */
    out.push({ type: 'transient', event: record(TOTAL + 1) });
    return out;
  };
  const session = {
    loadOlder() {
      calls.loadOlder += 1;
      if (loadedPages < PAGES) loadedPages += 1;
      return Promise.resolve();
    },
  };
  if (config.jump !== 'none') {
    session.loadThrough = (seq) => {
      calls.loadThrough.push(seq);
      if (config.throwOnJump) return Promise.reject(new Error('jump refused'));
      if (config.jumpNoop) return Promise.resolve();
      loadedPages = seq <= 0 ? PAGES : Math.min(PAGES, loadedPages + 1);
      return Promise.resolve();
    };
  }
  return {
    calls: calls,
    loadedPages: () => loadedPages,
    binding: { session: session, eventSource: { getSnapshot: () => ({ entries: entries(), hasMore: loadedPages < PAGES }) } },
  };
};

const run = async () => {
  /* a) jump loader: one call, no page-by-page walk */
  {
    const probe = makeBinding();
    const events = await internals.loadFullWindow(probe.binding);
    expect(probe.calls.loadThrough.length === 1, 'jump loader was called ' + probe.calls.loadThrough.length + ' time(s)');
    expect(probe.calls.loadThrough[0] === 0, 'jump loader was not asked for the oldest seq (got ' + probe.calls.loadThrough[0] + ')');
    expect(probe.calls.loadOlder === 0, 'loadOlder was still used after a complete jump (' + probe.calls.loadOlder + ' calls)');
    expect(events.length === TOTAL, 'window came back with ' + events.length + ' of ' + TOTAL + ' events');
  }

  /* b) no jump loader at all: the loop must still reach the oldest page */
  {
    const probe = makeBinding({ jump: 'none' });
    const events = await internals.loadFullWindow(probe.binding);
    expect(probe.calls.loadOlder === PAGES - 1, 'plain pager made ' + probe.calls.loadOlder + ' calls, wanted ' + (PAGES - 1));
    expect(events.length === TOTAL, 'plain pager returned ' + events.length + ' of ' + TOTAL + ' events');
  }

  /* c) a jump that throws must fall back, not fail the open */
  {
    const probe = makeBinding({ throwOnJump: true });
    const events = await internals.loadFullWindow(probe.binding);
    expect(probe.calls.loadThrough.length === 1, 'throwing jump was not attempted');
    expect(events.length === TOTAL, 'throwing jump left the window short: ' + events.length + ' of ' + TOTAL);
  }

  /* d) a jump that resolves without loading anything must fall back too */
  {
    const probe = makeBinding({ jumpNoop: true });
    const events = await internals.loadFullWindow(probe.binding);
    expect(probe.calls.loadOlder === PAGES - 1, 'no-op jump stopped the walk early (' + probe.calls.loadOlder + ' pages)');
    expect(events.length === TOTAL, 'no-op jump left the window short: ' + events.length + ' of ' + TOTAL);
  }

  /* e) a jump that lands but leaves hasMore set: the loop finishes the walk */
  {
    const probe = makeBinding({ jump: 'none' });
    probe.binding.session.loadThrough = (seq) => {
      probe.calls.loadThrough.push(seq);
      /* Reports success without moving the window: exactly what a jump that hit a
         page with no progress does. */
      return Promise.resolve();
    };
    const events = await internals.loadFullWindow(probe.binding);
    expect(probe.calls.loadThrough.length === 1, 'stalled jump was not attempted');
    expect(probe.calls.loadOlder === PAGES - 1, 'hasMore after a jump did not finish with loadOlder (' + probe.calls.loadOlder + ')');
    expect(events.length === TOTAL, 'window short after jump+loop: ' + events.length + ' of ' + TOTAL);
  }

  /* f) ordering and transient filtering */
  {
    const probe = makeBinding();
    const events = await internals.loadFullWindow(probe.binding);
    let ordered = true;
    for (let i = 1; i < events.length; i += 1) {
      if (events[i].seq <= events[i - 1].seq) ordered = false;
    }
    expect(ordered, 'flattened window is not seq-ordered');
    expect(!events.some((event) => event.seq > TOTAL), 'a transient entry reached the rebuild');
  }

  /* g) a binding with no event source at all: an empty window, not a throw, so the
        dialog can report "no model call recorded" instead of an error. */
  {
    let threw = null;
    let events = null;
    try {
      events = await internals.loadFullWindow({ session: null, eventSource: null });
    } catch (err) {
      threw = err;
    }
    expect(threw === null, 'a sourceless binding threw: ' + (threw && threw.message));
    expect(Array.isArray(events) && events.length === 0, 'a sourceless binding did not yield an empty window');
  }

  if (problems) {
    console.log('=== paging smoke FAILED: ' + problems + ' problem(s) ===');
    process.exit(1);
  }
  console.log('=== paging smoke ok: jump loader replaces the page storm, fallbacks still walk ===');
};

run().catch((error) => {
  console.log('PROBLEM: harness threw —', error && error.message);
  process.exit(1);
});
