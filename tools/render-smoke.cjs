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
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useReducer(reducer, initial) {
    return [initial, () => {}];
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
    render(node.type(node.props), sink);
    return;
  }
  /* The source bar's segments carry no class of their own; count its children. */
  if (node.type === 'div' && node.props && node.props.title === undefined
      && Array.isArray(node.props.children) && node.props.children.length > 0
      && node.props.children.every((c) => c && c.type === 'div' && c.props && typeof c.props.title === 'string'
        && /·\s*\d+$/.test(c.props.title))) {
    sink.barSegs = node.props.children.length;
  }
  const className = node.props && node.props.className;
  if (typeof className === 'string') {
    sink.classes.push(className);
  }
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
  const sink = { text: [], classes: [], tags: [], dupeKeys: [] };
  render(element, sink);
  return sink;
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
              prefix: messageCount - 2,
              added: [
                { index: messageCount - 2, role: 'assistant', head: 'I will read it.' },
                { index: messageCount - 1, role: 'tool', head: 'file contents…' },
              ],
              removed: 0,
              rewritten: false,
              changed: [],
              prevMessages: messageCount - 2,
            },
    },
    request: {
      model: 'deepseek-v4.1-flash',
      provider: 'vc-ds',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'step ' + step + ' question' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', name: 'read', arguments: '{"a":1}' }] },
      ],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    },
  };
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

/* a) single call: no tab strip, no step list, chips + JSON visible */
const one = walk(DialogBody({ payload: payload([makeCall(1, 1, 7, 14056)]) }));
expect(!one.classes.some((c) => c.includes('dsh-pl-tab')), 'tab strip rendered for a single call');
expect(!one.classes.some((c) => c.includes('dsh-pl-step')), 'step list rendered for a single call');
expect(one.text.join(' ').includes('deepseek-v4.1-flash'), 'model chip missing');
expect(one.text.join(' ').includes('messages'), 'JSON body not rendered');

/* b) three calls: tabs, still no step list (the timeline's pills are dsh-pl-heavy) */
const three = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200), makeCall(3, 7, 11, 300)]) }));
const tabs = three.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-tab'));
expect(tabs.length === 3, 'expected 3 tab buttons, got ' + tabs.length);
expect(tabs.filter((c) => c.split(/\s+/).includes('dsh-pl-tab-on')).length === 1, 'exactly one tab should be active');
expect(
  !three.classes.some((c) => c.split(/\s+/).includes('dsh-pl-step')),
  'step list rendered for 3 calls',
);
expect(three.text.includes('#1') && three.text.includes('#3'), 'tab labels missing');

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
expect(open.classes.some((c) => c.includes('dsh-pl-tab')), 'overlay did not render the tab strip');
expect(openText.includes('#1 / 2'), 'overlay dialog lost the call chip');

internals.publishDialog({ status: 'error', title: '本轮发送给模型的完整请求', message: 'sessions service unavailable' });
const failed = walk(overlay({}));
expect(failed.text.join(' ').includes('sessions service unavailable'), 'error state did not surface the message');

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

/* j) diff: the first call says there is nothing to compare, later calls list
      what got appended, and a rewritten payload is called out as such. */
const firstCall = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100)]) }));
expect(
  /本轮第一次调用|first call of this Turn/.test(firstCall.text.join(' ')),
  'first call should say there is no previous call to compare',
);

const diffed = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200)], 1) }));
const diffedText = diffed.text.join(' ');
expect(/新增|added/.test(diffedText), 'added chip missing from the diff panel');
expect(diffedText.includes('+2'), 'expected +2 added messages, got ' + diffedText.slice(0, 200));
expect(diffedText.includes('I will read it.'), 'appended assistant head missing');
expect(diffedText.includes('file contents'), 'appended tool head missing');
expect(!/消失|gone/.test(diffedText), 'removed chip should not appear when nothing was removed');

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
expect(/最重|heaviest/.test(timedText), 'heaviest-step pills missing');

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
/* The tooltip must describe the work, not the log extent. */
const tip = String(segs[1].props.title);
expect(/3\s*(工具|tools)/.test(tip), 'tooltip missing tool count: ' + tip);
expect(/2\s*(往返|round-trips)/.test(tip), 'tooltip missing round-trips: ' + tip);
expect(/3\s*(k|000)|3,000/.test(tip), 'tooltip missing tokens: ' + tip);
expect(Timeline({ calls: threeCalls.slice(0, 1), selected: 0 }) === null, 'timeline rendered for one call');

/* ---------------------------------------------------------------- reporting */

console.log('dialog smoke: a=single b=three c=twenty d=scoped e=empty g=overlay h=turn-split i=sources j=diff k=timeline');
if (problems.length === 0) {
  console.log('=== render smoke ok: 11 scenarios, no problem(s) ===');
} else {
  console.log('=== render smoke problems: ' + problems.length + ' ===');
  for (const problem of problems) console.log('  - ' + problem);
  process.exitCode = 1;
}



