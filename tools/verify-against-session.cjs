// verify-against-session.js — drive the real client.js pipeline against a real
// session log, without a browser.
//
//   node tools/verify-against-session.js [session.v4.jsonl.zstd]
//
// With no argument it picks the most recently written session log under
// %USERPROFILE%\.dsh\sessions. It reports, per Turn, how many model calls the
// plugin reconstructs, and prints the first call of the newest Turn in full so
// the payload can be eyeballed against the model's real request shape.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PLUGIN = path.join(__dirname, '..', 'client.js');

function newestSessionLog() {
  const root = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (/\.jsonl(\.zstd)?$/.test(item.name)) {
        try {
          found.push({ full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].full : null;
}

// ---- 1. read the log (it is a multi-frame zstd stream: split on magic bytes)
function loadEvents(file) {
  let text;
  if (file.endsWith('.zstd')) {
    const raw = fs.readFileSync(file);
    const offsets = [];
    for (let i = 0; i + 4 <= raw.length; i += 1) {
      if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
    }
    const chunks = [];
    for (let k = 0; k < offsets.length; k += 1) {
      const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
      try {
        chunks.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8'));
      } catch {}
    }
    text = chunks.join('');
  } else {
    text = fs.readFileSync(file, 'utf8');
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && typeof event.seq === 'number')
    .sort((a, b) => a.seq - b.seq);
}

// ---- 2. load the plugin the way the browser does (window.__ModuleLoader__)
function loadPlugin() {
  let mod = null;
  globalThis.__DSH_PAYLOAD_TEST__ = true;
  /* This harness only drives the pure pipeline; the dialog classes need nothing
     but a `Component` base to load, so hand React a minimal stand-in. */
  const reactStub = {
    Component: class Component {
      constructor(props) {
        this.props = props || {};
        this.state = {};
      }
    },
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useReducer: (reducer, value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect() {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    memo: (component) => component,
  };
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        mod = factory(() => reactStub);
      },
    },
  };
  const src = fs.readFileSync(PLUGIN, 'utf8');
  new Function('window', src)(globalThis.window);
  if (!mod) throw new Error('plugin did not register through window.__ModuleLoader__');
  const api = globalThis.__DSH_PAYLOAD_INTERNALS__;
  if (!api) throw new Error('internals hook missing');
  return api;
}

const log = process.argv[2] || newestSessionLog();
if (!log) {
  console.error('no session log found');
  process.exit(1);
}
console.log('log: ' + log);

const events = loadEvents(log);
console.log('events: ' + events.length);

const api = loadPlugin();
const flat = api.collectEvents(events.map((event) => ({ type: 'event', event })));
console.log('surface events: ' + flat.length);

/* A rebuilt Turn holds the ENTIRE conversation as message objects — megabytes per
   call. Every loop below rebuilds one Turn, checks it, then calls `release` so the
   heap stays flat; the session log is large enough to OOM otherwise. */
const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
function release(built) {
  if (!built) return;
  if (Array.isArray(built.calls)) {
    for (const call of built.calls) {
      if (call && call.request && Array.isArray(call.request.messages)) call.request.messages.length = 0;
    }
    built.calls.length = 0;
  }
  if (gc) gc();
}

/* Ground truth: the provider-reported usage of every answered call, per Turn. */
const logUsage = {};
for (const event of events) {
  if (event.type !== 'assistant/message') continue;
  const data = event.data || {};
  const usage = data.usage;
  if (!usage || typeof usage.totalTokens !== 'number') continue;
  const key = String(data.turn);
  logUsage[key] = (logUsage[key] || 0) + usage.totalTokens;
}

const counts = {};
let newest = null;
let prevTurnMessages = null;
const splitProblems = [];
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const built = api.buildTurnCalls(flat, turn, undefined, start.seq);
  const calls = (built && built.calls) || [];
  counts[turn] = calls.length;
  const sample = calls[calls.length - 1];
  let rebuilt = 0;
  let missing = 0;
  for (const item of calls) {
    if (item.meta && item.meta.usage && typeof item.meta.usage.total === 'number') rebuilt += item.meta.usage.total;
    else missing += 1;
  }
  const expected = logUsage[String(turn)] || 0;
  const verdict = rebuilt === expected ? 'ok' : 'MISMATCH';
  /* Every request tells the viewer where this Turn's own messages start.
     Invariants: inside the array, never shrinking as the Turn advances, and
     never less than what the previous Turn already carried as history. */
  let previousHistory = -1;
  for (const item of calls) {
    const end = item.meta.historyEnd;
    const total = item.meta.messages;
    if (typeof end !== 'number' || end < 0 || end > total)
      splitProblems.push('Turn ' + turn + ' #' + item.index + ': historyEnd ' + end + ' outside 0..' + total);
    else if (end < previousHistory)
      splitProblems.push('Turn ' + turn + ' #' + item.index + ': historyEnd ' + end + ' < previous ' + previousHistory);
    previousHistory = end;
  }
  const firstCall = calls[0];
  if (firstCall && prevTurnMessages !== null && firstCall.meta.historyEnd < prevTurnMessages)
    splitProblems.push(
      'Turn ' + turn + ' first call historyEnd ' + firstCall.meta.historyEnd + ' < previous Turn messages ' + prevTurnMessages,
    );
  if (sample) prevTurnMessages = sample.meta.messages;
  const split = firstCall && sample
    ? '  history: first ' + firstCall.meta.historyEnd + '/' + firstCall.meta.messages +
      ' last ' + sample.meta.historyEnd + '/' + sample.meta.messages
    : '';
  console.log(
    'Turn ' + String(turn).padStart(2) + ' -> ' + String(calls.length).padStart(3) + ' call(s)' +
      (sample
        ? '  last: msgs=' + sample.request.messages.length +
          ' tools=' + sample.request.tools.length +
          ' model=' + sample.meta.model
        : '') +
      '  tokens=' + rebuilt + ' vs log=' + expected + ' ' + verdict +
      (missing ? ' (no usage on ' + missing + ' call(s))' : '') +
      split,
  );
  if (calls.length) newest = { turn, call: sample };
  /* Keep only the newest Turn alive for the summary print below; free the rest. */
  if (turn !== newest.turn) release(built);
}

/* Source provenance: every rebuilt message must be classified exactly once, so
   the breakdown the dialog shows can never disagree with the message count. */
const sourceProblems = [];
let sourceCalls = 0;
const familyTotals = { prompt: 0, injected: 0, model: 0, tool: 0, other: 0 };
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const built = api.buildTurnCalls(flat, turn);
  if (!built) continue;
  for (const item of built.calls) {
    const meta = item.meta || {};
    const sources = meta.sources;
    const fresh = meta.freshSources;
    if (!sources || !sources.counts) {
      sourceProblems.push('Turn ' + turn + ' #' + item.index + ': no source summary');
      continue;
    }
    sourceCalls += 1;
    const sum = ['prompt', 'injected', 'model', 'tool', 'other'].reduce(
      (acc, key) => acc + (sources.counts[key] || 0),
      0,
    );
    if (sum !== meta.messages)
      sourceProblems.push('Turn ' + turn + ' #' + item.index + ': families sum ' + sum + ' != messages ' + meta.messages);
    const freshSum = ['prompt', 'injected', 'model', 'tool', 'other'].reduce(
      (acc, key) => acc + ((fresh && fresh.counts[key]) || 0),
      0,
    );
    const expectedFresh = meta.messages - meta.historyEnd;
    if (freshSum !== expectedFresh)
      sourceProblems.push(
        'Turn ' + turn + ' #' + item.index + ': fresh sum ' + freshSum + ' != messages-historyEnd ' + expectedFresh,
      );
    if (!(meta.freshBytes >= 0))
      sourceProblems.push('Turn ' + turn + ' #' + item.index + ': freshBytes ' + meta.freshBytes);
    for (const key of Object.keys(familyTotals)) familyTotals[key] += sources.counts[key] || 0;
  }
}

