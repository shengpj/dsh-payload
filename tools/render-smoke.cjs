/*
 * Headless render smoke test for the dialog body.
 *
 * The Web UI is the only place the dialog really runs, so this harness stubs the
 * React surface the plugin uses (createElement/useState/useRef/useEffect/
 * useReducer/memo) and walks the returned element tree. It cannot check pixels,
 * but it does catch the failure modes that white-screen the overlay: a hook used
 * out of order, a thrown branch, a duplicate key, a missing style.
 *
 * Usage: node tools/render-smoke.cjs
 */
const fs = require('fs');
const path = require('path');

/* --------------------------------------------------------------- React stub */

const hookState = { calls: [], keyed: [] };

/* ------------------------------------------------------- stateful mounting */
/* `walk()` renders with inert hooks, which is all the static scenarios need.
   The step/side gesture IS state (one selected step, one selected side), so
   `mountWalk()` renders the same tree with a per-component hook store and keeps
   re-rendering while anything is dirty. */
const hookStores = new Map();
let mounting = false;
let activeStore = null;

function runComponent(fn, props) {
  if (!mounting) return fn(props);
  let store = hookStores.get(fn);
  if (!store) {
    store = { cells: [], index: 0, dirty: false };
    hookStores.set(fn, store);
  }
  const previous = activeStore;
  activeStore = store;
  store.index = 0;
  try {
    return fn(props);
  } finally {
    activeStore = previous;
  }
}

const ReactStub = {
  createElement(type, props, ...children) {
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push);
      else if (child !== null && child !== undefined && child !== false) flat.push(child);
    };
    children.forEach(push);
    const key = props && props.key !== undefined ? props.key : null;
    return { type, props: Object.assign({}, props, { children: flat }), key };
  },
  useState(initial) {
    if (!activeStore) return [typeof initial === 'function' ? initial() : initial, () => {}];
    const store = activeStore;
    const slot = store.index;
    store.index += 1;
    if (!(slot in store.cells)) {
      store.cells[slot] = typeof initial === 'function' ? initial() : initial;
    }
    const set = (next) => {
      const value = typeof next === 'function' ? next(store.cells[slot]) : next;
      if (value === store.cells[slot]) return;
      store.cells[slot] = value;
      store.dirty = true;
    };
    return [store.cells[slot], set];
  },
  useReducer(reducer, initial) {
    const cell = ReactStub.useState(initial);
    return [cell[0], (action) => cell[1]((value) => reducer(value, action))];
  },
  useRef(value) {
    return { current: value };
  },
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
  memo(component) {
    return component;
  },
  /* React.Component only backs the dialog's error boundary. */
  Component: class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
  },
};

/* ------------------------------------------------------------ plugin loader */

function loadPlugin(file) {
  globalThis.__DSH_PAYLOAD_TEST__ = true;
  let module = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        module = factory((name) => {
          if (name === 'react') return ReactStub;
          throw new Error('unexpected require: ' + name);
        });
      },
    },
  };
  const source = fs.readFileSync(file, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', source)(globalThis.window);
  if (!module) throw new Error('module loader never called');
  return module;
}

/* ------------------------------------------------------------- tree walking */

function render(node, sink) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') {
    sink.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => render(child, sink));
    return;
  }
  if (typeof node.type === 'function') {
    /* Class components (the error boundary) must be instantiated, not called. */
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props);
      instance.props = node.props;
      render(instance.render(), sink);
      return;
    }
    render(runComponent(node.type, node.props), sink);
    return;
  }
  /* The source bar's segments carry no class of their own; count its children. */
  if (node.type === 'div' && node.props && node.props.title === undefined
      && Array.isArray(node.props.children) && node.props.children.length > 0
      && node.props.children.every((c) => c && c.type === 'div' && c.props && typeof c.props.title === 'string'
        && /·\s*\d+$/.test(c.props.title))) {
    sink.barSegs = node.props.children.length;
  }
  if (node.type === 'button') sink.buttons.push(node);
  const className = node.props && node.props.className;
  if (typeof className === 'string') {
    sink.classes.push(className);
    /* Hover tooltips are element titles; keep them so assertions can check what a
       pill or segment says when the pointer rests on it. */
    if (typeof node.props.title === 'string') sink.tips.push(node.props.title);
  }
  /* A diff row's expand toggle: one per added message, collapsed by default. */
  if (node.type === 'button' && node.props && node.props['aria-expanded'] !== undefined) {
    sink.toggles.push(String(node.props['aria-expanded']));
  }
  /* Inline styles carry the "new since the previous call" marks (a dashed rail
     on each fresh message), so keep them for assertions. */
  if (node.props && node.props.style && typeof node.props.style === 'object') sink.styles.push(node.props.style);
  /* DOM ids are the pane's scroll anchors (see DialogBody's reveal effect). */
  if (node.props && typeof node.props.id === 'string') sink.ids.push(node.props.id);
  sink.tags.push(String(node.type));
  const siblings = node.props.children;
  const seen = new Set();
  for (const child of siblings) {
    if (child && typeof child === 'object' && child.key !== null && child.key !== undefined) {
      const id = String(child.type) + ':' + child.key;
      if (seen.has(id)) sink.dupeKeys.push(id);
      seen.add(id);
    }
  }
  siblings.forEach((child) => render(child, sink));
}

function walk(element) {
  const sink = { text: [], classes: [], tags: [], tips: [], dupeKeys: [], toggles: [], buttons: [], styles: [], ids: [] };
  render(element, sink);
  return sink;
}

/* The label a button renders: its children are already plain elements by the time
   it is collected, so this never re-runs a component. */
function labelOf(node, depth) {
  if (depth > 8) return '';
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => labelOf(child, depth + 1)).join(' ');
  return labelOf((node.props || {}).children, depth + 1);
}

