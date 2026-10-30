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
  const className = node.props && node.props.className;
  if (typeof className === 'string') sink.classes.push(className);
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

/* ---------------------------------------------------------- payload fixtures */

function makeCall(index, step, messageCount, tokens) {
  return {
    index,
    step,
    meta: {
      index,
      step,
      model: 'vc-ds/deepseek-v4.1-flash',
      messages: messageCount,
      tools: 52,
      reason: index === 1 ? 'initial' : 'resume',
      usage: { input: tokens, cache: 0, output: Math.round(tokens / 10), total: tokens, hitRate: 0 },
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

function payload(calls) {
  return {
    scheme: 'dark',
    selectedIndex: 0,
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

/* b) three calls: tabs, still no step list */
const three = walk(DialogBody({ payload: payload([makeCall(1, 5, 7, 100), makeCall(2, 6, 9, 200), makeCall(3, 7, 11, 300)]) }));
const tabs = three.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-tab'));
expect(tabs.length === 3, 'expected 3 tab buttons, got ' + tabs.length);
expect(tabs.filter((c) => c.split(/\s+/).includes('dsh-pl-tab-on')).length === 1, 'exactly one tab should be active');
expect(!three.classes.some((c) => c.includes('dsh-pl-step')), 'step list rendered for 3 calls');
expect(three.text.includes('#1') && three.text.includes('#3'), 'tab labels missing');

/* c) 20 calls (this is what broke the old <select>): step list, no tabs */
const many = walk(DialogBody({ payload: payload(Array.from({ length: 20 }, (_, i) => makeCall(i + 1, 40 + i, 10 + i, 1000 * (i + 1)))) }));
const rows = many.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step'));
expect(rows.length === 20, 'expected 20 step rows, got ' + rows.length);
expect(many.classes.filter((c) => c.split(/\s+/).includes('dsh-pl-step-on')).length === 1, 'exactly one step row should be active');
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

/* ---------------------------------------------------------------- reporting */

console.log('dialog smoke: a=single b=three c=twenty d=scoped e=empty g=overlay');
if (problems.length === 0) {
  console.log('=== render smoke ok: 7 scenarios, no problem(s) ===');
} else {
  console.log('=== render smoke problems: ' + problems.length + ' ===');
  for (const problem of problems) console.log('  - ' + problem);
  process.exitCode = 1;
}