console.log('\n=== source breakdown: ' + sourceCalls + ' call(s), ' + sourceProblems.length + ' problem(s) ===');
console.log('  messages by family: ' + JSON.stringify(familyTotals));
for (const item of sourceProblems.slice(0, 10)) console.log('  ' + item);
if (!sourceProblems.length)
  console.log('  every message is classified exactly once; fresh = messages - historyEnd');

/* Adjacent-call diff: the first call of a Turn has nothing to compare against,
   and a later call's diff must reconcile with the two message arrays — the
   unchanged prefix plus what was appended (and removed) is the whole story. */
const diffProblems = [];
let diffCalls = 0;
let rewrittenCalls = 0;
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const built = api.buildTurnCalls(flat, turn);
  if (!built) continue;
  for (let i = 0; i < built.calls.length; i += 1) {
    const item = built.calls[i];
    const diff = item.meta && item.meta.diff;
    if (i === 0) {
      if (diff) diffProblems.push('Turn ' + turn + ' #1: first call should have no diff');
      continue;
    }
    if (!diff) {
      diffProblems.push('Turn ' + turn + ' #' + item.index + ': missing diff');
      continue;
    }
    diffCalls += 1;
    const prev = built.calls[i - 1].request.messages.length;
    if (diff.prevMessages !== prev)
      diffProblems.push('Turn ' + turn + ' #' + item.index + ': prevMessages ' + diff.prevMessages + ' != ' + prev);
    if (!(diff.prefix >= 0 && diff.prefix <= Math.min(prev, item.meta.messages)))
      diffProblems.push('Turn ' + turn + ' #' + item.index + ': prefix ' + diff.prefix + ' out of range');
    if (diff.prefix + diff.added.length !== item.meta.messages)
      diffProblems.push(
        'Turn ' + turn + ' #' + item.index + ': prefix+added ' + (diff.prefix + diff.added.length) + ' != messages ' + item.meta.messages,
      );
    if (diff.rewritten) rewrittenCalls += 1;
    /* Inside one Turn the request only grows at the tail unless something was
       compacted, so a rewrite must be reported as such, not as appended. */
    if (!diff.rewritten && diff.removed > 0)
      diffProblems.push('Turn ' + turn + ' #' + item.index + ': removed ' + diff.removed + ' without a rewrite');
    for (const entry of diff.added) {
      const message = item.request.messages[entry.index];
      if (!message) diffProblems.push('Turn ' + turn + ' #' + item.index + ': added index ' + entry.index + ' out of range');
      else if (message.role !== entry.role)
        diffProblems.push('Turn ' + turn + ' #' + item.index + ': added role ' + entry.role + ' != ' + message.role);
    }
  }
  /* One Turn's rebuilt requests already hold the whole conversation; release
     them before the next rebuild or the heap grows without bound. */
  release(built);
}