/* Mount with live hooks: render, then re-render while any setter fired. */
function settle(renderRoot, reset) {
  if (reset) hookStores.clear();
  mounting = true;
  try {
    let sink = walk(runComponent(renderRoot, null));
    for (let pass = 0; pass < 8; pass += 1) {
      let dirty = false;
      for (const store of hookStores.values()) {
        if (store.dirty) dirty = true;
        store.dirty = false;
      }
      if (!dirty) break;
      sink = walk(runComponent(renderRoot, null));
    }
    return sink;
  } finally {
    mounting = false;
    activeStore = null;
  }
}

function mountWalk(renderRoot) {
  return settle(renderRoot, true);
}

function rerender(renderRoot) {
  return settle(renderRoot, false);
}

/* Find the timeline track: the flex row whose children are all ratio-buttons. */
function findTrack(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTrack(child);
      if (hit) return hit;
    }
    return null;
  }
  const props = node.props || {};
  if (node.type === 'div' && Array.isArray(props.children) && props.children.length > 1
      && props.children.every((c) => c && c.type === 'button' && c.props && c.props.style
        && typeof c.props.style.flex === 'string' && /^\d+ 1 0$/.test(c.props.style.flex))) {
    return node;
  }
  return findTrack(props.children || []);
}

/* ---------------------------------------------------------- payload fixtures */

function makeCall(index, step, messageCount, tokens, sources) {
  return {
    index,
    step,
    meta: {
      index,
      step,
      model: 'vc-ds/deepseek-v4.1-flash',
      messages: messageCount,
      historyEnd: sources ? messageCount - 2 : 0,
      tools: 52,
      reason: index === 1 ? 'initial' : 'resume',
      sources: sources || null,
      freshSources: sources
        ? { counts: { prompt: 1, injected: 1, model: 0, tool: 0, other: 0 }, kinds: [] }
        : null,
      freshBytes: sources ? 2048 : 0,
      usage: { input: tokens, cache: 0, output: Math.round(tokens / 10), total: tokens, hitRate: 0 },
      /* Tool traffic per step, as the real pipeline records it. */
      toolCalls: tokens > 150 ? 2 : tokens > 50 ? 1 : 0,
      toolResults: tokens > 150 ? 2 : tokens > 50 ? 1 : 0,
      toolNames: tokens > 150 ? ['read', 'grep'] : tokens > 50 ? ['read'] : [],
      diff:
        index === 1
          ? null
          : {
              /* Counts only now: the "what is new" marks are drawn inside the
                 `messages` array, so the diff object no longer ships the
                 messages themselves (they already live in request.messages). */
              prefix: messageCount - 2,
              added: 2,
              removed: 0,
              rewritten: false,
              changed: [],
              prevMessages: messageCount - 2,
            },
    },
    request: {
      model: 'deepseek-v4.1-flash',
      provider: 'vc-ds',
      messages: buildMessages(messageCount, step),
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    },
  };
}

/* `messageCount` messages whose last two are what the NEXT call appends: an
   assistant line and its tool result — the shape the diff marks act on. */
function buildMessages(messageCount, step) {
  const list = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'step ' + step + ' question' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', name: 'read', arguments: '{"a":1}' }] },
  ];
  while (list.length < messageCount - 2) {
    list.push({ role: 'tool', content: 'filler ' + list.length, tool_call_id: 'call_1' });
  }
  if (messageCount >= 1) list.push({ role: 'assistant', content: [{ type: 'text', text: 'I will read it.' }] });
  if (messageCount >= 2) list.push({ role: 'tool', content: 'file contents…', tool_call_id: 'call_1' });
  return list.slice(0, Math.max(0, messageCount));
}

function payload(calls, selected) {
  return {
    scheme: 'dark',
    selectedIndex: selected || 0,
    data: { turn: 24, calls },
  };
}

/* ------------------------------------------------------------------- checks */

const problems = [];
function expect(condition, label) {
  if (!condition) problems.push(label);
}

const file = path.join(__dirname, '..', 'client.js');
const plugin = loadPlugin(file);
const internals = globalThis.__DSH_PAYLOAD_INTERNALS__;
expect(!!internals, 'test hook not exported');
expect(typeof internals.DialogBody === 'function', 'DialogBody not exposed');

const DialogBody = internals.DialogBody;
const ResponsePanel = internals.ResponsePanel;

/* a) single call: one row in the left column, the same shape as forty calls */
const one = walk(DialogBody({ payload: payload([makeCall(1, 1, 7, 14056)]) }));
/* One call, one row: the column never changes shape and never disappears. */
expect(
  one.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step')).length >= 1,
  'a single call should still get a row in the left column',
);
expect(
  one.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step-on')).length === 1,
  'the single call should be the active row',
);
expect(!one.classes.some((c) => c.includes('dsh-pl-tab')), 'the old tab strip is still rendered');
expect(one.text.join(' ').includes('deepseek-v4.1-flash'), 'model chip missing');
expect(one.text.join(' ').includes('messages'), 'JSON body not rendered');

/* b) three calls: three rows in the same column, nothing above the JSON pane */
const three = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200), makeCall(3, 7, 11, 300)]) }));
const tabs = three.classes.filter((c) => c.includes('dsh-pl-tab'));
expect(tabs.length === 0, 'expected no tab buttons, got ' + tabs.length);
expect(
  three.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step')).length >= 3,
  'expected three step rows',
);
expect(
  three.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step-on')).length === 1,
  'exactly one step row should be active',
);
expect(three.text.includes('#1') && three.text.includes('#3'), 'step labels missing');

/* c) 20 calls (this is what broke the old <select>): step list, no tabs */
const many = walk(DialogBody({ payload: payload(Array.from({ length: 20 }, (_, i) => makeCall(i + 1, 40 + i, 10 + i, 1000 * (i + 1)))) }));
/* The timeline's "heaviest" pills share the active-state class (dsh-pl-step-on)
   with the list rows, so match whole tokens rather than substrings. */
