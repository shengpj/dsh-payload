/**
 * Payload Inspector — a Client-half plugin that adds one icon button to the
 * per-message action row under every finalized assistant reply (next to the
 * shipped copy / good / bad actions), and shows the full request payload the
 * model call that produced that reply was built from:
 *
 *   { model, provider, <call controls>, messages: [...], tools: [...] }
 *
 * Everything is read from the session event log that the Web GUI already holds
 * (`request/header` carries the epoch config + tool schemas, surface events carry
 * the messages). Nothing is re-sent and nothing is folded eagerly: the read
 * happens once, on the click, and is cached for the lifetime of that dialog.
 */

window.__ModuleLoader__.load({
  id: 'dsh-payload',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Surface event type -> the role that event contributes to the model request. */
    const SURFACE_ROLES = {
      'system/message': 'system',
      'developer/message': 'developer',
      'user/message': 'user',
      'assistant/message': 'assistant',
      'tool/result': 'tool',
    };

    const ZH = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '');
    const TEXT = ZH
      ? {
          show: '查看请求 JSON',
          copy: '复制',
          copied: '已复制',
          loading: '正在读取本轮请求…',
          empty: '这一轮没有记录到模型调用。',
          error: '读取失败：',
          title: '本轮发送给模型的完整请求',
          messages: '条消息',
          tools: '个工具',
          copyAll: '复制全部调用',
          usageInput: '输入',
          usageCache: '缓存',
          usageOutput: '输出',
          usageTotal: '合计',
          turnTotal: '本轮合计',
          usageNone: '未记录到用量',
          usageInputTitle:
            '未命中前缀缓存的 prompt tokens。真正的 prompt 总量 = 输入 + 缓存，不是这份 JSON 的字节数。',
          usageCacheTitle:
            '命中前缀缓存、无需重新计费的 prompt tokens（括号内是命中率）。与「输入」相加才是完整 prompt。',
          usageOutputTitle: '模型本次生成的 tokens。',
          usageTotalTitle: '本次调用 tokens 合计 = 输入 + 缓存 + 输出，按这个数计费。',
          turnTotalTitle: '本轮（Turn）所有调用累加，含每一次工具往返。',
          bytesLabel: '请求体',
          bytesTitle:
            '这份重建结果 JSON.stringify 后的字节数。字节 ≠ token（中文约 1 token ≈ 1–2 字节），也不等于模型实际收到的量。',
          messagesTitle:
            '会话日志里这次请求携带的历史条数。实际发出的内容会先经上下文压缩，故条数通常大于模型真正读到的量。',
          compressNote:
            '条数与「请求体」来自会话日志；实际发出的内容会先经上下文压缩折叠，token 用量以「输入 + 缓存」为准。',
          history: '历史',
          currentTurn: '本轮',
          historyGroup: '历史消息',
          folded: '已折叠',
          historyTitle:
            '这些消息产生于更早的轮次，默认折叠；展开后仍是数组里的真实下标。',
          currentTitle: '本轮对话（含本轮注入的上下文与工具往返）新产生的消息。',
          callPrefix: '第 ',
          callSuffix: ' 次调用',
          reasonLabel: '触发原因',
          expandAll: '展开全部',
          collapseAll: '折叠全部',
          toTop: '顶部',
          toEnd: '末尾',
          railTitle: '拖动滚动条可直达任意位置',
          close: '关闭',
          sourceTitle:
            '这份请求由什么组成：你输入的话、harness 自动注入的上下文、模型回复、工具往返。占比是"消息字节"占比，非 token。',
          sourceFamilyPrompt: '你的输入',
          sourceFamilyInjected: '自动注入',
          sourceFamilyModel: '模型回复',
          sourceFamilyTool: '工具往返',
          sourceFamilyOther: '其他',
          sourceFresh: '本轮新增',
          sourceFreshTitle: '其中由本轮写进请求的部分（其余是历史携带）。',
          sourceKindUser: '用户消息',
          sourceKindApproval: '审批交互',
          sourceKindTimeContext: '时间上下文',
          sourceKindRuntimeContext: '运行时上下文',
          sourceKindSkillCatalog: '技能目录',
          sourceKindModelSelection: '模型选择',
          sourceKindSystemPrompt: '系统提示词',
          sourceKindToolRegistry: '工具登记',
          sourceKindModel: '模型回复',
          sourceKindTool: '工具结果',
          sourceKindJobReport: '后台任务回报',
          sourceKindOther: '未标注来源',
          diffTitle: '相比上一次调用',
          diffAdded: '新增',
          diffRemoved: '消失',
          diffRewritten: '原地改写',
          diffChanged: '参数变化',
          diffSame: '与上一次调用完全相同',
          diffFirst: '本轮第一次调用，没有可比较的上一次',
          diffPrevTitle: '上一次调用',
          timelineTitle: '本轮各步',
          timelineHint: '每段是一步，宽度按该步消耗的 token；点一段切到那次调用',
          timelineSelected: '当前',
          timelineHeaviest: '最重',
          timelineHeavyTitle: '按 token 排序的前几步，点击切换',
          stepWord: 'step',
          toolCount: '工具',
          toolNone: '无工具',
          roundTrips: '往返',
          tokens: 'token',
          noUsage: '无用量',
        }
      : {
          show: 'Request JSON',
          copy: 'Copy',
          copied: 'Copied',
          loading: 'Reading this turn’s request…',
          empty: 'No model call recorded for this turn.',
          error: 'Read failed: ',
          title: 'Full request sent to the model for this turn',
          messages: 'messages',
          tools: 'tools',
          copyAll: 'Copy all calls',
          usageInput: 'input',
          usageCache: 'cached',
          usageOutput: 'output',
          usageTotal: 'total',
          turnTotal: 'turn total',
          usageNone: 'no usage recorded',
          usageInputTitle:
            'Prompt tokens that missed the prefix cache. The full prompt is input + cached; it is not the byte size of this JSON.',
          usageCacheTitle:
            'Prompt tokens served from the prefix cache (share in brackets). input + cached is the full prompt.',
          usageOutputTitle: 'Tokens generated by the model for this call.',
          usageTotalTitle: 'Call total = input + cached + output; this is what gets billed.',
          turnTotalTitle: 'Sum over every call of this turn, tool round-trips included.',
          bytesLabel: 'body',
          bytesTitle:
            'Bytes of this rebuilt JSON. Bytes are not tokens (roughly 1 token ≈ 1–2 bytes of Chinese), and this is not what the model actually received.',
          messagesTitle:
            'History entries this request carried in the session log. The request is compressed before it is sent, so this is usually larger than what the model read.',
          compressNote:
            'Counts and body size come from the session log; the payload is compressed before sending, so trust input + cached for tokens.',
          history: 'history',
          currentTurn: 'this turn',
          historyGroup: 'earlier messages',
          folded: 'folded',
          historyTitle:
            'Produced in earlier turns, folded by default; expanding keeps the real array indices.',
          currentTitle: 'Messages produced in this turn (injected context and tool round-trips included).',
          callPrefix: 'Call ',
          callSuffix: '',
          reasonLabel: 'reason',
          expandAll: 'Expand all',
          collapseAll: 'Collapse all',
          toTop: 'Top',
          toEnd: 'End',
          railTitle: 'Drag the rail to jump anywhere in the payload',
          close: 'Close',
          sourceTitle:
            'What this request is made of: your prompt, context the Harness injected, model replies, tool round-trips. Shares are message bytes, not tokens.',
          sourceFamilyPrompt: 'your prompt',
          sourceFamilyInjected: 'injected',
          sourceFamilyModel: 'model replies',
          sourceFamilyTool: 'tool round-trips',
          sourceFamilyOther: 'other',
          sourceFresh: 'new this turn',
          sourceFreshTitle: 'The part this Turn wrote into the request; the rest is carried history.',
          sourceKindUser: 'user message',
          sourceKindApproval: 'approval',
          sourceKindTimeContext: 'time context',
          sourceKindRuntimeContext: 'runtime context',
          sourceKindSkillCatalog: 'skill catalog',
          sourceKindModelSelection: 'model selection',
          sourceKindSystemPrompt: 'system prompt',
          sourceKindToolRegistry: 'tool registry',
          sourceKindModel: 'model reply',
          sourceKindTool: 'tool result',
          sourceKindJobReport: 'job report',
          sourceKindOther: 'unlabelled',
          diffTitle: 'vs previous call',
          diffAdded: 'added',
          diffRemoved: 'gone',
          diffRewritten: 'rewritten in place',
          diffChanged: 'params changed',
          diffSame: 'identical to the previous call',
          diffFirst: 'first call of this Turn — nothing to compare',
          diffPrevTitle: 'previous call',
          timelineTitle: 'This Turn’s steps',
          timelineHint: 'One segment per step, width by the tokens it spent; click to switch',
          timelineSelected: 'selected',
          timelineHeaviest: 'heaviest',
          timelineHeavyTitle: 'Top steps by tokens — click to switch',
          stepWord: 'step',
          toolCount: 'tools',
          toolNone: 'no tools',
          roundTrips: 'round-trips',
          tokens: 'tokens',
          noUsage: 'no usage',
        };

    /* Chrome text inherits the app font, so the dialog sits in the same typographic
       world as the rest of the Harness; only the payload switches to mono. Every
       size below comes from one four-step scale (14 title / 13 control / 12 text /
       11.5 micro) so nothing looks borrowed from a different product. */
    const FONT_MONO =
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

    const STYLE = {
      smallButton: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        fontWeight: 500,
        height: '28px',
        padding: '0 10px',
        boxSizing: 'border-box',
        borderRadius: '8px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'inherit',
        whiteSpace: 'nowrap',
        transition: 'background-color .12s ease, border-color .12s ease',
      },
      note: {
        padding: '12px 16px',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },

      /* ---- modal (rendered into shell.overlay, above every column) ---- */
      backdrop: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        boxSizing: 'border-box',
        background: 'rgba(0,0,0,0.28)',
        /* shell.overlay is click-through by design; the dialog opts back in. */
        pointerEvents: 'auto',
      },
      dialog: {
        display: 'flex',
        flexDirection: 'column',
        width: 'min(1040px, 96vw)',
        maxHeight: '88vh',
        boxSizing: 'border-box',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        boxShadow: '0 16px 48px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.12)',
        font: 'inherit',
        WebkitFontSmoothing: 'antialiased',
        overflow: 'hidden',
      },
      dialogHeader: {
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      },
      headerRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'nowrap',
      },
      headerActions: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginLeft: 'auto',
        flex: '0 0 auto',
      },
      dialogTitle: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: '14px',
        lineHeight: '22px',
        fontWeight: 600,
        letterSpacing: '-0.005em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chips: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '5px',
        fontSize: '12px',
        lineHeight: '20px',
        padding: '0 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        whiteSpace: 'nowrap',
      },
      chipLabel: { color: 'var(--dsw-alias-label-secondary, #5b6472)' },
      chipValue: {
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        fontSize: '12px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      chipAccent: {
        border: '1px solid var(--dsw-alias-brand-primary, rgba(90,140,255,0.9))',
        background: 'transparent',
      },
      chipAccentValue: { color: 'var(--dsw-alias-brand-primary, #2f6feb)' },
      chipAdded: {
        border: '1px solid var(--dsw-alias-success, rgba(46,160,67,0.75))',
        background: 'transparent',
      },
      chipAddedValue: { color: 'var(--dsw-alias-success, #1a7f37)' },
      chipWarn: {
        border: '1px solid var(--dsw-alias-warn, rgba(212,140,0,0.75))',
        background: 'transparent',
      },
      chipWarnValue: { color: 'var(--dsw-alias-warn, #9a6700)' },

      /* ---- diff: the appended tail, one line per message ---- */
      diffBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.30))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
      },
      diffHead: {
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },
      diffList: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        maxHeight: '132px',
        overflowY: 'auto',
      },
      diffRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '1px 4px',
        borderRadius: '4px',
      },
      diffRole: {
        flex: '0 0 auto',
        minWidth: '68px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      diffIndex: {
        flex: '0 0 auto',
        minWidth: '34px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        fontVariantNumeric: 'tabular-nums',
      },
      diffHeadText: {
        flex: '1 1 auto',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },

      /* ---- timeline: one bar per step, proportional to the tokens it spent ---- */
      timeline: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      timelineHead: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },
      timelineTrack: {
        display: 'flex',
        alignItems: 'stretch',
        gap: '2px',
        height: '10px',
        borderRadius: '999px',
        overflow: 'hidden',
      },
      timelineSeg: {
        minWidth: '2px',
        borderRadius: '2px',
        cursor: 'pointer',
        border: 'none',
        padding: '0',
      },
      timelineLabels: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '6px',
        flexWrap: 'wrap',
        fontSize: '11.5px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        fontVariantNumeric: 'tabular-nums',
      },
      timelineHeavyLabel: {
        fontWeight: '600',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },
      /* The heaviest steps, as compact pills: "#7 99.3k 12 工具". */
      timelineHeavy: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '5px',
        padding: '2px 7px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1, #e3e6ea)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontVariantNumeric: 'tabular-nums',
      },
      timelineHeavyNo: {
        fontWeight: '600',
        color: 'var(--dsw-alias-label-primary, #101828)',
      },
      timelineHeavyNum: {
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },

      /* ---- source breakdown: one stacked bar, then the legend ---- */
      sourceBar: {
        display: 'flex',
        height: '8px',
        borderRadius: '999px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      },
      sourceSeg: { height: '100%', minWidth: '2px' },
      sourceLegend: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 14px',
        marginTop: '7px',
        fontSize: '11.5px',
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },
      /* Each family is a chip that opens its kinds; collapsed by default so the
         panel is one readable row above the JSON. */
      sourceChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        whiteSpace: 'nowrap',
        padding: '2px 7px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1, #e3e6ea)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        lineHeight: '17px',
      },
      sourceDetailRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        marginTop: '6px',
        paddingTop: '6px',
        borderTop: '1px dashed var(--dsw-alias-border-l1, #e3e6ea)',
        fontSize: '11.5px',
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },
      sourceDetail: { display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' },
      sourceDot: { width: '8px', height: '8px', borderRadius: '2px', flex: '0 0 auto' },
      sourceNum: {
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      sourceMuted: { color: 'var(--dsw-alias-label-secondary, #5b6472)' },
      dialogBody: {
        flex: '1 1 auto',
        minHeight: 0,
        minWidth: 0,
        overflow: 'auto',
        overscrollBehavior: 'contain',
        padding: '12px 16px 16px',
        fontFamily: FONT_MONO,
        fontSize: '12px',
        lineHeight: '20px',
        tabSize: 2,
      },
      dialogFoot: {
        flex: '0 0 auto',
        padding: '8px 16px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
        fontSize: '11.5px',
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
      },


      /* ---- collapsible JSON tree ---- */
      jsonLine: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'default' },
      jsonClickable: { cursor: 'pointer' },
      jsonNode: { display: 'block' },
      jsonGuide: {
        borderLeft: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
        marginLeft: '6px',
        paddingLeft: '10px',
      },
      /* Messages produced in the inspected turn: the array's own guide line turns
         into an accent rail for them, continuous across consecutive messages.
         The negative margin + matching padding keep the text on the same x, so
         current rows stay aligned with the folded history block above. */
      jsonCurrent: {
        borderLeft: '2px solid transparent',
        marginLeft: '-10px',
        paddingLeft: '10px',
      },
      /* The "1838 items · history 1814 · this turn 24" summary on the array head. */
      jsonBadge: {
        display: 'inline-block',
        marginLeft: '8px',
        padding: '0 6px',
        border: '1px solid transparent',
        borderRadius: '999px',
        fontSize: '11.5px',
        lineHeight: '16px',
        fontVariantNumeric: 'tabular-nums',
      },
      jsonBadgeMuted: {
        display: 'inline-block',
        marginLeft: '6px',
        fontSize: '11.5px',
        fontVariantNumeric: 'tabular-nums',
      },
      /* Folded history header: reads as a label, never as a JSON element. */
      jsonFoldedHead: {
        margin: '3px 0',
        padding: '2px 6px',
        borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.07))',
      },

      tabs: {
        flex: '0 0 auto',
        minHeight: '52px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '10px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))',
      },
      tab: {
        font: 'inherit',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '7px',
        fontSize: '13px',
        lineHeight: '20px',
        padding: '5px 11px',
        borderRadius: '8px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        transition: 'background-color .12s ease, border-color .12s ease, color .12s ease',
      },
      tabActive: {
        border: '1px solid var(--dsw-alias-brand-primary, rgba(90,140,255,0.9))',
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        color: 'var(--dsw-alias-brand-primary, #2f6feb)',
        fontWeight: 600,
        boxShadow: 'inset 0 0 0 1px var(--dsw-alias-brand-primary, rgba(90,140,255,0.5))',
      },
      tabIndex: {
        fontSize: '13px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      tabMeta: {
        fontSize: '11.5px',
        lineHeight: '16px',
        fontWeight: 400,
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        opacity: 0.9,
        fontVariantNumeric: 'tabular-nums',
      },
      /* A Turn can run dozens of calls: past a dozen, tabs are replaced by a step
         list — one row per call, scannable in a column instead of a strip. */
      split: {
        flex: '1 1 auto',
        minHeight: 0,
        display: 'flex',
        alignItems: 'stretch',
      },
      stepList: {
        flex: '0 0 auto',
        width: '236px',
        minWidth: '180px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '8px',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        borderRight: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.04))',
      },
      stepRow: {
        font: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: '1px',
        textAlign: 'left',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '0',
        borderLeft: '2px solid transparent',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        transition: 'background-color .12s ease',
      },
      stepRowActive: {
        background: 'var(--dsw-alias-bg-overlay, #ffffff)',
        borderLeft: '2px solid var(--dsw-alias-brand-primary, #2f6fed)',
        boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      },
      stepRowTop: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '8px',
      },
      stepNo: {
        fontSize: '12.5px',
        lineHeight: '18px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      },
      stepAside: {
        fontSize: '11.5px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      stepSub: {
        fontSize: '11.5px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary, #5b6472)',
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    };

    // ---------------------------------------------------------------- log helpers

    function seqOf(event) {
      if (!event) return -1;
      if (typeof event.seq === 'number') return event.seq;
      if (typeof event.eventSeq === 'number') return event.eventSeq;
      if (typeof event.offset === 'number') return event.offset;
      return -1;
    }

    function typeOf(event) {
      if (!event) return '';
      if (typeof event.type === 'string') return event.type;
      return '';
    }

    function dataOf(event) {
      if (!event) return {};
      if (event.data && typeof event.data === 'object') return event.data;
      if (event.payload && typeof event.payload === 'object') return event.payload;
      return {};
    }

    /*
     * Why a message is in the request — the question a reader actually asks in
     * front of a 1078-message payload. The session log already records it: every
     * message-shaped event carries `data.source.kind` (or `data.message.source`
     * for assistant/tool messages), so this table only names those kinds.
     *
     * The families are what matter, not the individual kinds: a prompt is
     * mostly "history", plus injections this Turn needed, plus tool traffic.
     */
    const SOURCE_KINDS = {
      user: { key: 'prompt', family: 'prompt' },
      'user-approval': { key: 'approval', family: 'prompt' },
      /* Background-job completion reports arrive as `user` messages, but they are
         the harness talking, not the person: counting them as "your input" made
         a Turn with 1 real prompt report 54. Kept in their own kind so both the
         count and the wording stay honest. */
      'tool-jobs': { key: 'jobReport', family: 'injected' },
      'time-context': { key: 'timeContext', family: 'injected' },
      'runtime-context': { key: 'runtimeContext', family: 'injected' },
      'skill-catalog': { key: 'skillCatalog', family: 'injected' },
      'model-selection': { key: 'modelSelection', family: 'injected' },
      'system-prompt': { key: 'systemPrompt', family: 'injected' },
      'tool-registry': { key: 'toolRegistry', family: 'injected' },
      model: { key: 'model', family: 'model' },
      tool: { key: 'tool', family: 'tool' },
    };

    /** The source kind of one log event, or '' when the log does not say. */
    function sourceKindOf(type, data) {
      const message = data && data.message && typeof data.message === 'object' ? data.message : null;
      const source = (message && message.source) || (data && data.source) || null;
      if (source && typeof source.kind === 'string') return source.kind;
      return '';
    }

    /** Which family a source kind belongs to; unknown kinds are 'other'. */
    function familyOf(kind) {
      const known = SOURCE_KINDS[kind];
      return known ? known.family : 'other';
    }

    /*
     * Byte size without building the string: the payload is megabytes, and this
     * runs once per call of a Turn.
     */
    function byteLength(value) {
      if (value === null || value === undefined) return 4;
      if (typeof value === 'string') return utf8Length(value) + 2;
      if (typeof value === 'number') return isFinite(value) ? String(value).length : 4;
      if (typeof value === 'boolean') return value ? 4 : 5;
      if (Array.isArray(value)) {
        let total = 2;
        for (let i = 0; i < value.length; i += 1) total += byteLength(value[i]) + 1;
        return total;
      }
      if (typeof value === 'object') {
        const keys = Object.keys(value);
        let total = 2;
        for (let i = 0; i < keys.length; i += 1) {
          total += utf8Length('"' + keys[i] + '":') + byteLength(value[keys[i]]) + 1;
        }
        return total;
      }
      return 0;
    }

    function utf8Length(text) {
      let bytes = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
          bytes += 4;
          i += 1;
        } else bytes += 3;
      }
      return bytes;
    }

    /**
     * Group the messages of one rebuild by source, so the viewer can answer
     * "why is this request 1078 messages long".
     *
     * `items` is the seq-tagged list `buildMessages` folded, filtered down to the
     * messages it actually kept: an incremental empty record contributes nothing,
     * so counting it would overstate a family.
     */
    function summarizeSources(items) {
      const families = { prompt: 0, injected: 0, model: 0, tool: 0, other: 0 };
      const kinds = {};
      const order = [];
      for (let i = 0; i < items.length; i += 1) {
        const entry = items[i];
        const kind = entry.kind || '';
        const known = SOURCE_KINDS[kind];
        const family = known ? known.family : 'other';
        families[family] += 1;
        const key = known ? known.key : 'other';
        if (!kinds[key]) {
          kinds[key] = { key: key, kind: kind, family: family, count: 0 };
          order.push(key);
        }
        kinds[key].count += 1;
      }
      return {
        counts: families,
        kinds: order.map((key) => kinds[key]),
      };
    }

    /** Flatten a window entry list into a seq-ordered array of real (non-transient) events. */
    function collectEvents(entries) {
      const out = [];
      const list = Array.isArray(entries) ? entries : [];
      for (let i = 0; i < list.length; i += 1) {
        const entry = list[i];
        if (!entry) continue;
        if (entry.type === 'transient') continue;
        const event = entry.event || entry;
        if (event && typeof event === 'object' && typeof event.type === 'string') out.push(event);
      }
      out.sort((a, b) => seqOf(a) - seqOf(b));
      return out;
    }

    /** Render a logged content value the way a chat request carries it: plain text. */
    function flattenContent(content) {
      if (content === null || content === undefined) return null;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = [];
        for (let i = 0; i < content.length; i += 1) {
          const block = content[i];
          if (block === null || block === undefined) continue;
          if (typeof block === 'string') {
            parts.push(block);
            continue;
          }
          const kind = typeof block.type === 'string' ? block.type : '';
          if (kind === 'image' || kind === 'image-url' || kind === 'image_url' || kind === 'file') {
            parts.push('[image]');
            continue;
          }
          if (typeof block.text === 'string') {
            parts.push(block.text);
            continue;
          }
          if (typeof block.content === 'string') {
            parts.push(block.content);
            continue;
          }
          try {
            parts.push(JSON.stringify(block));
          } catch (err) {
            parts.push('[block]');
          }
        }
        return parts.join('\n');
      }
      if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        try {
          return JSON.stringify(content);
        } catch (err) {
          return String(content);
        }
      }
      return String(content);
    }

    /** Drop the surface messages that a compaction `replace` op rewrote away. */
    function applyReplace(items, op) {
      if (!op || typeof op !== 'object' || op.op !== 'replace') return false;
      const start = typeof op.startSeq === 'number' ? op.startSeq : null;
      const end = typeof op.endSeq === 'number' ? op.endSeq : null;
      if (start === null || end === null) return false;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const seq = items[i].seq;
        if (seq >= start && seq <= end) items.splice(i, 1);
      }
      return true;
    }

    /**
     * Fold the surface log up to `cutSeq` into the message array of one request.
     *
     * `turnStartSeq` is the seq that opened the Turn being inspected: everything
     * at or after it was produced by this Turn (the user message, the context
     * injected for it, and every assistant/tool message so far), everything
     * before it is history the request merely carried along. The returned
     * `historyEnd` is the index where that boundary falls in `messages`, which is
     * what lets the viewer fold the older block away by default.
     *
     * Each kept message also carries `track`, the seq-ordered list of its source
     * records ({seq, kind, family, byte}), so the viewer can say where every
     * message came from without rebuilding anything.
     */
    function buildMessages(events, cutSeq, turnStartSeq) {
      const items = [];
      const boundary = typeof turnStartSeq === 'number' && turnStartSeq >= 0 ? turnStartSeq : -1;
      let lastAssistant = null;

      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        const seq = seqOf(event);
        if (seq >= cutSeq) break;
        const type = typeOf(event);
        const data = dataOf(event);

        if (type === 'tool/call') {
          if (lastAssistant && Array.isArray(lastAssistant.tool_calls)) {
            lastAssistant.tool_calls.push({
              id: data.callId !== undefined ? data.callId : data.toolCallId,
              type: 'function',
              function: {
                name: data.name,
                arguments:
                  typeof data.arguments === 'string'
                    ? data.arguments
                    : JSON.stringify(data.arguments === undefined ? {} : data.arguments),
              },
            });
            /* The call belongs to the assistant message it hangs off, so it adds
               to that message's size rather than becoming one of its own. */
            const owner = items[items.length - 1];
            const kind = 'model';
            if (owner) {
              owner.track.push({
                seq: seq,
                kind: kind,
                family: 'model',
                byte: byteLength(data.arguments),
              });
            }
          }
          continue;
        }

        const role = SURFACE_ROLES[type];
        if (!role) continue;

        if (applyReplace(items, data.surfaceOp)) lastAssistant = null;

        const raw =
          role === 'user' && typeof data.role === 'string'
            ? data
            : data.message && typeof data.message === 'object'
              ? data.message
              : data;

        const message = { role: role, content: flattenContent(raw.content) };

        if (role === 'tool') {
          const callId = raw.toolCallId !== undefined ? raw.toolCallId : raw.tool_call_id;
          if (callId !== undefined) message.tool_call_id = callId;
          if (raw.isError === true) message.is_error = true;
          if (typeof raw.name === 'string') message.name = raw.name;
        }

        if (role === 'assistant') {
          message.tool_calls = [];
          lastAssistant = message;
        } else {
          lastAssistant = null;
        }

        const kind = sourceKindOf(type, data);
        const bytes = byteLength(message.content);
        items.push({
          seq: seq,
          kind: kind,
          byte: bytes,
          message: message,
          track: [{ seq: seq, kind: kind, family: familyOf(kind), byte: bytes }],
        });
      }

      const messages = [];
      const track = [];
      let historyEnd = boundary < 0 ? 0 : null;
      for (let i = 0; i < items.length; i += 1) {
        const message = items[i].message;
        if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length === 0) {
          delete message.tool_calls;
        }
        /* `system/message` and `user/message` are INCREMENTAL records: an empty
           one means "nothing new for this epoch", not "send an empty message".
           Carrying it would put a message the model never saw into the payload. */
        if (!message.tool_calls) {
          const text = message.content;
          if (typeof text !== 'string' || text.trim() === '') continue;
        }
        if (historyEnd === null && items[i].seq >= boundary) historyEnd = messages.length;
        messages.push(message);
        track.push(items[i].track);
      }
      return {
        messages: messages,
        historyEnd: historyEnd === null ? messages.length : historyEnd,
        /* Per-message provenance, aligned with `messages`. */
        track: track,
      };
    }

    /**
     * Rebuild every model call of one Turn.
     *
     * One step is exactly one request to the model, so `step/start` is the
     * anchor. `request/header` is NOT emitted per call — the Harness records it
     * only when the call configuration changes — so the effective header is
     * carried forward from the nearest earlier record, including ones that sit
     * in previous Turns.
     */
    function buildTurnCalls(events, turnNumber, turnSeq, turnStartHint) {
      let turnStartSeq = typeof turnStartHint === 'number' ? turnStartHint : -1;
      if (!(turnStartSeq >= 0) && turnNumber !== undefined) {
        for (let i = 0; i < events.length; i += 1) {
          if (typeOf(events[i]) !== 'turn/start') continue;
          if (dataOf(events[i]).turn === turnNumber) turnStartSeq = seqOf(events[i]);
        }
      }

      if (!(turnStartSeq >= 0) && turnNumber !== undefined) return null;

      /* Prefer the Turn's own end marker (or the next Turn's start) as the upper
         bound; the slot's `seq` is only a fallback when no marker is visible. */
      let turnEndSeq = typeof turnSeq === 'number' ? turnSeq : -1;
      if (turnStartSeq >= 0) {
        let nextStart = -1;
        let endSeq = -1;
        for (let i = 0; i < events.length; i += 1) {
          const event = events[i];
          const seq = seqOf(event);
          if (seq <= turnStartSeq) continue;
          const type = typeOf(event);
          if (type === 'turn/end' && dataOf(event).turn === turnNumber) {
            endSeq = seq;
            break;
          }
          if (type === 'turn/start') {
            nextStart = seq;
            break;
          }
        }
        if (endSeq >= 0) turnEndSeq = endSeq;
        else if (nextStart >= 0) turnEndSeq = nextStart - 1;
      }

      /* Keep every header visible in the window: they are sparse, and the one
         that governs a step may sit in an earlier Turn. */
      const headers = [];
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        if (typeOf(event) !== 'request/header') continue;
        const data = dataOf(event);
        headers.push({
          seq: seqOf(event),
          reason: data.reason,
          startsSeries: data.startsSeries === true,
          epoch: data.header && typeof data.header === 'object' ? data.header : {},
        });
      }

      /* One model call per step. */
      const steps = [];
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        if (typeOf(event) !== 'step/start') continue;
        const seq = seqOf(event);
        if (seq < turnStartSeq) continue;
        if (turnEndSeq >= 0 && seq > turnEndSeq) break;
        const data = dataOf(event);
        if (
          turnNumber !== undefined &&
          data.turn !== undefined &&
          data.turn !== null &&
          data.turn !== turnNumber
        ) {
          continue;
        }
        steps.push({
          step: typeof data.step === 'number' ? data.step : steps.length + 1,
          seq: seq,
        });
      }
      if (!steps.length) return null;

      /* Per step: the model it actually ran on, and where its own response
         begins. A step records its injected messages *after* `step/start`, so
         the request of step k is everything up to the first response event of
         that step — not up to `step/start`. */
      const responseByStep = {};
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        const type = typeOf(event);
        if (type !== 'assistant/message' && type !== 'assistant/attempt') continue;
        const data = dataOf(event);
        if (turnNumber !== undefined && data.turn !== turnNumber) continue;
        const key = String(data.step);
        const entry = responseByStep[key] || { cutSeq: undefined, source: null, usage: null, endSeq: undefined };
        if (entry.cutSeq === undefined) entry.cutSeq = seqOf(event);
        /* The response is not the only thing a step writes: tool calls and tool
           results follow it before the next step starts. The timeline needs the
           whole span, so it closes at the last record carrying this step. */
        entry.endSeq = seqOf(event);
        if (type === 'assistant/message' && data.usage && typeof data.usage === 'object') {
          entry.usage = data.usage;
        }
        if (!entry.source && type === 'assistant/message') {
          const message = data.message;
          const source = message && typeof message.source === 'object' ? message.source : null;
          if (source) entry.source = source;
        }
        responseByStep[key] = entry;
      }

      /* Tool traffic belongs to a step too, and it is the honest measure of how
         heavy a step was: one call plus its result is one round-trip. Counted
         here so the timeline can size and label each step without re-scanning. */
      const toolsByStep = {};
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        const type = typeOf(event);
        if (type !== 'tool/call' && type !== 'tool/result') continue;
        const data = dataOf(event);
        if (turnNumber !== undefined && data.turn !== turnNumber) continue;
        const key = String(data.step);
        const entry = toolsByStep[key] || (toolsByStep[key] = { calls: 0, results: 0, names: [] });
        if (type === 'tool/call') {
          entry.calls += 1;
          const response = responseByStep[key];
          if (response) response.endSeq = Math.max(response.endSeq || 0, seqOf(event));
          if (typeof data.name === 'string' && entry.names.indexOf(data.name) < 0) entry.names.push(data.name);
        } else {
          entry.results += 1;
        }
      }
      /* A step without tool traffic still needs an entry, so the timeline can
         say "0 工具" instead of treating it as missing data. */
      for (let i = 0; i < steps.length; i += 1) {
        const key = String(steps[i].step);
        if (!toolsByStep[key]) toolsByStep[key] = { calls: 0, results: 0, names: [] };
      }

      const calls = [];
      for (let i = 0; i < steps.length; i += 1) {
        const stepInfo = steps[i];
        const nextSeq =
          i + 1 < steps.length
            ? steps[i + 1].seq
            : turnEndSeq >= 0
              ? turnEndSeq + 1
              : Number.MAX_SAFE_INTEGER;

        const response = responseByStep[String(stepInfo.step)] || null;
        /* Messages are composed before the call, then recorded. Cut where this
           step's own response starts, so its response and tool results stay
           out of its own request. */
        const cutSeq =
          response && typeof response.cutSeq === 'number'
            ? response.cutSeq
            : nextSeq > stepInfo.seq
              ? nextSeq - 1
              : stepInfo.seq + 1;
        const headerBound = nextSeq - 1;

        let header = null;
        for (let j = 0; j < headers.length; j += 1) {
          if (headers[j].seq <= headerBound) header = headers[j];
          else break;
        }
        const epoch = header && header.epoch && typeof header.epoch === 'object' ? header.epoch : {};
        const config = epoch.config && typeof epoch.config === 'object' ? epoch.config : {};
        const source = response && response.source ? response.source : null;

        const model =
          source && typeof source.model === 'string' ? source.model : config.model;
        const provider =
          source && typeof source.provider === 'string' ? source.provider : config.provider;

        const request = {};
        if (model !== undefined) request.model = model;
        if (provider !== undefined) request.provider = provider;
        const configKeys = Object.keys(config);
        for (let j = 0; j < configKeys.length; j += 1) {
          const key = configKeys[j];
          if (key === 'model' || key === 'provider') continue;
          request[key] = config[key];
        }

        const built = buildMessages(events, cutSeq, turnStartSeq);
        request.messages = built.messages;
        const tools = Array.isArray(epoch.tools) ? epoch.tools : [];
        request.tools = tools;

        /* A step's request contains every earlier request of the same Turn as a
           prefix, so the useful question is "what changed since the previous
           call": the messages appended after it, and anything that got rewritten
           in place (compaction). Compared against the previous call of the SAME
           Turn — a Turn boundary is a different conversation, not a diff. */
        const prev = calls.length ? calls[calls.length - 1] : null;
        const diff = prev ? diffRequests(prev.request, request) : null;

        calls.push({
          index: i + 1,
          request: request,
          meta: {
            turn: turnNumber,
            seq: cutSeq,
            step: stepInfo.step,
            /* The seqs that frame this step in the log. startSeq is where it
               opened, endSeq is the last record it wrote; kept only so the
               timeline can describe a step's extent, never as a measure of cost. */
            startSeq: stepInfo.seq,
            endSeq: response && typeof response.endSeq === 'number' ? response.endSeq : stepInfo.seq,
            reason: header ? header.reason : null,
            startsSeries: header ? header.startsSeries : false,
            model: model,
            provider: provider,
            messages: request.messages.length,
            /* How heavy this step was: tool calls, tool round-trips (a call with
               its result) and the distinct tool names it used. */
            toolCalls: toolsByStep[String(stepInfo.step)].calls,
            toolResults: toolsByStep[String(stepInfo.step)].results,
            toolNames: toolsByStep[String(stepInfo.step)].names,
            /* Index where this Turn's own messages start; the viewer folds
               everything before it. Kept on `meta`, never inside `request`, so
               the payload itself stays byte-for-byte what was sent. */
            historyEnd: built.historyEnd,
            /* Why the messages are there, and which of them are new this Turn. */
            sources: summarizeSources(built.track.map(firstRecord)),
            freshSources: summarizeSources(
              built.track.slice(built.historyEnd).map(function (items) {
                return firstRecord(items, turnStartSeq);
              }),
            ),
            freshBytes: freshBytes(built.track.slice(built.historyEnd), turnStartSeq),
            tools: tools.length,
            usage: response && response.usage ? normalizeUsage(response.usage) : null,
            diff: diff,
          },
        });
      }

      return { turn: turnNumber, calls: calls };
    }

    /**
     * One message can be assembled from several records (an assistant reply plus
     * the `tool/call` entries hanging off it). For the source summary the first
     * record decides the family, and `onlyFrom` narrows it to the records written
     * by the current Turn.
     */
    function firstRecord(items, onlyFrom) {
      if (!Array.isArray(items) || !items.length) return { kind: '', family: 'other', byte: 0, seq: -1 };
      const usable =
        typeof onlyFrom === 'number'
          ? items.filter(function (item) {
              return item.seq >= onlyFrom;
            })
          : items;
      return usable.length ? usable[0] : { kind: '', family: 'other', byte: 0, seq: -1 };
    }

    /** Bytes this Turn wrote into the request (the rest is carried history). */
    function freshBytes(track, onlyFrom) {
      let total = 0;
      for (let i = 0; i < track.length; i += 1) {
        const items = track[i];
        for (let j = 0; j < items.length; j += 1) {
          if (typeof onlyFrom === 'number' && items[j].seq < onlyFrom) continue;
          total += items[j].byte || 0;
        }
      }
      return total;
    }

    /**
     * What changed between two consecutive requests of the same Turn.
     *
     * Within a Turn the payload only ever grows at the tail: the Harness appends
     * the model's reply and the tool results, then calls again. So the cheap and
     * exact answer is the longest common prefix — everything after it is new, and
     * if the previous request is not a prefix of this one, something was rewritten
     * in place (compaction, a pruned tool result) which the viewer must say out
     * loud rather than silently mislabel as "appended".
     */
    function diffRequests(prev, next) {
      const before = Array.isArray(prev && prev.messages) ? prev.messages : [];
      const after = Array.isArray(next && next.messages) ? next.messages : [];
      const limit = Math.min(before.length, after.length);

      let common = 0;
      while (common < limit && sameMessage(before[common], after[common])) common += 1;

      /* Text fields outside `messages` (model, sampling controls, tools) — a
         changed model or a different tool list is the interesting case. */
      const changed = [];
      const keys = Object.keys(next || {});
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key === 'messages') continue;
        if (stableJSON(prev ? prev[key] : undefined) !== stableJSON(next[key])) changed.push(key);
      }

      const added = [];
      for (let i = common; i < after.length; i += 1) {
        added.push({ index: i, role: after[i].role, head: headOf(after[i]) });
      }

      /* Anything the previous request had that this one does not, or that sits
         before the prefix break, was rewritten rather than appended. */
      let removed = 0;
      for (let i = common; i < before.length; i += 1) {
        if (!sameMessage(before[i], after[i])) removed += 1;
      }

      return {
        /* The index where the new tail starts in THIS request. */
        prefix: common,
        added: added,
        removed: removed,
        rewritten: common < limit && !sameMessage(before[common], after[common]),
        changed: changed,
        prevMessages: before.length,
      };
    }

    function stableJSON(value) {
      try {
        return JSON.stringify(value === undefined ? null : value);
      } catch (error) {
        return null;
      }
    }

    function sameMessage(a, b) {
      if (a === b) return true;
      if (!a || !b || a.role !== b.role) return false;
      return (
        stableJSON(a.content) === stableJSON(b.content) &&
        stableJSON(a.tool_calls) === stableJSON(b.tool_calls) &&
        a.tool_call_id === b.tool_call_id
      );
    }

    /** First line of a message's text, for the "what got appended" list. */
    function headOf(message) {
      let text = message && message.content;
      if (Array.isArray(text)) {
        const parts = [];
        for (let i = 0; i < text.length; i += 1) {
          const part = text[i];
          if (part && typeof part.text === 'string') parts.push(part.text);
        }
        text = parts.join(' ');
      }
      if (typeof text !== 'string') text = '';
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > 96 ? flat.slice(0, 96) + '…' : flat;
    }

    /** Locate the assistant message an action row belongs to. */
    function locateMessage(events, messageId) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (typeOf(event) !== 'assistant/message') continue;
        const data = dataOf(event);
        if (!data.message || data.message.id !== messageId) continue;
        return { turn: data.turn, step: data.step };
      }
      return null;
    }

    /** The call a step produced — one model call per step. */
    function callIndexForStep(built, step) {
      if (!built || !Array.isArray(built.calls)) return 0;
      for (let i = 0; i < built.calls.length; i += 1) {
        const item = built.calls[i];
        if (item && item.meta && item.meta.step === step) return i;
      }
      return 0;
    }

    /* Test hook: lets a Node harness drive the request pipeline against a real
       session log. Inert in the Web UI, where the global is never set. */
    if (typeof globalThis !== 'undefined' && globalThis.__DSH_PAYLOAD_TEST__ === true) {
      globalThis.__DSH_PAYLOAD_INTERNALS__ = {
        collectEvents: collectEvents,
        buildMessages: buildMessages,
        buildTurnCalls: buildTurnCalls,
        diffRequests: diffRequests,
        summarizeSources: summarizeSources,
        byteLength: byteLength,
        locateMessage: locateMessage,
        callIndexForStep: callIndexForStep,
        DialogBody: DialogBody,
        Timeline: Timeline,
        publishDialog: publishDialog,
      };
    }

    // ---------------------------------------------------------------- the plugin

    /**
     * ONE dialog for every button.
     *
     * A button publishes a payload here and the `shell.overlay` entry renders
     * it. That is deliberate: the overlay lives at frame level, outside every
     * column and scroll container, so the modal cannot inherit a clipping or
     * stacking context from the conversation it was opened from.
     */
    let dialogPayload = null;
    let dialogSerial = 0;
    const dialogListeners = new Set();

    function publishDialog(next) {
      dialogPayload = next ? Object.assign({ id: (dialogSerial += 1) }, next) : null;
      dialogListeners.forEach(function (listener) {
        try {
          listener();
        } catch (err) {
          /* one broken listener must not strand the dialog */
        }
      });
    }

    function subscribeDialog(listener) {
      dialogListeners.add(listener);
      return function () {
        dialogListeners.delete(listener);
      };
    }

    /** Rebuilding a payload walks the whole window, so keep it per (session, turn, window end). */
    const builtCache = new Map();
    const BUILT_CACHE_LIMIT = 40;

    /** Cache a rebuild, keyed so a Turn that is still growing cannot serve stale calls. */
    function rememberBuilt(key, built) {
      if (builtCache.size >= BUILT_CACHE_LIMIT) builtCache.clear();
      builtCache.set(key, built);
    }

    /* The trigger copies the shipped per-message action buttons exactly — 28px hit
       area, `radius-sm`, `label-tertiary` at rest, `interactive-bg-hover` on hover —
       and its label is a bubble with the same tokens as the design system's own
       tooltip (`alias-tooltip-bg` + `neutral-bluish-00`, 13/20) so it does not read
       as a foreign widget. */
    const ACTION_STYLE_ID = 'dsh-payload-action-css';
    const ACTION_CSS = [
      '.dsh-pl-action{position:relative;display:inline-flex;align-items:center;justify-content:center;',
      'width:28px;height:28px;margin:0;padding:6px;box-sizing:border-box;border:0;',
      'border-radius:var(--dsw-radius-sm,8px);background:transparent;',
      'color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;',
      'transition:background-color .12s ease,color .12s ease}',
      '.dsh-pl-action:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);',
      'color:var(--dsw-alias-label-secondary,#5b6472)}',
      '.dsh-pl-action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
      'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2f6fed));outline-offset:2px}',
      '.dsh-pl-icon{display:block;width:15px;height:15px}',
      /* Fixed, not absolute: the label must survive the message scroller clipping it. */
      '.dsh-pl-tip{position:fixed;z-index:1100;display:inline-flex;align-items:center;',
      'width:max-content;max-width:min(50vw,calc(100vw - 24px));box-sizing:border-box;',
      'padding:3px 7px;border-radius:var(--dsw-radius-sm,8px);',
      'background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-static-neutral-bluish-00,#ffffff);',
      'font-family:inherit;font-size:13px;line-height:20px;font-weight:400;',
      'white-space:nowrap;pointer-events:none;animation:dsh-pl-tip-in .15s ease-out}',
      '@keyframes dsh-pl-tip-in{0%{opacity:0}100%{opacity:1}}',
      /* Hover affordances for the dialog chrome: inline styles cannot express them,
         and a modal whose controls do not react on hover reads as a foreign window. */
      '.dsh-pl-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);',
      'border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.5))}',
      '.dsh-pl-btn:active{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-pl-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}',
      '.dsh-pl-tab:not(.dsh-pl-tab-on):hover{color:var(--dsw-alias-label-primary,#111827);',
      'border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.5));',
      'background:var(--dsw-alias-bg-overlay,rgba(255,255,255,.6))}',
      '.dsh-pl-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}',
      '.dsh-pl-step:not(.dsh-pl-step-on):hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-pl-step:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:-2px}',
      /* The timeline’s "heaviest" pills are navigation, not list rows: they reuse
         the hover rules but must not be counted as step-list rows. */
      '.dsh-pl-heavy{border-radius:999px}',
      '.dsh-pl-heavy:not(.dsh-pl-step-on):hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f)}',
      '.dsh-pl-heavy:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6fed);outline-offset:1px}',
      /* A 100k-line payload needs a real scrollbar: the shell’s default overlay bar
         is thin and fades out, which makes dragging to the end a guessing game.
         Colours come from the dialog’s own palette through custom properties (see
         PALETTES), so the rail can never blend into the surface it sits on. */
      '.dsh-pl-scroll{scrollbar-gutter:stable;scrollbar-width:auto;',
      'scrollbar-color:var(--dsh-pl-sb-thumb,rgba(15,23,42,.46)) var(--dsh-pl-sb-track,rgba(15,23,42,.07))}',
      '.dsh-pl-scroll::-webkit-scrollbar{width:14px;height:14px}',
      '.dsh-pl-scroll::-webkit-scrollbar-track{',
      'background:var(--dsh-pl-sb-track,rgba(15,23,42,.07));',
      'border-left:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14))}',
      '.dsh-pl-scroll::-webkit-scrollbar-thumb{',
      'border:2px solid transparent;background-clip:padding-box;border-radius:8px;',
      'background-color:var(--dsh-pl-sb-thumb,rgba(15,23,42,.46));',
      'transition:background-color .12s ease}',
      '.dsh-pl-scroll::-webkit-scrollbar-thumb:hover{',
      'background-color:var(--dsh-pl-sb-thumb-hover,rgba(15,23,42,.68));',
      'border:2px solid transparent;background-clip:padding-box}',
      '.dsh-pl-scroll::-webkit-scrollbar-thumb:active{',
      'background-color:var(--dsh-pl-sb-thumb-active,#2f6fed);',
      'border:2px solid transparent;background-clip:padding-box}',
      '.dsh-pl-scroll::-webkit-scrollbar-corner{background:transparent}',
    ].join('');

    /** Install the trigger stylesheet once; failure only costs cosmetics. */
    function ensureActionStyle() {
      try {
        if (typeof document === 'undefined' || !document) return;
        if (document.getElementById(ACTION_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = ACTION_STYLE_ID;
        style.textContent = ACTION_CSS;
        (document.head || document.documentElement).appendChild(style);
      } catch (err) {
        /* cosmetic only */
      }
    }

    const MAX_STRING_CHARS = 320;
    const EXPAND_ALL_DEPTH = 6;
    /* Tabs read best for a handful of calls; beyond this they become a step list. */
    const TAB_LIMIT = 12;

    /*
     * JSON syntax colours are the one place the alias-token set is too coarse
     * (it has a single accent), so the tree carries its own small palette per
     * colour scheme. GitHub-ish, deliberately not "black keys + green strings".
     */
    const PALETTES = {
      light: {
        key: '#8250df',
        string: '#1163c7',
        number: '#a3541b',
        bool: '#bf3989',
        nil: '#6e7781',
        punct: '#8c959f',
        toggle: '#8250df',
        /* Scrollbar: alpha over the pane background, so contrast never depends on
           which alias token happens to be near the surface colour. */
        scTrack: 'rgba(15,23,42,0.07)',
        scThumb: 'rgba(15,23,42,0.46)',
        scThumbHover: 'rgba(15,23,42,0.68)',
        scThumbActive: '#2f6fed',
        /* Accent for messages produced in the turn being inspected, so the eye
           finds them without reading a single role name. */
        currentBorder: '#2f6fed',
        currentBg: 'rgba(47,111,237,0.07)',
        /* Source families, in the order the bar stacks them. */
        famPrompt: '#2f6fed',
        famInjected: '#b26a00',
        famModel: '#8250df',
        famTool: '#1a7f37',
        famOther: '#8c959f',
      },
      dark: {
        key: '#d2a8ff',
        string: '#79c0ff',
        number: '#ffa657',
        bool: '#ff9bce',
        nil: '#8b949e',
        punct: '#6e7681',
        toggle: '#d2a8ff',
        scTrack: 'rgba(255,255,255,0.10)',
        scThumb: 'rgba(255,255,255,0.42)',
        scThumbHover: 'rgba(255,255,255,0.66)',
        scThumbActive: '#5a8cff',
        currentBorder: '#5a8cff',
        currentBg: 'rgba(90,140,255,0.13)',
        famPrompt: '#5a8cff',
        famInjected: '#d29922',
        famModel: '#d2a8ff',
        famTool: '#3fb950',
        famOther: '#6e7681',
      },
    };

    /* Compact form for tab strips: 80285 -> "80.3k". */
    function formatTokens(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '-';
      if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
      if (value >= 1e4) return (value / 1e3).toFixed(1) + 'k';
      return String(Math.round(value));
    }

    /* Byte size of a rebuilt payload: 4123456 -> "3.9 MB". Never tokens. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '-';
      if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
      if (value >= 1024) return (value / 1024).toFixed(0) + ' KB';
      return value + ' B';
    }

    /* Exact form for the detail line: 80285 -> "80,285". */
    function formatExact(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '-';
      const rounded = Math.round(value);
      const text = String(rounded);
      let out = '';
      for (let i = 0; i < text.length; i += 1) {
        const fromEnd = text.length - i;
        out += text[i];
        if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
      }
      return out;
    }

    /*
     * The provider reports the usage of the call it answered, so this is the
     * billed/consumed figure, not an estimate from the prompt text:
     *   inputTokens       prompt tokens actually sent (non-cached part)
     *   cacheReadTokens   prompt tokens served from the prompt cache
     *   outputTokens      tokens generated by the model
     *   totalTokens       the provider's total (input + cacheRead + output)
     */
    function normalizeUsage(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const input = typeof raw.inputTokens === 'number' ? raw.inputTokens : 0;
      const cacheRead = typeof raw.cacheReadTokens === 'number' ? raw.cacheReadTokens : 0;
      const output = typeof raw.outputTokens === 'number' ? raw.outputTokens : 0;
      const total =
        typeof raw.totalTokens === 'number'
          ? raw.totalTokens
          : (typeof raw.inputTokens === 'number' ? input : 0) +
            (typeof raw.outputTokens === 'number' ? output : 0) +
            (typeof raw.cacheReadTokens === 'number' ? cacheRead : 0);
      const promptTokens = input + cacheRead;
      return {
        input: input,
        cache: cacheRead,
        output: output,
        total: total,
        hitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
      };
    }

    function copyText(value, done) {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (!value || !nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return;
      nav.clipboard.writeText(value).then(done, function () {});
    }

    // ------------------------------------------------------------ JSON tree

    function valueStyle(value, pal) {
      if (typeof value === 'string') return { color: pal.string };
      if (typeof value === 'number') return { color: pal.number };
      if (typeof value === 'boolean') return { color: pal.bool, fontWeight: 600 };
      return { color: pal.nil, fontStyle: 'italic' };
    }

    function literalOf(value) {
      if (typeof value === 'string') {
        const clipped =
          value.length > MAX_STRING_CHARS
            ? value.slice(0, MAX_STRING_CHARS) + '… (＋' + (value.length - MAX_STRING_CHARS) + ' chars)'
            : value;
        return JSON.stringify(clipped);
      }
      return String(value);
    }

    /**
     * The older part of a `messages` array, folded into one line. Folding is pure
     * presentation: the children keep their real array indices, so expanding the
     * group — or copying the payload — never changes what was actually sent.
     */
    function JsonHistoryGroup(props) {
      const depth = props.depth;
      const items = props.items;
      const offset = props.offset || 0;
      const pal = props.pal || PALETTES.light;
      const mode = props.mode;
      const indentation = { paddingLeft: depth * 14 + 'px' };
      const [open, setOpen] = React.useState(mode === 'all');

      const head = h(
        'div',
        {
          style: Object.assign({}, STYLE.jsonLine, STYLE.jsonClickable, STYLE.jsonFoldedHead, indentation),
          onClick: () => setOpen(!open),
          title: TEXT.historyTitle,
        },
        h(
          'span',
          { key: 't', style: { display: 'inline-block', width: '14px', color: pal.toggle, fontWeight: 700 } },
          open ? '▾' : '▸',
        ),
        h('span', { key: 'l', style: { color: pal.key, fontWeight: 600 } }, TEXT.historyGroup),
        h('span', { key: 'n', style: { color: pal.punct } }, ' (' + items.length + ')'),
        open
          ? null
          : h('span', { key: 'f', style: { marginLeft: '6px', color: pal.nil, fontSize: '11.5px' } }, TEXT.folded),
      );

      if (!open) return head;

      return h(
        'div',
        { style: STYLE.jsonNode },
        head,
        h(
          'div',
          { key: 'c', style: STYLE.jsonGuide },
          items.map((item, index) =>
            h(JsonNode, {
              key: offset + index,
              name: String(offset + index),
              value: item,
              depth: depth + 1,
              mode: mode,
              pal: pal,
            }),
          ),
        ),
      );
    }

    /**
     * A collapsible JSON node. Children are only created while the node is
     * open, which is what keeps a 500-message `messages` array cheap: the array
     * renders one collapsed line per message, not the whole tree.
     *
     * When a `messages` array is told where this Turn begins
     * (`messagesHistoryEnd`), the older messages collapse into one
     * `JsonHistoryGroup` line and the messages this turn produced keep their
     * real indices but sit on a tinted rail, so current content is visible
     * without unfolding anything.
     */
    function JsonNode(props) {
      const name = props.name;
      const value = props.value;
      const depth = props.depth;
      const mode = props.mode;
      const pal = props.pal || PALETTES.light;
      const isArray = Array.isArray(value);
      const isContainer = value !== null && typeof value === 'object';
      const indentation = { paddingLeft: depth * 14 + 'px' };
      const split = isArray && name === 'messages' && typeof props.messagesHistoryEnd === 'number';
      const historyEnd = split ? Math.max(0, Math.min(props.messagesHistoryEnd, value.length)) : 0;
      const band =
        props.current === true
          ? Object.assign({}, STYLE.jsonCurrent, {
              borderLeftColor: pal.currentBorder,
              background: pal.currentBg,
            })
          : null;
      const wrap = (style, node) => (style ? h('div', { style: style }, node) : node);
      /* Forwarded down to the `messages` array, which lives one level below the
         request root. */
      const childProps =
        typeof props.messagesHistoryEnd === 'number' ? { messagesHistoryEnd: props.messagesHistoryEnd } : null;

      const [open, setOpen] = React.useState(
        isContainer ? (mode === 'all' ? depth <= EXPAND_ALL_DEPTH : mode === 'none' ? false : depth < 2) : false,
      );

      const label = name === null || name === undefined ? null : h('span', { key: 'k', style: { color: pal.key, fontWeight: 600 } }, name);
      const colon = label ? h('span', { key: 'c', style: { color: pal.punct } }, ': ') : null;

      if (!isContainer) {
        return wrap(
          band,
          h(
            'div',
            { style: Object.assign({}, STYLE.jsonLine, indentation) },
            label,
            colon,
            h('span', { key: 'v', style: valueStyle(value, pal) }, literalOf(value)),
          ),
        );
      }

      const size = isArray ? value.length : Object.keys(value).length;
      const head = h(
        'div',
        {
          key: 'h',
          style: Object.assign({}, STYLE.jsonLine, STYLE.jsonClickable, indentation),
          onClick: () => setOpen(!open),
        },
        h('span', { key: 't', style: { display: 'inline-block', width: '14px', color: pal.toggle, fontWeight: 700 } }, open ? '▾' : '▸'),
        label,
        colon,
        h('span', { key: 'b', style: { color: pal.punct } }, isArray ? '[' : '{'),
        open ? null : h('span', { key: 'n', style: { color: pal.punct, fontStyle: 'italic' } }, ' ' + size + (isArray ? ' items' : ' keys') + ' '),
        split
          ? h(
              'span',
              {
                key: 'cur',
                style: Object.assign({}, STYLE.jsonBadge, {
                  color: pal.currentBorder,
                  borderColor: pal.currentBorder,
                  background: pal.currentBg,
                }),
              },
              TEXT.currentTurn + ' ' + (value.length - historyEnd),
            )
          : null,
        split && historyEnd > 0
          ? h('span', { key: 'his', style: Object.assign({}, STYLE.jsonBadgeMuted, { color: pal.punct }) }, TEXT.history + ' ' + historyEnd)
          : null,
        open ? null : h('span', { key: 'e', style: { color: pal.punct } }, isArray ? ']' : '}'),
      );

      if (!open) return wrap(band, head);

      let children;
      if (isArray && split && historyEnd > 0) {
        children = [
          h(JsonHistoryGroup, {
            key: 'history',
            items: value.slice(0, historyEnd),
            offset: 0,
            depth: depth + 1,
            mode: mode,
            pal: pal,
          }),
        ].concat(
          value.slice(historyEnd).map((item, index) =>
            h(JsonNode, {
              key: historyEnd + index,
              name: String(historyEnd + index),
              value: item,
              depth: depth + 1,
              mode: mode,
              pal: pal,
              current: true,
            }),
          ),
        );
      } else if (isArray) {
        children = value.map((item, index) =>
          h(JsonNode, { key: index, name: String(index), value: item, depth: depth + 1, mode: mode, pal: pal }),
        );
      } else {
        children = Object.keys(value).map((key) =>
          h(
            JsonNode,
            Object.assign({ key: key, name: key, value: value[key], depth: depth + 1, mode: mode, pal: pal }, childProps),
          ),
        );
      }

      return wrap(
        band,
        h(
          'div',
          { style: STYLE.jsonNode },
          head,
          h('div', { key: 'c', style: STYLE.jsonGuide }, children),
          h(
            'div',
            { key: 'f', style: Object.assign({}, STYLE.jsonLine, indentation) },
            h('span', { style: { color: pal.punct } }, isArray ? ']' : '}'),
          ),
        ),
      );
    }

    /**
     * "What changed since the previous call?" — one line per appended message,
     * plus an explicit warning whenever the payload was not merely extended.
     *
     * Within a Turn the Harness only appends, so the interesting cases are: the
     * model's reply and tool results of the previous step showing up at the tail
     * (expected), a message silently disappearing (compaction), or the sampling
     * parameters changing between calls. Each of those gets its own chip so the
     * reader never mistakes one for another.
     */
    function DiffPanel(props) {
      const diff = props.diff;
      const pal = props.pal || PALETTES.light;
      if (!diff || typeof diff !== 'object') return null;

      const added = Array.isArray(diff.added) ? diff.added : [];
      const changed = Array.isArray(diff.changed) ? diff.changed : [];

      const head = [
        h(
          'span',
          { key: 'l', style: STYLE.chipValue, title: TEXT.diffPrevTitle },
          TEXT.diffTitle + ' ' + (diff.prevMessages || 0) + ' ' + TEXT.messages,
        ),
        h(
          'span',
          { key: 'a', style: Object.assign({}, STYLE.chip, STYLE.chipAdded) },
          h('span', { key: 'l', style: STYLE.chipLabel }, TEXT.diffAdded),
          h('span', { key: 'v', style: Object.assign({}, STYLE.chipValue, STYLE.chipAddedValue) }, '+' + added.length),
        ),
        diff.removed > 0
          ? h(
              'span',
              { key: 'r', style: Object.assign({}, STYLE.chip, STYLE.chipWarn) },
              h('span', { key: 'l', style: STYLE.chipLabel }, TEXT.diffRemoved),
              h(
                'span',
                { key: 'v', style: Object.assign({}, STYLE.chipValue, STYLE.chipWarnValue) },
                '-' + diff.removed,
              ),
            )
          : null,
        diff.rewritten
          ? h(
              'span',
              { key: 'w', style: Object.assign({}, STYLE.chip, STYLE.chipWarn) },
              h('span', { key: 'v', style: Object.assign({}, STYLE.chipValue, STYLE.chipWarnValue) }, TEXT.diffRewritten),
            )
          : null,
        changed.length
          ? h(
              'span',
              { key: 'c', style: Object.assign({}, STYLE.chip, STYLE.chipWarn) },
              h('span', { key: 'v', style: Object.assign({}, STYLE.chipValue, STYLE.chipWarnValue) },
                TEXT.diffChanged + ': ' + changed.join(', ')),
            )
          : null,
      ];

      const roleColour = {
        user: pal.famPrompt,
        system: pal.famInjected,
        developer: pal.famInjected,
        assistant: pal.famModel,
        tool: pal.famTool,
      };

      const rows = added.map((entry) =>
        h(
          'div',
          { key: 'add-' + entry.index, style: STYLE.diffRow, title: entry.head || undefined },
          h('span', { key: 'i', style: STYLE.diffIndex }, '+' + entry.index),
          h(
            'span',
            { key: 'r', style: Object.assign({}, STYLE.diffRole, { color: roleColour[entry.role] || pal.punct }) },
            entry.role,
          ),
          h('span', { key: 'h', style: Object.assign({}, STYLE.diffHeadText, { color: pal.text }) }, entry.head || '—'),
        ),
      );

      return h(
        'div',
        { key: 'diff', style: STYLE.diffBox },
        h('div', { key: 'head', style: STYLE.diffHead }, head),
        added.length
          ? h('div', { key: 'list', style: STYLE.diffList }, rows)
          : h('div', { key: 'same', style: STYLE.diffHead }, TEXT.diffSame),
      );
    }

    /**
     * The whole Turn at a glance: one segment per model call.
     *
     * Sized by the tokens that call consumed (input + cache + output), which is
     * the only per-step cost the log records and the provider actually reports —
     * the log has no timestamps, and record counts barely move between a plain
     * reply and a tool round-trip. Under the bar each step states what it did:
     * how many tools it called, how many round-trips that took, and its tokens.
     *
     * Clicking a segment selects that call, so the strip doubles as navigation
     * for a Turn too long for tabs.
     */
    function Timeline(props) {
      const calls = Array.isArray(props.calls) ? props.calls : [];
      const onSelect = props.onSelect;
      const pal = props.pal || PALETTES.light;
      if (calls.length < 2) return null;

      const weights = calls.map((item) => {
        const usage = item.meta && item.meta.usage;
        const total = usage && typeof usage.total === 'number' ? usage.total : 0;
        return total > 0 ? total : 1;
      });
      const totalTokens = weights.reduce((acc, value) => acc + (value > 1 ? value : 0), 0);

      const segments = calls.map((item, position) => {
        const meta = item.meta || {};
        const chosen = position === props.selected;
        const toolCalls = typeof meta.toolCalls === 'number' ? meta.toolCalls : 0;
        const toolResults = typeof meta.toolResults === 'number' ? meta.toolResults : 0;
        const roundTrips = Math.min(toolCalls, toolResults);
        const usage = meta.usage || null;
        const parts = ['#' + (item.index || position + 1)];
        if (meta.step !== undefined) parts.push(TEXT.stepWord + ' ' + meta.step);
        parts.push(toolCalls ? toolCalls + ' ' + TEXT.toolCount : TEXT.toolNone);
        if (roundTrips) parts.push(roundTrips + ' ' + TEXT.roundTrips);
        parts.push(usage && usage.total ? formatTokens(usage.total) + ' ' + TEXT.tokens : TEXT.noUsage);
        if (meta.toolNames && meta.toolNames.length) parts.push(meta.toolNames.slice(0, 4).join(', '));
        if (chosen) parts.push(TEXT.timelineSelected);

        return h('button', {
          key: 'seg-' + position,
          type: 'button',
          style: Object.assign({}, STYLE.timelineSeg, {
            flex: String(weights[position]) + ' 1 0',
            background: chosen ? pal.famPrompt : pal.punct,
            opacity: chosen ? 1 : 0.55,
          }),
          title: parts.join(' · '),
          onClick: onSelect ? () => onSelect(position) : undefined,
        });
      });

      /* Below the bar, the steps that did the most work — reading a 20-step strip
         segment by segment is not how anyone finds the expensive step. */
      const ranked = calls
        .map((item, position) => ({ item: item, position: position, usage: (item.meta && item.meta.usage) || null }))
        .filter((entry) => entry.usage && entry.usage.total > 0)
        .sort((a, b) => b.usage.total - a.usage.total)
        .slice(0, 3);

      const heaviest = ranked.map((entry) => {
        const meta = entry.item.meta || {};
        const toolCalls = typeof meta.toolCalls === 'number' ? meta.toolCalls : 0;
        return h(
          'button',
          {
            key: 'heavy-' + entry.position,
            type: 'button',
            className: 'dsh-pl-heavy' + (entry.position === props.selected ? ' dsh-pl-step-on' : ''),
            style: STYLE.timelineHeavy,
            title: TEXT.timelineHeavyTitle,
            onClick: onSelect ? () => onSelect(entry.position) : undefined,
          },
          h('span', { key: 'n', style: STYLE.timelineHeavyNo }, '#' + (entry.item.index || entry.position + 1)),
          h('span', { key: 't', style: STYLE.timelineHeavyNum }, formatTokens(entry.usage.total)),
          toolCalls ? h('span', { key: 'c', style: STYLE.sourceMuted }, toolCalls + ' ' + TEXT.toolCount) : null,
        );
      });

      return h(
        'div',
        { key: 'timeline', style: STYLE.timeline },
        h(
          'div',
          { key: 'head', style: STYLE.timelineHead },
          h('span', { key: 't', style: STYLE.chipValue }, TEXT.timelineTitle),
          h('span', { key: 'n', style: STYLE.sourceMuted }, calls.length + ' ' + TEXT.callsShort),
        ),
        h('div', { key: 'track', style: STYLE.timelineTrack, title: TEXT.timelineHint }, segments),
        heaviest.length
          ? h(
              'div',
              { key: 'heavy', style: STYLE.timelineLabels },
              h('span', { key: 'l', style: STYLE.timelineHeavyLabel }, TEXT.timelineHeaviest),
              heaviest,
              h('span', { key: 'r', style: Object.assign({}, STYLE.sourceMuted, { marginLeft: 'auto' }) }, formatTokens(totalTokens)),
            )
          : null,
      );
    }

    /**
     * The header's diff slot: the first call of a Turn has nothing to compare
     * against, and saying so is better than showing an empty panel.
     */
    function DiffSlot(props) {
      if (!props.diff) return h('div', { key: 'diff-first', style: STYLE.diffHead }, TEXT.diffFirst);
      return h(DiffPanel, { key: 'diff', diff: props.diff, pal: props.pal });
    }

    /**
     * "Why is this request this long?" — one stacked bar plus a legend.
     *
     * Shares are message bytes rather than tokens: the log records text, the
     * provider reports tokens, and mapping one to the other would be a guess. The
     * bar answers "what is taking up room" honestly; the token chips next to it
     * remain the authoritative cost.
     */
    function SourcePanel(props) {
      const sources = props.sources;
      const fresh = props.fresh;
      const freshBytes = props.freshBytes;
      const pal = props.pal || PALETTES.light;

      if (!sources || !sources.counts) return null;

      const totalCount =
        sources.counts.prompt + sources.counts.injected + sources.counts.model + sources.counts.tool + sources.counts.other;
      if (!totalCount) return null;

      const label = {
        prompt: TEXT.sourceFamilyPrompt,
        injected: TEXT.sourceFamilyInjected,
        model: TEXT.sourceFamilyModel,
        tool: TEXT.sourceFamilyTool,
        other: TEXT.sourceFamilyOther,
      };
      const colour = {
        prompt: pal.famPrompt,
        injected: pal.famInjected,
        model: pal.famModel,
        tool: pal.famTool,
        other: pal.famOther,
      };
      /* Per-kind wording, so the legend can say "时间上下文 33" instead of the
         coarser family name once the bar is narrowed to one family. */
      const kindText = {
        user: TEXT.sourceKindUser,
        approval: TEXT.sourceKindApproval,
        timeContext: TEXT.sourceKindTimeContext,
        runtimeContext: TEXT.sourceKindRuntimeContext,
        skillCatalog: TEXT.sourceKindSkillCatalog,
        modelSelection: TEXT.sourceKindModelSelection,
        systemPrompt: TEXT.sourceKindSystemPrompt,
        toolRegistry: TEXT.sourceKindToolRegistry,
        jobReport: TEXT.sourceKindJobReport,
        model: TEXT.sourceKindModel,
        tool: TEXT.sourceKindTool,
        other: TEXT.sourceKindOther,
      };
      const order = ['prompt', 'injected', 'model', 'tool', 'other'];

      const segments = order
        .filter((key) => sources.counts[key] > 0)
        .map((key) =>
          h('div', {
            key: key,
            style: Object.assign({}, STYLE.sourceSeg, {
              flex: String(sources.counts[key]) + ' 1 0',
              background: colour[key],
            }),
            title: label[key] + ' · ' + sources.counts[key],
          }),
        );

      /* Collapsed by default: a five-family legend with every kind spelled out was
         five lines of text above the JSON, answering a question most visits do not
         ask. The compact row states the families; the kinds appear on demand. */
      const [openFamily, setOpenFamily] = React.useState('');

      const families = order.filter((key) => sources.counts[key] > 0);

      const chips = families.map((key) => {
        const members = (sources.kinds || [])
          .filter((item) => item.family === key)
          .map((item) => ({
            text: kindText[item.key] || kindText.other,
            count: item.count,
          }));
        const open = openFamily === key;
        const title = members.map((item) => item.text + ' ' + item.count).join(' · ');
        return h(
          'button',
          {
            key: key,
            type: 'button',
            className: 'dsh-pl-heavy' + (open ? ' dsh-pl-step-on' : ''),
            style: STYLE.sourceChip,
            title: title || undefined,
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpenFamily(open ? '' : key),
          },
          h('span', { key: 'd', style: Object.assign({}, STYLE.sourceDot, { background: colour[key] }) }),
          h('span', { key: 'l' }, label[key]),
          h('span', { key: 'n', style: STYLE.sourceNum }, formatExact(sources.counts[key])),
          h(
            'span',
            { key: 'p', style: STYLE.sourceMuted },
            Math.round((sources.counts[key] / totalCount) * 100) + '%',
          ),
          members.length > 1 ? h('span', { key: 'c', style: STYLE.sourceMuted }, open ? '▾' : '▸') : null,
        );
      });

      /* The one detail worth showing without a click: which kinds the selected
         family is made of, with their counts. */
      const openMembers =
        openFamily && openFamily !== ''
          ? (sources.kinds || [])
              .filter((item) => item.family === openFamily)
              .map((item) =>
                h(
                  'span',
                  { key: 'm-' + item.key, style: STYLE.sourceDetail },
                  h('span', { key: 't' }, kindText[item.key] || kindText.other),
                  h('span', { key: 'n', style: STYLE.sourceNum }, formatExact(item.count)),
                ),
              )
          : null;

      /* What this Turn itself wrote: the number that makes a growing context
         legible (a Turn that adds 150 messages explains itself instantly). */
      const freshCount =
        typeof fresh === 'number'
          ? fresh
          : fresh && fresh.counts
            ? fresh.counts.prompt + fresh.counts.injected + fresh.counts.model + fresh.counts.tool + fresh.counts.other
            : 0;
      if (freshCount > 0) {
        chips.push(
          h(
            'span',
            { key: 'fresh', style: Object.assign({}, STYLE.sourceChip, { marginLeft: 'auto', cursor: 'default' }), title: TEXT.sourceFreshTitle },
            h('span', { key: 'l' }, TEXT.sourceFresh),
            h('span', { key: 'n', style: Object.assign({}, STYLE.sourceNum, { color: pal.famPrompt }) }, formatExact(freshCount)),
            typeof freshBytes === 'number' && freshBytes > 0
              ? h('span', { key: 'b', style: STYLE.sourceMuted }, formatBytes(freshBytes))
              : null,
          ),
        );
      }

      return h(
        'div',
        { className: 'dsh-pl-sources', title: TEXT.sourceTitle },
        h('div', { key: 'bar', style: STYLE.sourceBar }, segments),
        h('div', { key: 'legend', style: STYLE.sourceLegend }, chips),
        openMembers && openMembers.length
          ? h('div', { key: 'detail', style: STYLE.sourceDetailRow }, openMembers)
          : null,
      );
    }

    // ------------------------------------------------------------ dialog body

    function DialogBody(props) {
      const payload = props.payload;
      const calls = payload.data && Array.isArray(payload.data.calls) ? payload.data.calls : [];
      const [selected, setSelected] = React.useState(
        typeof payload.selectedIndex === 'number' && payload.selectedIndex >= 0 ? payload.selectedIndex : 0,
      );
      const [mode, setMode] = React.useState('default');
      const [flash, setFlash] = React.useState('');
      const bodyRef = React.useRef(null);

      /* The payload is far taller than the viewport, so both a draggable scrollbar
         (see the .dsh-pl-scroll rules) and one-click ends are needed. */
      const jump = (where) => () => {
        const node = bodyRef.current;
        if (!node) return;
        node.scrollTop = where === 'end' ? node.scrollHeight : 0;
      };

      const index = calls.length ? Math.min(Math.max(selected, 0), calls.length - 1) : 0;
      const call = calls.length ? calls[index] : null;
      const meta = (call && call.meta) || {};
      const callCount = calls.length;
      const pal = PALETTES[payload.scheme === 'dark' ? 'dark' : 'light'];

      const totals = { total: 0, input: 0, cache: 0, output: 0 };
      for (let i = 0; i < calls.length; i += 1) {
        const itemUsage = calls[i].meta && calls[i].meta.usage;
        if (!itemUsage) continue;
        totals.total += itemUsage.total || 0;
        totals.input += itemUsage.input || 0;
        totals.cache += itemUsage.cache || 0;
        totals.output += itemUsage.output || 0;
      }

      /* A new call or a different expand mode is a different document: start at the top. */
      React.useEffect(
        () => {
          const node = bodyRef.current;
          if (node) node.scrollTop = 0;
        },
        [index, mode],
      );

      const flashDone = (label) => () => {
        setFlash(label);
        setTimeout(() => setFlash(''), 1200);
      };

      const copyCurrent = () => {
        if (!call) return;
        let text = '';
        try {
          text = JSON.stringify(call.request, null, 2);
        } catch (err) {
          text = String(err);
        }
        copyText(text, flashDone('copy'));
      };

      const copyAll = () => {
        if (!callCount) return;
        let text = '';
        try {
          text = JSON.stringify(
            calls.map((item) => item.request),
            null,
            2,
          );
        } catch (err) {
          text = String(err);
        }
        copyText(text, flashDone('all'));
      };

      const chip = (key, label, value, accent, title) =>
        h(
          'span',
          {
            key: key,
            title: title || undefined,
            style: accent ? Object.assign({}, STYLE.chip, STYLE.chipAccent) : STYLE.chip,
          },
          label ? h('span', { key: 'l', style: STYLE.chipLabel }, label) : null,
          h(
            'span',
            { key: 'v', style: accent ? Object.assign({}, STYLE.chipValue, STYLE.chipAccentValue) : STYLE.chipValue },
            value,
          ),
        );

      const metaChips = [];
      if (callCount > 1) metaChips.push(chip('call', null, '#' + (index + 1) + ' / ' + callCount));
      if (meta.model) metaChips.push(chip('model', null, String(meta.model)));
      if (typeof meta.messages === 'number')
        metaChips.push(chip('msgs', null, meta.messages + ' ' + TEXT.messages, false, TEXT.messagesTitle));
      if (typeof meta.historyEnd === 'number' && typeof meta.messages === 'number')
        metaChips.push(
          chip('current', TEXT.currentTurn, String(meta.messages - meta.historyEnd), true, TEXT.currentTitle),
        );
      if (typeof meta.tools === 'number') metaChips.push(chip('tools', null, meta.tools + ' ' + TEXT.tools));
      if (meta.reason) metaChips.push(chip('reason', TEXT.reasonLabel, meta.reason));
      const bodyBytes = (() => {
        try {
          return JSON.stringify(call ? call.request : '').length;
        } catch (err) {
          return 0;
        }
      })();
      if (bodyBytes > 0)
        metaChips.push(chip('bytes', TEXT.bytesLabel, formatBytes(bodyBytes), false, TEXT.bytesTitle));

      const usageChips = [];
      const currentUsage = meta.usage || null;
      if (currentUsage) {
        usageChips.push(chip('in', TEXT.usageInput, formatExact(currentUsage.input), false, TEXT.usageInputTitle));
        usageChips.push(
          chip(
            'cache',
            TEXT.usageCache,
            formatExact(currentUsage.cache) +
              (currentUsage.hitRate === null ? '' : ' · ' + Math.round(currentUsage.hitRate * 100) + '%'),
            false,
            TEXT.usageCacheTitle,
          ),
        );
        usageChips.push(chip('out', TEXT.usageOutput, formatExact(currentUsage.output), false, TEXT.usageOutputTitle));
        usageChips.push(
          chip('total', TEXT.usageTotal, formatExact(currentUsage.total), true, TEXT.usageTotalTitle),
        );
        if (callCount > 1)
          usageChips.push(chip('turn', TEXT.turnTotal, formatExact(totals.total), true, TEXT.turnTotalTitle));
      } else {
        usageChips.push(chip('none', null, TEXT.usageNone));
      }

      const header = h(
        'div',
        { key: 'header', style: STYLE.dialogHeader },
        h(
          'div',
          { key: 'row-top', style: STYLE.headerRow },
          h('span', { key: 'title', style: STYLE.dialogTitle }, payload.title),
          h(
            'div',
            { key: 'actions', style: STYLE.headerActions },
            h(
              'button',
              {
                key: 'to-top',
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: jump('start'),
                style: STYLE.smallButton,
                title: TEXT.toTop,
                'aria-label': TEXT.toTop,
              },
              '↑',
            ),
            h(
              'button',
              {
                key: 'to-end',
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: jump('end'),
                style: STYLE.smallButton,
                title: TEXT.toEnd,
                'aria-label': TEXT.toEnd,
              },
              '↓',
            ),
            h(
              'button',
              {
                key: 'copy',
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: copyCurrent,
                style: STYLE.smallButton,
              },
              flash === 'copy' ? TEXT.copied : TEXT.copy,
            ),
            callCount > 1
              ? h(
                  'button',
                  {
                    key: 'copy-all',
                    type: 'button',
                    className: 'dsh-pl-btn',
                    onClick: copyAll,
                    style: STYLE.smallButton,
                  },
                  flash === 'all' ? TEXT.copied : TEXT.copyAll,
                )
              : null,
            h(
              'button',
              {
                key: 'expand',
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: () => setMode(mode === 'all' ? 'default' : 'all'),
                style: STYLE.smallButton,
              },
              mode === 'all' ? TEXT.collapseAll : TEXT.expandAll,
            ),
            h(
              'button',
              {
                key: 'close',
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: () => publishDialog(null),
                style: STYLE.smallButton,
                title: TEXT.close,
                'aria-label': TEXT.close,
              },
              '✕',
            ),
          ),
        ),
        h('div', { key: 'row-meta', style: STYLE.chips }, metaChips),
        h('div', { key: 'row-usage', style: STYLE.chips }, usageChips),
        call ? h(DiffSlot, { key: 'row-diff', diff: meta.diff, pal: pal }) : null,
        callCount > 1
          ? h(Timeline, {
              key: 'row-timeline',
              calls: calls,
              selected: index,
              onSelect: setSelected,
              pal: pal,
            })
          : null,
        call
          ? h(SourcePanel, {
              key: 'row-sources',
              sources: meta.sources,
              fresh: meta.messages - meta.historyEnd,
              freshBytes: meta.freshBytes,
              pal: pal,
            })
          : null,
      );

      /* Tabs while they still fit; a step list beyond TAB_LIMIT. */
      let picker = null;
      if (callCount > 1 && callCount <= TAB_LIMIT) {
        picker = h(
          'div',
          { key: 'tabs', style: STYLE.tabs },
          calls.map((item, position) => {
                const itemMeta = item.meta || {};
                const stepLabel = itemMeta.step !== undefined ? itemMeta.step : position + 1;
                return h(
                  'button',
                  {
                    key: 'call-' + (item.index || position + 1),
                    type: 'button',
                    className: position === index ? 'dsh-pl-tab dsh-pl-tab-on' : 'dsh-pl-tab',
                    onClick: () => setSelected(position),
                    style: Object.assign({}, STYLE.tab, position === index ? STYLE.tabActive : null),
                    title:
                      TEXT.callPrefix +
                      (position + 1) +
                      '/' +
                      callCount +
                      TEXT.callSuffix +
                      ' · step ' +
                      stepLabel +
                      (itemMeta.model ? ' · ' + itemMeta.model : '') +
                      (typeof itemMeta.messages === 'number' ? ' · ' + itemMeta.messages + ' ' + TEXT.messages : '') +
                      (typeof itemMeta.tools === 'number' ? ' · ' + itemMeta.tools + ' ' + TEXT.tools : ''),
                  },
                  h('span', { key: 'i', style: STYLE.tabIndex }, '#' + (item.index || position + 1)),
                  h(
                    'span',
                    { key: 'm', style: STYLE.tabMeta },
                    'step ' +
                      stepLabel +
                      ' · ' +
                      (itemMeta.messages || 0) +
                      ' ' +
                      TEXT.messages +
                      (itemMeta.usage && typeof itemMeta.usage.total === 'number'
                        ? ' · ' + formatTokens(itemMeta.usage.total)
                        : ''),
                  ),
                );
              }),
        );
      }

      /* Past TAB_LIMIT the calls move into a column: every row keeps its number, step,
         message count and tokens, and the JSON pane gets the rest of the width — far
         easier to scan than a dropdown of dozens of one-line options. */
      const stepRefs = React.useRef([]);

      React.useEffect(
        () => {
          const node = stepRefs.current[index];
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
        },
        [index],
      );

      const onStepsKeyDown = (event) => {
        const key = event && event.key;
        if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        const next =
          key === 'ArrowDown'
            ? Math.min(callCount - 1, index + 1)
            : key === 'ArrowUp'
              ? Math.max(0, index - 1)
              : key === 'Home'
                ? 0
                : callCount - 1;
        if (next === index) return;
        setSelected(next);
        const node = stepRefs.current[next];
        if (node && typeof node.focus === 'function') node.focus();
      };

      let stepList = null;
      if (callCount > TAB_LIMIT) {
        stepList = h(
          'div',
          {
            key: 'steps',
            className: 'dsh-pl-scroll',
            style: STYLE.stepList,
            role: 'listbox',
            'aria-label': TEXT.title,
            onKeyDown: onStepsKeyDown,
          },
          calls.map((item, position) => {
            const itemMeta = item.meta || {};
            const stepLabel = itemMeta.step !== undefined ? itemMeta.step : position + 1;
            const active = position === index;
            return h(
              'button',
              {
                key: 'step-' + (item.index || position + 1),
                ref: (node) => {
                  stepRefs.current[position] = node;
                },
                type: 'button',
                role: 'option',
                'aria-selected': active ? 'true' : 'false',
                className: active ? 'dsh-pl-step dsh-pl-step-on' : 'dsh-pl-step',
                onClick: () => setSelected(position),
                style: Object.assign({}, STYLE.stepRow, active ? STYLE.stepRowActive : null),
                title:
                  TEXT.callPrefix +
                  (position + 1) +
                  '/' +
                  callCount +
                  TEXT.callSuffix +
                  ' · step ' +
                  stepLabel +
                  (itemMeta.model ? ' · ' + itemMeta.model : '') +
                  (typeof itemMeta.messages === 'number'
                    ? ' · ' + itemMeta.messages + ' ' + TEXT.messages
                    : ''),
              },
              h(
                'span',
                { key: 'top', style: STYLE.stepRowTop },
                h('span', { key: 'no', style: STYLE.stepNo }, '#' + (item.index || position + 1)),
                itemMeta.usage && typeof itemMeta.usage.total === 'number'
                  ? h('span', { key: 'tk', style: STYLE.stepAside }, formatTokens(itemMeta.usage.total))
                  : null,
              ),
              h(
                'span',
                { key: 'sub', style: STYLE.stepSub },
                'step ' + stepLabel + ' · ' + (itemMeta.messages || 0) + ' ' + TEXT.messages +
                  (typeof itemMeta.historyEnd === 'number'
                    ? ' · ' + TEXT.currentTurn + ' ' + ((itemMeta.messages || 0) - itemMeta.historyEnd)
                    : ''),
              ),
            );
          }),
        );
      }

      const body = h(
        'div',
        { key: 'body', ref: bodyRef, className: 'dsh-pl-scroll', style: STYLE.dialogBody, title: TEXT.railTitle },
        call
          ? h(JsonNode, {
              key: mode + ':' + index,
              name: null,
              value: call.request,
              depth: 0,
              mode: mode,
              pal: pal,
              /* Where this Turn's own messages start inside request.messages. */
              messagesHistoryEnd: meta.historyEnd,
            })
          : h('div', { style: STYLE.note }, TEXT.empty),
      );

      /* Only worth saying when the log carries far more than the model reads. */
      const foot =
        call && typeof meta.messages === 'number' && meta.messages > 200
          ? h('div', { key: 'foot', style: STYLE.dialogFoot }, TEXT.compressNote)
          : null;

      /* The rail reads its colours from these custom properties, so the same
         stylesheet serves both colour schemes without a scheme class. */
      const dialogStyle = Object.assign({}, STYLE.dialog, {
        '--dsh-pl-sb-track': pal.scTrack,
        '--dsh-pl-sb-thumb': pal.scThumb,
        '--dsh-pl-sb-thumb-hover': pal.scThumbHover,
        '--dsh-pl-sb-thumb-active': pal.scThumbActive,
      });

      return h(
        'div',
        { style: dialogStyle, onClick: (event) => event.stopPropagation() },
        header,
        picker,
        stepList ? h('div', { key: 'split', style: STYLE.split }, stepList, body) : body,
        foot,
      );
    }

    /** The `shell.overlay` entry: renders nothing until a button publishes. */
    function PayloadOverlay() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => subscribeDialog(bump), []);

      const payload = dialogPayload;

      React.useEffect(
        () => {
          if (!payload) return undefined;
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
          const onKeyDown = (event) => {
            if (event && event.key === 'Escape') publishDialog(null);
          };
          document.addEventListener('keydown', onKeyDown);
          return () => document.removeEventListener('keydown', onKeyDown);
        },
        [payload ? payload.id : 0],
      );

      if (!payload) return null;

      let inner;
      if (payload.status === 'ready' && payload.data) {
        inner = h(DialogBody, { key: payload.id, payload });
      } else {
        const message =
          payload.status === 'error' ? TEXT.error + payload.message : payload.status === 'empty' ? TEXT.empty : TEXT.loading;
        inner = h(
          'div',
          { style: Object.assign({}, STYLE.dialog, { maxHeight: '40vh' }), onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { style: STYLE.dialogHeader },
            h('span', { style: STYLE.dialogTitle }, payload.title),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-pl-btn',
                onClick: () => publishDialog(null),
                style: STYLE.smallButton,
                title: TEXT.close,
              },
              '✕',
            ),
          ),
          h('div', { style: STYLE.dialogBody }, h('div', { style: STYLE.note }, message)),
        );
      }

      return h('div', { style: STYLE.backdrop, onClick: () => publishDialog(null) }, inner);
    }

    // ------------------------------------------------------------ the plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        /** Resolve the Client sessions service lazily, so a missing service cannot break a render. */
        const sessionsOf = () => {
          try {
            return ctx.get('sessions');
          } catch (err) {
            return undefined;
          }
        };

        /**
         * Load the whole Client event window for one session, walking older pages
         * until nothing older remains.
         *
         * The prefix matters: a request carries the ENTIRE conversation so far, so
         * rebuilding one call from a partial window would silently drop messages.
         * A full walk also guarantees the Turn boundaries (`turn/start`) are
         * present before `buildTurnCalls` runs.
         */
        const readWindow = async (sessionId) => {
          const sessions = sessionsOf();
          if (!sessions || typeof sessions.binding !== 'function') throw new Error('sessions service unavailable');
          const binding = sessions.binding(sessionId);
          if (!binding) throw new Error('session is not bound');
          const session = binding.session;
          const source = binding.eventSource;

          const snapshotOf = () =>
            source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
          const entriesOf = (snapshot) => (snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : []);

          let snapshot = snapshotOf();
          let guard = 0;
          while (
            snapshot &&
            snapshot.hasMore === true &&
            guard < 200 &&
            session &&
            typeof session.loadOlder === 'function'
          ) {
            guard += 1;
            const before = entriesOf(snapshot).length;
            await session.loadOlder();
            snapshot = snapshotOf();
            if (!snapshot) break;
            if (entriesOf(snapshot).length <= before) break;
          }
          return collectEvents(entriesOf(snapshot));
        };

        /**
         * The action row hands us a durable message id, so resolve that message to
         * its Turn and step first, then rebuild the whole Turn and pre-select the
         * call that produced it.
         */
        const buildTurnForMessage = async (sessionId, messageId) => {
          try {
            if (!messageId) throw new Error('no message id');
            const events = await readWindow(sessionId);

            const spot = locateMessage(events, messageId);
            if (!spot) return { status: 'empty' };

            let lastSeq = 0;
            for (let i = 0; i < events.length; i += 1) {
              const seq = seqOf(events[i]);
              if (seq > lastSeq) lastSeq = seq;
            }
            const cacheKey =
              String(sessionId) + ':' + String(spot.turn) + ':' + String(lastSeq);
            let built = builtCache.get(cacheKey);
            if (!built) {
              built = buildTurnCalls(events, spot.turn);
              if (built) rememberBuilt(cacheKey, built);
            }
            if (!built || !Array.isArray(built.calls) || !built.calls.length) return { status: 'empty' };

            return {
              status: 'ready',
              data: built,
              selectedIndex: callIndexForStep(built, spot.step),
              step: spot.step,
            };
          } catch (err) {
            return { status: 'error', message: String((err && err.message) || err) };
          }
        };

        function PayloadButton(props) {
          const messageId = props.messageId;
          const sessionId = props.sessionId;

          const readScheme = () => {
            try {
              const theme = ctx.get('theme');
              const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null;
              const active = snapshot && snapshot.active ? snapshot.active.colorScheme : null;
              if (active === 'dark' || active === 'light') return active;
            } catch (err) {
              /* fall through to the media query */
            }
            try {
              if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
                return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
              }
            } catch (err) {
              /* default below */
            }
            return 'light';
          };

          /* The label is positioned from the trigger's own rect: the shipped tooltips
             are portalled for exactly this reason, and a bubble inside the message
             flow would be clipped by the scroller near the bottom of the page. */
          const triggerRef = React.useRef(null);
          const [tip, setTip] = React.useState(null);

          const showTip = () => {
            const node = triggerRef.current;
            if (!node || typeof window === 'undefined') return;
            const rect = node.getBoundingClientRect();
            const below = rect.bottom + 6;
            /* Below, like the rest of the row — unless there is no room left. */
            const side = window.innerHeight - below >= 30 ? 'bottom' : 'top';
            setTip({
              side: side,
              left: rect.left + rect.width / 2,
              top: side === 'bottom' ? below : rect.top - 6,
            });
          };

          const hideTip = () => setTip(null);

          const openDialog = () => {
            hideTip();
            const scheme = readScheme();
            publishDialog({ status: 'loading', title: TEXT.title, scheme: scheme });
            buildTurnForMessage(sessionId, messageId).then(function (result) {
              const built = result.status === 'ready' && result.data ? result.data : null;
              const title = built
                ? TEXT.title +
                  ' · Turn ' +
                  built.turn +
                  (typeof result.step === 'number' ? ' · step ' + result.step : '')
                : TEXT.title;
              publishDialog(Object.assign({ title: title, scheme: scheme }, result));
            });
          };

          /* Icon first, name on hover: the shipped row is icon-only, and a text
             button there would break its rhythm. */
          return h(
            'button',
            {
              type: 'button',
              ref: triggerRef,
              className: 'dsh-pl-action',
              'aria-label': TEXT.show,
              onClick: openDialog,
              onMouseEnter: showTip,
              onMouseLeave: hideTip,
              onFocus: showTip,
              onBlur: hideTip,
            },
            h(
              'svg',
              {
                className: 'dsh-pl-icon',
                viewBox: '0 0 16 16',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': 'true',
              },
              h('path', {
                d:
                  'M6.2 2.5H5.4C4.3 2.5 3.6 3.2 3.6 4.3V5.9C3.6 6.9 3.1 7.6 2.2 7.8V8.2' +
                  'C3.1 8.4 3.6 9.1 3.6 10.1V11.7C3.6 12.8 4.3 13.5 5.4 13.5H6.2',
              }),
              h('path', {
                d:
                  'M9.8 2.5H10.6C11.7 2.5 12.4 3.2 12.4 4.3V5.9C12.4 6.9 12.9 7.6 13.8 7.8V8.2' +
                  'C12.9 8.4 12.4 9.1 12.4 10.1V11.7C12.4 12.8 11.7 13.5 10.6 13.5H9.8',
              }),
            ),
            tip
              ? h(
                  'span',
                  {
                    key: 'tip',
                    role: 'tooltip',
                    className: 'dsh-pl-tip',
                    style: {
                      left: tip.left + 'px',
                      top: tip.top + 'px',
                      transform:
                        tip.side === 'bottom' ? 'translate(-50%,0)' : 'translate(-50%,-100%)',
                    },
                  },
                  TEXT.show,
                )
              : null,
          );
        }

        /* Sit beside the shipped per-message actions (copy, good/bad answer),
           matching the durable assistant message they belong to. */
        ensureActionStyle();
        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.assistant-actions',
              id: 'payload',
              order: 15,
              label: () => TEXT.show,
            },
            PayloadButton,
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'payload.dialog',
              order: 900,
            },
            PayloadOverlay,
          ),
        );
      },
    };
  },
});