console.log('\n=== adjacent-call diff: ' + diffCalls + ' call(s), ' + diffProblems.length + ' problem(s) ===');
for (const item of diffProblems.slice(0, 10)) console.log('  ' + item);
if (!diffProblems.length)
  console.log(
    '  prefix + added = messages on every non-first call; rewrites counted: ' + rewrittenCalls,
  );

/* Timeline frames: every call must know the seq span of its own step, the span
   must be non-empty and ordered, and steps must not overlap (each `step/start`
   opens exactly one call). */
const frameProblems = [];
let frameCalls = 0;
let longest = { step: 0, turn: 0, span: 0 };
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const built = api.buildTurnCalls(flat, turn);
  if (!built) continue;
  let prevStart = -1;
  for (const item of built.calls) {
    const meta = item.meta || {};
    if (typeof meta.startSeq !== 'number' || typeof meta.endSeq !== 'number') {
      frameProblems.push('Turn ' + turn + ' #' + item.index + ': missing step frame');
      continue;
    }
    frameCalls += 1;
    if (meta.endSeq < meta.startSeq)
      frameProblems.push('Turn ' + turn + ' #' + item.index + ': endSeq ' + meta.endSeq + ' < startSeq ' + meta.startSeq);
    if (meta.startSeq <= prevStart)
      frameProblems.push('Turn ' + turn + ' #' + item.index + ': startSeq ' + meta.startSeq + ' <= previous ' + prevStart);
    prevStart = meta.startSeq;
    const span = meta.endSeq - meta.startSeq + 1;
    if (span > longest.span) longest = { step: meta.step, turn, span };
  }
  release(built);
}