const rows = many.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step'));
expect(rows.length >= 20, 'expected at least 20 step rows, got ' + rows.length);
expect(many.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step-on')).length >= 1, 'no step row is active');
expect(!many.classes.some((c) => c.split(/\s+/).includes('dsh-pl-tab')), 'tab strip rendered alongside the step list');
expect(many.text.includes('#20'), 'last step row label missing');
expect(many.text.join(' ').includes('step 59'), 'step number missing from a row');
expect(!many.tags.includes('select'), 'a <select> is still rendered');

/* d) selection follows selectedIndex coming from the clicked message */
const scoped = walk(
  DialogBody({
    payload: Object.assign({}, payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200)]), { selectedIndex: 1 }),
  }),
);
const scopedText = scoped.text.join(' ');
expect(scopedText.includes('#2'), 'scoped selection did not mark call #2');
expect(scopedText.includes('#2 / 2'), 'call chip did not follow the selection');

/* e) an empty payload must not throw */
const empty = walk(DialogBody({ payload: { scheme: 'light', data: { turn: 1, calls: [] } } }));
expect(empty.text.length > 0, 'empty payload rendered nothing');

/* f) duplicate keys among siblings would spam the React console */
const dupeKeys = [one, three, many, scoped, empty].flatMap((sink) => sink.dupeKeys);
expect(dupeKeys.length === 0, 'duplicate sibling keys: ' + dupeKeys.slice(0, 4).join(', '));

/* g) the real user path: apply() registers both slots, and the overlay renders
      whatever the trigger published — including the title the trigger builds. */
const registered = [];
plugin.apply({
  get: () => undefined,
  slots: {
    inject(_owner, contribute) {
      contribute();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
});
expect(registered.length === 2, 'expected 2 slot registrations, got ' + registered.length);
const names = registered.map((entry) => entry.options && entry.options.name);
expect(names.includes('conversation.chat.assistant-actions'), 'action row registration missing: ' + names.join(', '));
expect(names.includes('shell.overlay'), 'overlay registration missing: ' + names.join(', '));

const overlay = (registered.find((entry) => entry.options.name === 'shell.overlay') || {}).component;
expect(typeof overlay === 'function', 'overlay component not registered');

internals.publishDialog(null);
const closed = walk(overlay({}));
expect(closed.text.length === 0, 'overlay rendered while nothing was published');

internals.publishDialog({
  status: 'ready',
  title: '本轮发送给模型的完整请求 · Turn 24 · step 58',
  scheme: 'dark',
  selectedIndex: 0,
  data: { turn: 24, calls: [makeCall(1, 58, 12, 100), makeCall(2, 59, 14, 200)] },
});
const open = walk(overlay({}));
const openText = open.text.join(' ');
expect(openText.includes('Turn 24'), 'overlay did not render the published title');
expect(open.classes.some((c) => c.split(/\s+/).includes('dsh-pl-step')), 'overlay did not render the step column');
expect(openText.includes('#1 / 2'), 'overlay dialog lost the call chip');

internals.publishDialog({ status: 'error', title: '本轮发送给模型的完整请求', message: 'sessions service unavailable' });
const failed = walk(overlay({}));
expect(failed.text.join(' ').includes('sessions service unavailable'), 'error state did not surface the message');

/* Reading a long session's history takes seconds and has no partial result. The
   line therefore does NOT print elapsed time: it cannot repaint while the work it
   counts holds the thread, and a number standing still reads as a broken counter
   (it was reported as a bug twice). What it must carry instead is a composited
   spinner, and the build stamp, so "is the new bundle even loaded?" is answerable. */
internals.publishDialog({
  status: 'loading',
  title: '本轮发送给模型的完整请求',
  note: '正在读取这段对话的历史…',
});
const reading = walk(overlay({}));
expect(reading.text.join(' ').includes('正在读取这段对话的历史'), 'loading state lost its phase line');
expect(
  !/\d\.\d\s*秒|秒…（/u.test(reading.text.join(' ')),
  'loading state went back to printing elapsed seconds',
);
expect(
  reading.classes.some((c) => c.split(/\s+/).includes('dsh-pl-spin')),
  'loading state has no spinner to keep moving while the thread is busy',
);
expect(/\b1\.\d+\.\d+\b/u.test(reading.text.join(' ')), 'loading state does not show which build is running');

/* The rebuild is one long synchronous task; it gets its own line so the reader
   knows the wait changed nature rather than stalled. */
internals.publishDialog({
  status: 'loading',
  title: '本轮发送给模型的完整请求',
  note: '历史已读入，正在重建这一轮…',
});
const rebuilding = walk(overlay({}));
expect(rebuilding.text.join(' ').includes('正在重建这一轮'), 'rebuild phase did not name the phase');
expect(
  rebuilding.classes.some((c) => c.split(/\s+/).includes('dsh-pl-spin')),
  'rebuild phase lost the spinner',
);

/* An error is not busy: it must not keep a spinner turning. */
expect(
  !failed.classes.some((c) => c.split(/\s+/).includes('dsh-pl-spin')),
  'error state should not animate a spinner',
);

internals.publishDialog(null);

/* h) a request that knows where its Turn begins: the older messages fold into
      one group line, and the messages this turn produced keep their real array
      indices and stay visible. */
const splitCall = makeCall(1, 5, 5, 100);
splitCall.meta.historyEnd = 2;
const split = walk(DialogBody({ payload: payload([splitCall]) }));
const splitRaw = split.text.join('');
const splitSpaced = split.text.join(' ');
expect(/历史消息|earlier messages/.test(splitSpaced), 'folded history group label missing');
expect(/\(2\)/.test(splitRaw), 'folded group did not report how many messages it hides: ' + splitRaw.slice(0, 120));
expect(/本轮|this turn/.test(splitSpaced), 'current-turn badge missing');
expect(splitSpaced.includes('2'), 'the message produced by this turn lost its array index');
expect(!one.text.join('').includes('历史消息'), 'history group rendered without a turn boundary');
expect(!one.text.join('').includes('earlier messages'), 'history group rendered without a turn boundary');

/* i) source breakdown: the bar, the families, the fresh marker, and no bar
      when the log does not say where messages came from. */
const withSources = makeCall(1, 5, 5, 100, {
  counts: { prompt: 1, injected: 3, model: 40, tool: 41, other: 0 },
  kinds: [
    { key: 'user', kind: 'user', family: 'prompt', count: 1 },
    { key: 'timeContext', kind: 'time-context', family: 'injected', count: 2 },
    { key: 'runtimeContext', kind: 'runtime-context', family: 'injected', count: 1 },
    { key: 'model', kind: 'model', family: 'model', count: 40 },
    { key: 'tool', kind: 'tool', family: 'tool', count: 41 },
  ],
});
const sourced = walk(DialogBody({ payload: payload([withSources]) }));
const sourcedText = sourced.text.join(' ');
expect(sourced.classes.some((c) => c.split(/\s+/).includes('dsh-pl-sources')), 'source panel not rendered');
expect(/你的输入|your prompt/.test(sourcedText), 'prompt family missing from the legend');
expect(/自动注入|injected/.test(sourcedText), 'injected family missing from the legend');
expect(/工具往返|tool round-trips/.test(sourcedText), 'tool family missing from the legend');
expect(/本轮新增|new this turn/.test(sourcedText), 'fresh-this-turn marker missing');
/* The bar carries one segment per non-empty family: prompt, injected, model, tool. */
expect(sourced.barSegs === 4, 'expected 4 bar segments (non-empty families), got ' + sourced.barSegs);
expect(!one.text.join(' ').match(/你的输入|your prompt/), 'source panel rendered without a summary');

/* j) "what did this call add": marked inside the messages array itself — the
      first call of a Turn marks nothing, later calls band the appended messages
      and draw the boundary rule, and a rewrite is called out as such. */
const firstCall = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100)]) }));
const firstText = firstCall.text.join(' ');
expect(!/新增|new in this call/.test(firstText), 'first call should mark nothing: nothing to compare against');
expect(!firstText.includes('上一次调用已有'), 'first call drew a diff boundary');
expect(
  firstCall.styles.filter((style) => String(style.borderLeft).includes('dashed')).length === 0,
  'first call drew a dashed rail',
);