console.log('\n=== step frames: ' + frameCalls + ' call(s), ' + frameProblems.length + ' problem(s) ===');
for (const item of frameProblems.slice(0, 10)) console.log('  ' + item);
if (!frameProblems.length)
  console.log(
    '  every call carries startSeq<=endSeq and steps never overlap; widest step: turn ' +
      longest.turn + ' step ' + longest.step + ' spans ' + longest.span + ' record(s)',
  );

/* Response side: every call must describe the reply that actually followed it.
   Checked against the log, not against the plugin's own intermediate values:
   the finish reason, the reply text, the tool-call ids, the usage and the retry
   count all come from the step's own records, and each of the reply's tool calls
   must resolve to the result recorded later in the same Turn. */
const replyProblems = [];
const replyKinds = new Map();
let replyCalls = 0;
let replyBytes = 0;
let replyFailures = 0;
const resultCallIds = new Set();
for (const event of flat) {
  if (event.type !== 'tool/result') continue;
  const message = (event.data && event.data.message) || {};
  const id =
    message.toolCallId !== undefined
      ? message.toolCallId
      : message.source && message.source.callId !== undefined
        ? message.source.callId
        : undefined;
  if (id !== undefined) resultCallIds.add(String(id));
}

for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data.turn;
  const expected = new Map();
  for (const event of flat) {
    const data = event.data;
    if (!data || data.turn !== turn) continue;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    const step = data.step;
    const entry = expected.get(step) || {
      text: '',
      toolIds: [],
      usage: null,
      finish: null,
      attempts: 0,
      hasMessage: false,
    };
    if (event.type === 'assistant/message') {
      const blocks = data.message && Array.isArray(data.message.content) ? data.message.content : [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') entry.text += block.text;
        else if (block.type === 'tool-call' && block.id !== undefined) entry.toolIds.push(String(block.id));
      }
      entry.usage = data.usage || null;
      const finish = api.finishOfStream(data.stream);
      entry.finish = finish ? finish.kind : null;
      entry.hasMessage = true;
    } else {
      entry.attempts += 1;
      /* A step can end with attempts only. Then the last attempt that reported a
         finish is what stopped it — mirroring `lastFinishOf` in the plugin. */
      if (!entry.hasMessage) {
        const finish = api.finishOfStream(data.stream);
        if (finish) entry.finish = finish.kind;
      }
    }
    expected.set(step, entry);
  }

  const built = api.buildTurnCalls(flat, turn);
  if (!built) continue;
  for (const item of built.calls) {
    const meta = item.meta || {};
    const response = meta.response;
    const want = expected.get(meta.step);
    replyCalls += 1;
    if (!want) {
      replyProblems.push('Turn ' + turn + ' #' + item.index + ': no reply record for step ' + meta.step);
      continue;
    }
    if (!response) {
      replyProblems.push('Turn ' + turn + ' #' + item.index + ': meta.response missing');
      continue;
    }
    const kind = response.finish && response.finish.kind ? response.finish.kind : null;
    replyKinds.set(kind, (replyKinds.get(kind) || 0) + 1);
    if (kind !== want.finish) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': finish ' + kind + ' != log ' + want.finish,
      );
    }
    if ((response.attempts || []).length !== want.attempts) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': attempts ' + (response.attempts || []).length +
          ' != log ' + want.attempts,
      );
    }
    if (!want.hasMessage) {
      /* A step that never produced a reply must say so instead of inventing one. */
      if (response.body !== null) {
        replyProblems.push('Turn ' + turn + ' #' + item.index + ': body for a reply-less step');
      }
      if (response.stats !== null) {
        replyProblems.push('Turn ' + turn + ' #' + item.index + ': stats for a reply-less step');
      }
      replyFailures += 1;
      continue;
    }
    if (!response.stats || response.stats.textChars !== want.text.length) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': text chars ' +
          (response.stats ? response.stats.textChars : 'none') + ' != log ' + want.text.length,
      );
    }
    const choice = response.body && Array.isArray(response.body.choices) ? response.body.choices[0] : null;
    if (!choice) {
      replyProblems.push('Turn ' + turn + ' #' + item.index + ': rebuilt body has no choices[0]');
      continue;
    }
    const bodyText = choice.message && choice.message.content !== null && choice.message.content !== undefined
      ? choice.message.content
      : '';
    if (bodyText !== want.text) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': body text ' + bodyText.length + ' != log ' + want.text.length,
      );
    }
    const bodyIds = (choice.message && Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [])
      .map((call) => String(call.id));
    if (bodyIds.join(',') !== want.toolIds.join(',')) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': body tool_calls [' + bodyIds.join(',') + '] != log [' +
          want.toolIds.join(',') + ']',
      );
    }
    if (want.usage && meta.usage && typeof meta.usage.total === 'number' && meta.usage.total !== want.usage.totalTokens) {
      replyProblems.push(
        'Turn ' + turn + ' #' + item.index + ': body usage ' + meta.usage.total + ' != log ' + want.usage.totalTokens,
      );
    }
    /* A reply's own tool calls must show their outcome, not a `missing` badge. */
    for (const id of want.toolIds) {
      if (!resultCallIds.has(id)) continue;
      const detail = meta.toolDetailsByCallId ? meta.toolDetailsByCallId[id] : null;
      if (!detail) {
        replyProblems.push('Turn ' + turn + ' #' + item.index + ': no detail for reply tool call ' + id);
      } else if (detail.status === 'missing') {
        replyProblems.push('Turn ' + turn + ' #' + item.index + ': reply tool call ' + id + ' still missing its result');
      }
    }
    replyBytes += response.body ? JSON.stringify(response.body).length : 0;
  }
  release(built);
}

console.log('\n=== responses: ' + replyCalls + ' call(s), ' + replyProblems.length + ' problem(s) ===');
for (const item of replyProblems.slice(0, 10)) console.log('  ' + item);
if (!replyProblems.length) {
  console.log(
    '  finish reason, reply text, tool-call ids, usage and retry count all match the log; ' +
      'rebuilt bodies total ' + replyBytes.toLocaleString('en-US') + ' bytes',
  );
  console.log(
    '  finish reasons: ' +
      [...replyKinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => (kind === null ? 'none' : kind) + '=' + count)
        .join(', '),
  );
  console.log(
    '  ' + replyFailures + ' step(s) produced no reply at all (attempts only) and report that instead',
  );
}

console.log(
  '\n=== turn/current split: ' + splitProblems.length + ' problem(s) ===',
);for (const item of splitProblems.slice(0, 10)) console.log('  ' + item);
if (!splitProblems.length)
  console.log('  historyEnd stays inside messages, never shrinks, and carries the previous Turn');

if (newest) {
  console.log('\n=== Turn ' + newest.turn + ' last call: request keys ===');
  console.log(JSON.stringify(Object.keys(newest.call.request)));
  console.log('usage: ' + JSON.stringify(newest.call.meta.usage));
  console.log('\n=== messages (role, tool_calls, content head) ===');
  newest.call.request.messages.forEach((message, index) => {
    const head =
      typeof message.content === 'string'
        ? message.content.replace(/\s+/g, ' ').slice(0, 70)
        : JSON.stringify(message.content).slice(0, 70);
    console.log(
      String(index).padStart(2) + ' ' + message.role.padEnd(9) +
        (message.tool_calls ? 'tc=' + message.tool_calls.length + ' ' : '') + head,
    );
  });
}

/* The per-message button starts from a durable message id, so prove that every
   assistant message resolves to exactly one rebuilt call, on its own step.
   Turns are rebuilt once and dropped again: the rebuilt requests hold the whole
   prompt per call, and keeping all 55 Turns alive exhausted the default heap. */