const diffed = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200)], 1) }));
const diffedText = diffed.text.join(' ');
expect(diffedText.includes('+2'), 'fresh pill missing, got ' + diffedText.slice(0, 200));
expect(/新增|new/.test(diffedText), 'fresh pill has no label');
expect(
  diffedText.includes('上一次调用已有') || diffedText.includes('the previous call already had'),
  'diff boundary rule missing',
);
expect(!/消失|gone/.test(diffedText), 'removed pill should not appear when nothing was removed');
/* Two appended messages → exactly two dashed rails, and they sit on the LAST
   two messages (index 7 and 8 of a 9-message payload). */
const rails = diffed.styles.filter((style) => String(style.borderLeft).includes('dashed'));
expect(rails.length === 2, 'expected 2 dashed rails for 2 appended messages, got ' + rails.length);
/* The boundary line is where the pane must land when the reader picks this
   step: exactly one such anchor per document, on the rule above the additions. */
const anchors = (sink) => sink.ids.filter((id) => id === 'dsh-pl-diff').length;
expect(anchors(diffed) === 1, 'expected one scroll anchor at the diff boundary, got ' + anchors(diffed));
expect(anchors(firstCall) === 0, 'a first call has no boundary to anchor to, got ' + anchors(firstCall));
expect(anchors(sourced) === 1, 'the Turn boundary should be the anchor when there is no diff, got ' + anchors(sourced));
expect(
  diffed.text.join('').includes('8'),
  'the appended messages lost their array index',
);

/* A payload that shrank (compaction) must say so instead of silently marking
   everything as new. */
const shrunk = makeCall(2, 6, 9, 200);
shrunk.meta.diff = { prefix: 3, added: 6, removed: 4, rewritten: true, changed: ['maxTokens'], prevMessages: 7 };
const shrunkText = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), shrunk], 1) })).text.join(' ');
expect(shrunkText.includes('−4'), 'removed count missing on a compacted payload: ' + shrunkText.slice(0, 240));
expect(/消失|gone/.test(shrunkText), 'removed pill has no label');
expect(/原地改写|rewritten/.test(shrunkText), 'rewrite warning missing');
expect(/参数变化|params changed/.test(shrunkText), 'changed-parameter warning missing');

/* describeMessage must not print the JSON envelope it used to: tool calls are
   summarised as "name · argument", and duplicates are counted once. */
const internalsForDiff = internals;
const callMsg = {
  role: 'assistant',
  content: '{"type":"tool-call","id":"call_00_abc","name":"pwsh","arguments":"{\\"command\\":\\"git status\\"}"}',
  tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'pwsh', arguments: '{"command":"git status"}' } }],
};
const summary = internalsForDiff.describeMessage(callMsg);
expect(summary === 'pwsh · git status', 'tool-call summary wrong: ' + JSON.stringify(summary));
expect(!/"type":"tool-call"/.test(summary), 'summary still leaks the JSON envelope');
const twoCalls = {
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: 'a', function: { name: 'read', arguments: '{"file_path":"a.js"}' } },
    { id: 'b', function: { name: 'grep', arguments: '{"pattern":"TODO"}' } },
  ],
};
expect(/2 (个工具|tools)/.test(internalsForDiff.describeMessage(twoCalls)), 'multi-tool summary wrong');
expect(/read, grep|read, grep,/.test(internalsForDiff.describeMessage(twoCalls)), 'multi-tool names missing');