let mapped = 0;
let unmapped = 0;
const bad = [];
const spotByTurn = new Map();
for (const event of flat) {
  if (event.type !== 'assistant/message') continue;
  const id = event.data && event.data.message && event.data.message.id;
  if (!id) continue;
  const spot = api.locateMessage(flat, id);
  if (!spot) {
    unmapped += 1;
    bad.push({ id, why: 'locateMessage returned null' });
    continue;
  }
  if (spotByTurn.has(spot.turn)) {
    spotByTurn.get(spot.turn).push({ id, step: spot.step });
  } else {
    spotByTurn.set(spot.turn, [{ id, step: spot.step }]);
  }
}
for (const [turn, spots] of spotByTurn) {
  const built = api.buildTurnCalls(flat, turn) || { calls: [] };
  for (const spot of spots) {
    const index = api.callIndexForStep(built, spot.step);
    const call = built.calls[index];
    if (!call) {
      unmapped += 1;
      bad.push({ id: spot.id, why: 'Turn ' + turn + ' rebuilt no calls' });
      continue;
    }
    const callStep = call.meta && call.meta.step;
    if (callStep !== spot.step) {
      bad.push({ id: spot.id, why: 'step ' + spot.step + ' resolved to call of step ' + callStep });
      continue;
    }
    mapped += 1;
  }
  release(built);
}

console.log(
  '\n=== message -> call mapping: ' + mapped + ' mapped, ' + unmapped + ' unmapped, ' +
    bad.length + ' problem(s) ===',
);
for (const item of bad.slice(0, 10)) console.log('  ' + item.id + ': ' + item.why);
if (!bad.length) console.log('  every assistant message resolves to its own step call');

/* The JSON→conversation cross-link depends on `meta.messageLinks` being exactly
   as long as `request.messages`, and on every assistant message resolving to the
   node key the chat plugin publishes: `14:assistant-step<turn>:<step>`. Tool
   results must resolve to `9:tool-call<callId>`, and every user/system/developer
   row to `13:input-message<id>`. Proved against the rebuilt requests, one Turn
   at a time so the heap stays flat. */
let linkCalls = 0;
const linkProblems = [];
for (const start of flat.filter((event) => event.type === 'turn/start')) {
  const turn = start.data && start.data.turn;
  const built = api.buildTurnCalls(flat, turn);
  if (!built || !built.calls) continue;
  for (const item of built.calls) {
    linkCalls += 1;
    const links = item.meta && item.meta.messageLinks;
    const messages = item.request && item.request.messages;
    if (!Array.isArray(links)) {
      linkProblems.push('Turn ' + turn + ' #' + item.index + ': no messageLinks array');
      continue;
    }
    if (links.length !== messages.length) {
      linkProblems.push(
        'Turn ' + turn + ' #' + item.index + ': messageLinks ' + links.length + ' vs messages ' + messages.length,
      );
      continue;
    }
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const link = links[i];
      if (message.role === 'assistant') {
        /* Which step produced this message is a property of the MESSAGE, not of
           the call being inspected: a request carries the replies of every
           earlier step of the Turn too, and each of those links to its own
           bubble. So the expected key comes from the message's own
           `data.turn`/`data.step`, mirrored from the same `assistant-step`
           formula the chat plugin publishes. */
        const own = message.__origin;
        if (!own || typeof own.turn !== 'number' || typeof own.step !== 'number') {
          continue;
        }
        const want = '14:assistant-step' + own.turn + ':' + own.step;
        if (!link || link.key !== want) {
          linkProblems.push('Turn ' + turn + ' #' + item.index + ' msg ' + i + ': assistant link ' + (link ? link.key : 'null') + ' != ' + want);
          break;
        }
      } else if (message.role === 'tool') {
        const want = message.tool_call_id !== undefined ? '9:tool-call' + message.tool_call_id : null;
        if (want === null) continue;
        if (!link || link.key !== want) {
          linkProblems.push('Turn ' + turn + ' #' + item.index + ' msg ' + i + ': tool link ' + (link ? link.key : 'null') + ' != ' + want);
          break;
        }
      } else if (link && !/^13:input-message/.test(link.key)) {
        linkProblems.push('Turn ' + turn + ' #' + item.index + ' msg ' + i + ': unexpected link ' + link.key);
        break;
      }
    }
  }
  /* The rebuilt prompt of a Turn is the whole conversation: drop it before the
     next rebuild or the harness exhausts the heap on a long session. */
  release(built);
}

console.log('\n=== cross-links: ' + linkCalls + ' call(s), ' + linkProblems.length + ' problem(s) ===');
for (const item of linkProblems.slice(0, 10)) console.log('  ' + item);
if (!linkProblems.length)
  console.log('  every message carries the conversation node key the chat plugin publishes');