/* A rewrite must be surfaced, not silently reported as "appended". */
const rewrittenCall = makeCall(2, 6, 9, 200);
rewrittenCall.meta.diff = Object.assign({}, rewrittenCall.meta.diff, {
  removed: 3,
  rewritten: true,
  changed: ['model'],
});
const rewritten = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), rewrittenCall], 1) }));
const rewrittenText = rewritten.text.join(' ');
expect(/原地改写|rewritten in place/.test(rewrittenText), 'rewrite not reported');
expect(/消失|gone/.test(rewrittenText), 'removed count not reported');
expect(/参数变化|params changed/.test(rewrittenText), 'changed params not reported');

/* k) timeline: one segment per call, absent for a single call, and clicking a
      segment selects that call. */
const single = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100)]) }));
expect(
  !/本轮调用时间线|This Turn’s calls/.test(single.text.join(' ')),
  'timeline rendered for a single call',
);

const timed = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200), makeCall(3, 7, 11, 300)]) }));
const timedText = timed.text.join(' ');
expect(/本轮各步|This Turn’s steps/.test(timedText), 'timeline missing for 3 calls');
/* The bar must stay free of the per-call bookkeeping that the tab strip / step
   list already print: "heaviest" pills were removed because they duplicated
   `#k · step n · tokens`. */
expect(!/最重|heaviest/.test(timedText), 'duplicate heaviest-step pills are back');
/* The Turn's own token total now sits at the right of the bar head. */
expect(timedText.includes('600'), 'timeline lost the turn token total');

/* Drive the component directly: its track is a plain flex row of buttons, which
   the tree walker cannot single out by structure alone. */
const Timeline = internals.Timeline;
const usageOf = (total) => ({ input: total - 10, cache: 0, output: 10, total: total, hitRate: 0 });
const threeCalls = [
  { index: 1, meta: { index: 1, step: 5, usage: usageOf(1000), toolCalls: 1, toolResults: 1, toolNames: ['read'] } },
  { index: 2, meta: { index: 2, step: 6, usage: usageOf(3000), toolCalls: 3, toolResults: 2, toolNames: ['read', 'grep'] } },
  { index: 3, meta: { index: 3, step: 7, usage: usageOf(2000), toolCalls: 0, toolResults: 0, toolNames: [] } },
];
const track = findTrack(Timeline({ calls: threeCalls, selected: 2 }));
expect(track !== null, 'timeline track not found');
const segs = track ? track.props.children : [];
expect(segs.length === 3, 'expected 3 timeline segments, got ' + segs.length);
/* Width follows the tokens each step spent: 1000 / 3000 / 2000. */
const ratios = segs.map((seg) => String(seg.props.style.flex).split(' ')[0]);
expect(ratios.join(',') === '1000,3000,2000', 'segments not token-proportional: ' + ratios.join(','));
expect(String(segs[2].props.style.opacity) === '1', 'selected segment is not highlighted');
expect(String(segs[0].props.style.opacity) !== '1', 'unselected segments look selected');
/* The tooltip answers "where did the tokens go": step number, tokens, tool names.
   It must NOT carry the tool/round-trip counts — a normal Turn is one tool call
   per step, so "1 工具 · 1 往返" repeated on every segment said nothing. */
const tip = String(segs[1].props.title);
expect(!/工具|tools|往返|round-trips/.test(tip), 'segment tooltip still prints tool traffic: ' + tip);
expect(/3\s*(k|000)|3,000/.test(tip), 'tooltip missing tokens: ' + tip);
/* Tool names describe what the step PRODUCED; the tip addresses the request
   snapshot, so naming a tool there reads as "this request contains that call".
   The tip therefore stays to step + tokens. */
expect(!/read|grep/.test(tip), 'tooltip still names tools: ' + tip);
expect(Timeline({ calls: threeCalls.slice(0, 1), selected: 0 }) === null, 'timeline rendered for one call');

/* Nothing in the timeline names a tool or repeats tool traffic — the bar is
   about tokens per step, and every other count would duplicate the tab strip. */
const uniformCalls = [
  { index: 1, meta: { index: 1, step: 5, usage: usageOf(1000), toolCalls: 1, toolResults: 1, toolNames: ['read'] } },
  { index: 2, meta: { index: 2, step: 6, usage: usageOf(3000), toolCalls: 1, toolResults: 1, toolNames: ['read'] } },
  { index: 3, meta: { index: 3, step: 7, usage: usageOf(2000), toolCalls: 1, toolResults: 1, toolNames: ['read'] } },
];
const uniformFlat = walk(Timeline({ calls: uniformCalls, selected: 0 }));
const uniformText = uniformFlat.text.join(' ') + ' ' + uniformFlat.tips.join(' ');
expect(!/工具|tools|往返|round-trips|read|grep/.test(uniformText), 'timeline still prints tool traffic: ' + uniformText.slice(0, 200));
const varied = walk(Timeline({ calls: threeCalls, selected: 0 }));
const variedTip = varied.text.join(' ') + ' ' + varied.tips.join(' ');
expect(!/工具|tools|往返|round-trips/.test(variedTip), 'tool traffic still printed: ' + variedTip.slice(0, 200));

/* l) the error boundary: a payload that makes the body throw must still render
      an explanatory dialog instead of blanking the overlay. */
expect(typeof internals.boundary === 'function', 'error boundary not exposed');
const Boundary = internals.boundary();
expect(typeof Boundary === 'function', 'error boundary is not a component');
const healthy = walk(ReactStub.createElement(Boundary, null, 'body text'));
expect(healthy.text.join(' ').includes('body text'), 'boundary swallowed healthy children');
const caught = new Boundary({ children: 'body text' });
const derived = Boundary.getDerivedStateFromError(new Error('boom from the JSON pane'));
expect(typeof derived.failure === 'string' && derived.failure.includes('boom'), 'boundary did not capture the message');
caught.state = derived;
const failedTree = walk(caught.render());
const failedText = failedTree.text.join(' ');
expect(failedText.includes('boom from the JSON pane'), 'boundary did not print the failure: ' + failedText.slice(0, 120));
expect(/读取失败|Read failed/.test(failedText), 'boundary does not use the error wording');

/* m) tool cards: every entry of a `tool_calls` array is resolved by its id
      through the window-wide detail map, so one request can show calls made
      in earlier steps too. A call with no recorded result keeps its row and
      says so instead of silently vanishing. `all` mode expands the message
      objects too, which is the only way a `tool_calls` array becomes visible. */
function makeToolCall(byId, calls) {
  const toolCall = makeCall(1, 5, 4, 100);
  toolCall.request.messages.push({ role: 'assistant', content: null, tool_calls: calls });
  toolCall.meta.toolDetailsByCallId = byId;
  return toolCall;
}
/* `all` mode expands every container; that is the mode a reader uses to reach
   a `tool_calls` array, so the scenario renders in it. */
function allMode(helper) {
  return function render(node, sink) {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { sink.text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach((child) => render(child, sink)); return; }
    if (typeof node.type === 'function') { render(node.type(Object.assign({}, node.props, { mode: 'all' })), sink); return; }
    const className = node.props && node.props.className;
    if (typeof className === 'string') {
      sink.classes.push(className);
      if (typeof node.props.title === 'string') sink.tips.push(node.props.title);
    }
    (node.props.children || []).forEach((child) => render(child, sink));
  };
}
const walkAll = (element) => {
  const sink = { text: [], classes: [], tags: [], tips: [], dupeKeys: [], toggles: [] };
  allMode()(element, sink);
  return sink;
};
const toolRows = [
  { id: 'call_ok', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.js"}' } },
  { id: 'call_err', type: 'function', function: { name: 'pwsh', arguments: '{"command":"git nope"}' } },
  { id: 'call_missing', type: 'function', function: { name: 'grep', arguments: '{"pattern":"TODO"}' } },
];
const toolWalk = walkAll(
  DialogBody({
    payload: payload([
      makeToolCall(
        {
          call_ok: {
            callId: 'call_ok', name: 'read', argumentsText: '{"file_path":"a.js"}', argumentsJson: { file_path: 'a.js' },
            argumentsOk: true, summary: 'file_path=a.js', argumentsBytes: 24, status: 'ok', durationMs: 21, seq: 1, time: 0,
            result: { text: 'line one\nline two', bytes: 17, isError: false, seq: 2 },
          },
          call_err: {
            callId: 'call_err', name: 'pwsh', argumentsText: '{"command":"git nope"}', argumentsJson: { command: 'git nope' },
            argumentsOk: true, summary: 'command=git nope', argumentsBytes: 24, status: 'error', durationMs: 1300, seq: 3, time: 0,
            result: { text: 'boom', bytes: 4, isError: true, seq: 4 },
          },
          call_missing: {
            callId: 'call_missing', name: 'grep', argumentsText: '{"pattern":"TODO"}', argumentsJson: { pattern: 'TODO' },
            argumentsOk: true, summary: 'pattern=TODO', argumentsBytes: 18, status: 'missing', durationMs: null, seq: 5, time: 0, result: null,
          },
        },
        toolRows,
      ),
    ]),
  }),
);
const toolText = toolWalk.text.join(' ');
const toolTips = toolWalk.tips;
expect(/read\s*\(\s*file_path=a\.js\s*\)/.test(toolText), 'tool row lost the name/summary: ' + toolText.slice(-240));
expect(/pwsh\s*\(\s*command=git nope\s*\)/.test(toolText), 'second tool row lost its summary');
expect(/成功|\\bok\\b/.test(toolText), 'ok badge missing');
expect(/21ms/.test(toolText), 'ok badge lost the round-trip time');
expect(/失败|\\berror\\b/.test(toolText), 'error badge missing');
expect(/1\.3s/.test(toolText), 'error badge lost the round-trip time');
expect(/未返回|\bno result\b/.test(toolText), 'missing-result badge missing');
expect(/\b3 calls\b/.test(toolText), 'tool_calls header did not report its call count');
expect(/\b1 calls\b/.test(toolText), 'empty tool_calls array did not render its own count');
expect(toolWalk.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-toolbadge')).length === 4, 'expected 4 tool badges (3 detail rows + 1 fallback)');
/* A row's `title` is the raw arguments, so hovering shows them without a click;
   the badge carries the "click to expand" hint. */
expect(
  toolTips.some((tip) => tip.includes('file_path')) || toolText.includes('file_path=a.js'),
  'argument summary/tooltip missing on a tool row',
);
expect((toolTips.filter((tip) => /点击展开|click to expand/i.test(tip)) || []).length === 4, 'badge hint tooltip missing');

/* The fallback path: an entry with no detail at all still renders as `missing`
   from the entry's own function block (a request can carry calls this window
   has no records for, e.g. before the loaded history begins). */
const orphanWalk = walkAll(
  DialogBody({
    payload: payload([
      makeToolCall({}, [{ id: 'ghost', type: 'function', function: { name: 'edit', arguments: '{"path":"b.js"}' } }]),
    ]),
  }),
);
const orphanText = orphanWalk.text.join(' ');
expect(/edit\s*\(/.test(orphanText), 'orphan tool call did not fall back to the entry name: ' + orphanText.slice(-200));
expect(/未返回|\bno result\b/.test(orphanText), 'orphan tool call did not say its result is missing');
expect(
  orphanWalk.tips.some((tip) => tip.includes('b.js')) || orphanText.includes('b.js'),
  'orphan row lost the raw arguments: ' + JSON.stringify(orphanText.slice(-200)),
);

/* A `tool_calls` array with no detail map at all must still render, not throw. */
const bareToolCall = makeCall(1, 5, 4, 100);
bareToolCall.request.messages.push({
  role: 'assistant', content: null,
  tool_calls: [{ id: 'x', type: 'function', function: { name: 'read', arguments: '{}' } }],
});
const bareWalk = walkAll(DialogBody({ payload: payload([bareToolCall]) }));
expect(/read/.test(bareWalk.text.join(' ')), 'tool_calls without a detail map broke the JSON pane');

/* n) response view: the reply side is its own screen, so it is checked through
      its own component — the retry list (a failure is only legible if the attempt
      that died is shown), the rebuilt OpenAI body, and the switch that reaches it.
      A call with no reply must say so rather than render an empty tree. */
const replyMessage = {
  id: 'msg_reply',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Let me read the file.' },
    { type: 'tool-call', id: 'call_ok', name: 'read', arguments: '{"file_path":"a.js"}' },
  ],
  source: { kind: 'model', provider: 'vc-ds', model: 'deepseek-v4.1-flash' },
};
const replyUsage = { input: 12, cache: 2048, output: 8, total: 2068, hitRate: 0.99 };
const replyFinish = { kind: 'tool-calls', failure: null };
const replyResponse = {
  finish: replyFinish,
  attempts: [
    {
      seq: 11,
      finish: { kind: 'error', failure: { message: '502 upstream', code: 'SERVER', status: null } },
    },
  ],
  timing: { ttfbMs: 1240, spanMs: 830, records: 6, deltas: 5 },
  stats: internals.contentStatsOf(replyMessage),
  body: internals.responseBodyOf(replyMessage, replyUsage, 'deepseek-v4.1-flash', replyFinish),
};
const replyDetails = {
  call_ok: {
    callId: 'call_ok', name: 'read', argumentsText: '{"file_path":"a.js"}', argumentsJson: { file_path: 'a.js' },
    argumentsOk: true, summary: 'file_path=a.js', argumentsBytes: 24, status: 'ok', durationMs: 21, seq: 1, time: 0,
    result: { text: 'line one', bytes: 8, isError: false, seq: 2 },
  },
};
const replyWalk = walkAll(
  ResponsePanel({ response: replyResponse, mode: 'all', toolDetailsByCallId: replyDetails }),
);
const replyText = replyWalk.text.join(' ');
expect(/尝试\s*1|attempt\s*1/i.test(replyText), 'retry row missing: ' + replyText.slice(0, 200));
expect(/SERVER/.test(replyText), 'retry row lost the failure code');
expect(/502 upstream/.test(replyText), 'retry row lost the failure message');
expect(replyText.includes('Let me read the file.'), 'rebuilt body lost the reply text');
expect(
  replyWalk.classes.some((c) => c.split(/\s+/).includes('dsh-pl-toolbadge')),
  'the reply’s own tool_calls did not resolve to a tool badge',
);
expect(
  JSON.stringify(replyResponse.body).includes('"finish_reason":"tool_calls"'),
  'body finish_reason does not follow the finish kind',
);

const noReplyWalk = walkAll(ResponsePanel({ response: { ...replyResponse, body: null, stats: null } }));
expect(
  /没有这次调用的回复记录|No reply recorded/i.test(noReplyWalk.text.join(' ')),
  'a reply-less call did not say so',
);
expect(
  /没有这次调用的回复记录|No reply recorded/i.test(
    walkAll(ResponsePanel({ response: null })).text.join(' '),
  ),
  'a missing response object did not say so',
);

/* o) The 请求 / 响应 pair lives in the JSON pane's top-right corner; the picker
      holds the steps only. One pair for the whole dialog, bound to the selected
      step: flip the side and the pane swaps, the step selection stays. */

const sideCalls = [makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200, withSources.meta.sources), makeCall(3, 7, 11, 300)];
const giveReply = (target, id) => {
  target.meta.response = {
    finish: { kind: 'tool-calls', failure: null },
    attempts: [],
    timing: { ttfbMs: 412, spanMs: 2600, records: 12 },
    stats: { textChars: 10, reasoningChars: 0, toolCalls: 1, blocks: 2 },
    body: {
      id: id,
      object: 'chat.completion',
      model: 'deepseek-v4.1-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
  };
};
/* The last step gets no reply, so the dimmed half is testable. */
giveReply(sideCalls[0], 'chatcmpl-smoke-1');
giveReply(sideCalls[1], 'chatcmpl-smoke-2');

const gestureRoot = () => DialogBody({ payload: payload(sideCalls) });
const findKey = (node, key) => {
  if (!node || typeof node !== 'object') return null;
  if (node.key === key) return node;
  for (const child of (node.props && node.props.children) || []) {
    const found = findKey(child, key);
    if (found) return found;
  }
  return null;
};
const layoutTree = gestureRoot();
const paneLayout = findKey(layoutTree, 'pane');
expect(Boolean(paneLayout), 'JSON pane missing');
expect(
  paneLayout && paneLayout.props.children.map((child) => child.key).join(',') === 'pane-bar,row-meta,body',
  'summary must be inside the pane between the side selector and JSON body',
);
expect(!findKey(findKey(layoutTree, 'header'), 'row-meta'), 'summary is still in the dialog header');

/* The dialog is a fixed-height column: the header and the foot note may grow or
   shrink between 请求 and 响应, but the frame around them must not. Without that,
   the short reply and the long request make the modal jump on every switch. */
const frameHeight = layoutTree.props.style.height;
expect(frameHeight === '88vh', 'dialog height must be fixed, got ' + String(frameHeight));
const splitLayout = findKey(layoutTree, 'split');
expect(Boolean(splitLayout), 'the step column is not rendered as a sibling of the pane');
expect(
  splitLayout && splitLayout.props.children[0] && splitLayout.props.children[0].key === 'steps',
  'the left column is missing from the split',
);
expect(
  !findKey(layoutTree, 'tabs'),
  'the tab strip is still rendered above the split',
);
const beforeSink = mountWalk(gestureRoot);

const pairCount = beforeSink.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-side')).length;
expect(pairCount === 2, 'expected exactly one 请求/响应 pair in the pane, got ' + pairCount);
expect(
  beforeSink.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-side-on')).length === 1,
  'exactly one side should be selected',
);
expect(
  /请求|Request/.test(beforeSink.text.join(' ')) && /响应|Response/.test(beforeSink.text.join(' ')),
  'the side pair is not labelled',
);
expect(
  !beforeSink.classes.some((c) => c.split(/\s+/).includes('dsh-pl-seg')),
  'a switch is still rendered above the JSON',
);

const cardsOf = (sink) =>
  sink.buttons.filter((node) =>
    String((node.props || {}).className || '').split(/\s+/).includes('dsh-pl-stephit'),
  );
const cardCount = cardsOf(beforeSink).length;
expect(cardCount === 3, 'expected three step cards, got ' + cardCount);
expect(
  pairCount === 2 && cardCount === 3,
  'the pair is repeated per card instead of living once in the pane',
);

const pickStep = (sink, label) => cardsOf(sink).filter((node) => labelOf(node, 0).trim().startsWith(label))[0];

/* Selecting the reply-less step dims the 响应 half. */
const thirdCard = pickStep(beforeSink, '#3');
expect(Boolean(thirdCard), 'the third step card is missing');
thirdCard.props.onClick();
const thirdSink = rerender(gestureRoot);
expect(
  thirdSink.classes.some((c) => c.split(/\s+/).includes('dsh-pl-side-off')),
  'a step without a reply does not dim its 响应 button',
);

/* Selecting one that has a reply clears the dim. */
const secondCard = pickStep(thirdSink, '#2');
expect(Boolean(secondCard), 'the second step card is missing');
secondCard.props.onClick();
const secondSink = rerender(gestureRoot);
expect(
  !secondSink.classes.some((c) => c.split(/\s+/).includes('dsh-pl-side-off')),
  'a step that has a reply still dims its 响应 button',
);

/* The reply half is the one that reports a first byte, so that label is the
   marker for "which side is up" — the request half never carries it. */
const replyOpen = (sink) => /首字节|first byte/.test(sink.text.join(' '));
expect(!replyOpen(secondSink), 'the dialog did not open on the request side');
const sourcePanelVisible = (sink) => sink.classes.some((c) => c.split(/\s+/).includes('dsh-pl-sources'));
expect(sourcePanelVisible(secondSink), 'request source panel missing before switching');

const sideButton = (sink, pattern) =>
  sink.buttons.filter((node) => pattern.test(labelOf(node, 0).trim()))[0];

const responseButton = sideButton(secondSink, /^(响应|Response)$/);
expect(Boolean(responseButton), 'the pane has no 响应 button');
responseButton.props.onClick();
const afterSink = rerender(gestureRoot);
expect(replyOpen(afterSink), 'the request side is still on screen after clicking 响应');
expect(sourcePanelVisible(afterSink), 'request source panel disappeared on response');
expect(afterSink.barSegs === secondSink.barSegs, 'request source breakdown changed on response');
expect(
  /chatcmpl-smoke-2/.test(afterSink.text.join(' ')),
  'the reply of the selected step did not replace the request body',
);
expect(
  afterSink.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-side-on')).length === 1,
  'the selected side should still be exactly one after switching',
);
expect(
  Boolean(pickStep(afterSink, '#2')) &&
    String(pickStep(afterSink, '#2').props.className || '').split(/\s+/).includes('dsh-pl-stephit'),
  'the step selection was lost when the side changed',
);

/* ...and 请求 goes back, still on the same step. */
const requestButton = sideButton(afterSink, /^(请求|Request)$/);
expect(Boolean(requestButton), 'the pane has no 请求 button');
requestButton.props.onClick();
const backSink = rerender(gestureRoot);
expect(!replyOpen(backSink), 'switching back to 请求 did not restore the request body');
expect(sourcePanelVisible(backSink), 'request source panel missing after switching back');
expect(/messages/.test(backSink.text.join(' ')), 'the JSON tree is gone after switching back');

/* p) The pane's landing place: every step switch leaves exactly one anchor in the
      request document (so DialogBody has somewhere to scroll), and the response
      half has none — it carries no messages array. */
const anchorCount = (sink) => sink.ids.filter((id) => id === 'dsh-pl-diff').length;
expect(anchorCount(secondSink) === 1, 'step #2 has no scroll anchor on its request, got ' + anchorCount(secondSink));
expect(anchorCount(afterSink) === 0, 'the response half must not carry a request anchor, got ' + anchorCount(afterSink));
expect(anchorCount(backSink) === 1, 'coming back to 请求 lost the anchor, got ' + anchorCount(backSink));

/* The arithmetic behind that scroll, without a browser: a quarter of a tall
   viewport is the air above the line, a fixed 24 px in a short one, never
   negative, and it accounts for the pane already being scrolled. */
const rectAt = (top) => ({ getBoundingClientRect: () => ({ top: top }) });
const paneAt = (scrollTop, clientHeight, top) => ({
  scrollTop: scrollTop,
  clientHeight: clientHeight,
  getBoundingClientRect: () => ({ top: top }),
});
expect(internals.revealTop(paneAt(0, 800, 0), rectAt(1000)) === 800, 'tall pane: expected 1000 - 25% of 800');
expect(internals.revealTop(paneAt(0, 60, 0), rectAt(1000)) === 976, 'short pane: expected 1000 - 24');
expect(internals.revealTop(paneAt(0, 800, 0), rectAt(20)) === 0, 'a line near the top must not scroll negative');
expect(internals.revealTop(paneAt(500, 60, 0), rectAt(300)) === 776, 'an already-scrolled pane must add its offset');

/* ---------------------------------------------------------------- reporting */

console.log('dialog smoke: a=single b=three c=twenty d=scoped e=empty g=overlay h=turn-split i=sources j=diff k=timeline l=boundary m=tool-cards n=response o=pane-sides p=scroll-anchor');
if (problems.length === 0) {
  console.log('=== render smoke ok: 15 scenarios, no problem(s) ===');
} else {
  console.log('=== render smoke problems: ' + problems.length + ' ===');
  for (const problem of problems) console.log('  - ' + problem);
  process.exitCode = 1;
}






