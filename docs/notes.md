# 实现说明

这份文档记录 `dsh-payload` 的实现细节与踩坑记录，供想改代码的人参考。使用者只需要读 [README](../README.md)。

## 位置：为什么挂在 assistant 操作行

挂载点是 `conversation.chat.assistant-actions`（每条**已定稿**的 assistant 消息下方的操作行，list slot，`replaceRisk: none`）。入参只有 `messageId`（外加 `sessionId` 等标准 props），所以按钮天然和官方那几个操作图标排在同一行。

点击时的解析链路：

1. `messageId` → 日志里 `assistant/message.data.message.id` 相等的那条事件（窗口里还没有就靠 `loadOlder()` 往前翻）
2. 该事件的 `{turn, step}` —— `step` 就是「第几次调用」
3. 重建整个 Turn（`buildTurnCalls`），选中 `meta.step === step` 的那个 call

因此每条回复的按钮指向的正是**产生这条回复的那一次调用**，而不是这一轮的最后一次。

> 早期版本挂在 `conversation.chat.turnTail`（Turn 底部的扩展位），只能给出「这一轮最后一次调用」，无法定位到某条具体回复，所以改到了 assistant 操作行。

之所以不贴在那条**用户**消息下方：用户消息那一行（`conversation.chat.node` 的 `user` key）和 `conversation.chat.user.content` 都是**替换型**插槽，占用即替换官方渲染。官方 `ui-chat` 的文档明确写着 `UserStyleBubble` 与 source-specific wrappers 承载了用户行的时间戳、copy 控件、pending/本地 echo 标记、消息操作，而 `conversation.chat.user.content` Factory 只渲染内容栈、不是全局用户内容覆盖入口，直接调用者要自己提供 row wrapper。影子替换 `user` 节点 = 从头重写整行用户气泡（内置实现不随包发布，只有打包后的 `lib/client.js`），每条用户消息的观感都会退化。会话内也不存在 `conversation.chat.user.actions` 这类可扩展的 list slot（已用 Slots inspect 全树确认）。

## 读取方式

只有点击时才读：

1. `sessions.binding(sessionId)` 拿到 `session` + `eventSource`
2. **走完整窗口**：只要 `hasMore === true` 就 `session.loadOlder()`（上限 200 页）。不能「找到目标消息就停」——请求体含此前的全部对话，窗口缺前缀会静默丢消息，Turn 的 `turn/start` 也可能还没翻出来
3. 用命中的事件拿到 `{turn, step}`，再用本轮的 `turn/start` / `turn/end`（或下一个 `turn/start`）确定整轮边界
4. 上界内每个 `step/start` 切一份：取该 step 的**首个响应事件**（`assistant/attempt` / `assistant/message`）作为切点，折叠它之前的所有 surface 事件形成 `messages`，并沿用该 step 之前最近的一条 `request/header` 作为调用参数
5. 用 `meta.step === step` 选中那一次调用（弹框直接停在这条回复对应的调用上）
6. 结果缓存在模块级 Map，键是 `sessionId + turn + 窗口末端 seq`——带上窗口长度，Turn 还在增长时不会命中过期结果；Map 超过 40 条整体清空

## 首开耗时：一次折叠，而不是每步重扫

第一版每个切点都调一次 `buildMessages(events, cutSeq, …)`，每次都从窗口第一个事件重新折叠到该切点，于是 169 次调用的 Turn 变成了 169 次全量回放，Node 里 11.4 s。现在：

- `FoldState` 顺序把事件吃进「已折叠消息」和每条消息的 `items[]`（同一条消息的事件组），`snapshotAt(cutSeq)` 只让游标前进到切点，然后返回 `messages.slice(0, n)` 加一份长度记录。第 k 步的数组是上一份的前缀，**引用共享**——所以 `diffRequests` 的公共前缀可以用 `===` 判断完，不必逐条 stringify。
- 来源分类（`summarizeSources`）同理改成前缀累加：`newSourceAcc` / `foldSourceInto` / `snapshotSourceAcc`，整轮一份、本轮再从 `historyEnd` 起一份。
- `diffRequests` 里 `messages` 之外的字段（model、采样参数、`tools`）先比引用：同一 Turn 内 `tools` 是同一个数组，直接相等就跳过 stringify。
- 真实会话实测（Node）：Turn 3（61 次调用）11 ms、Turn 55（120 次）57 ms、Turn 71（169 次）101 ms、Turn 76（111 次）83 ms；整份日志的 `JSON.parse` 约 583 ms 是 `loadOlder()` 那一步的一次性成本，与调用次数无关。


## 分组的几个细节

- 切点是该 step 的**首个响应事件**，不是 `step/start`：本轮的运行时上下文注入（`Time sampled while preparing turn N, step M…` 这类 `user/message`）是在 `step/start` **之后**才写进日志的，用 `step/start` 当切点会把它们漏掉，`messages` 甚至可能为空。
- 因为切点是逐次推进的，第 2 次调用天然包含第 1 次的 assistant 消息和 `tool/result`——**逐次累积**，与真实请求一致。
- 标签页的 `title` 与面板摘要都带 `messages` 条数、`tools` 个数和 `reason`；`reason` 来自继承到的 header，只说明这份配置是何时写的，不代表本次调用的类型（`initial` / `change` / `resume` / `series`）。
- 只有 1 次调用时不显示卡片，退化成单个浏览视图（`请求` / `响应` 这一对仍保留）；超过 12 次换成左侧 step 列表（一个 Turn 可能有几十次调用）——下拉框只能塞下一行 `#k`，看不到 step 号、消息条数和 token，列表都能看到，且右侧 JSON 仍占满剩余宽度。
- 上界不依赖插槽的 `seq`（那只是兜底），避免 `seq` 恰好落在某个中间事件时把后面的调用截掉。

## 踩过的坑

**不要在 Slot 组件里调用 `props.useSessions()` 之类的“看起来像 hook”的注入属性。** 首次实现时在组件顶层调用了它，渲染期抛错后框架会**剥夺（abdicate）**该条目：按钮完全不渲染，而 `Slots` inspect 里该条目的 `active` 变成 `false`。诊断顺序是：先挂两个零依赖的静态探针（`conversation.composer.dock` / `turnTail`）二分定位——两个探针都出现即说明插件加载正常，问题在组件自身；然后把服务获取改成**点击时**再 `ctx.get('sessions')`，渲染期不依赖任何注入服务。

**不要用 `request/header` 当作调用边界。** 第一版就是这么写的，结果一次调用都分不出来（卡片永远不出现）。`request/header` 只在调用配置变化时写一条，密集工具调用的 Turn 里可能一次都没有（实测一个 1148 条记录的会话里只有 5 条，而 `step/start` 有 186 条）。分组锚点必须是 `step/start`，配置则从不超过该 step 的最近一条 header 继承。

**`system/message` / `user/message` 是增量记录。** 空的 `content: []` 表示“这一轮没有新增”，不是“发送一条空消息”，重建时必须跳过，否则会把模型根本没收到过的空 system 塞进 payload。

**内联样式做不出 `:hover`。** 图标按钮要在悬停时浮出文字气泡，而 `style={}` 无法表达伪类。做法是在 `apply()` 里往 `document.head` 注入一份 `<style>`（`id` 固定、幂等、只用 `.dsh-pl-` 前缀，避免和官方类名打架），按钮用 `className` 而非 `style`。注入失败只影响观感，组件照常工作。

**不要凭印象写 CSS 变量名。** 弹框第一版用了 `--dsw-alias-bg-primary` / `--dsw-alias-text-primary` 这类**不存在**的 token，于是全部走 fallback：背景是随手写的暗色 `#1f2023`，文字色 fallback 到 `inherit`（浅色主题下就是深色字），于是深底深字糊成一片。正确做法是先查 client 的 `Theme` inspect provider（`listTokens`）拿真实清单——本 Harness 的 `listTokens` 只收录 14 个语义色：`bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-overlay` / `border-l1` / `border-l2` / `brand-primary` / `label-primary` / `label-secondary` / `state-{error,idle,success,warn}-primary` / `specific-sidebar-fill`。改完跑一次「用到的 `--dsw-*` 是否都在清单内」的静态对账，且 fallback 要按**浅色**主题给（深色主题下真 token 一定存在，fallback 只可能在浅色或第三方主题里被用到）。

**`listTokens` 不是全集，别把它当白名单。** 那 14 个只是 `alias` 语义色里被 provider 收录的一部分；真正定义 token 的是两处：`dsh-client-ui-theme/lib/client.js`（整张 `--dsw-*` 变量表，浅/深两套）和 `dsh-web-frontend/dist/assets/index-*.css`（组件级规则）。图标按钮、tooltip 用到的 `--dsw-alias-label-tertiary`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-tooltip-bg`、`--dsw-radius-sm`、`--dsw-focus-ring-*` 都在那里。查法：从 `app.asar` 里按 `size/offset` 抽出目标 `lib/client.js` 与前端 CSS 再搜（仓库里的 `tools/asar-extract.cjs` 就是那次的脚本），比猜名字快得多。

**照着官方组件的真样式写，而不是“看着差不多”。** 图标动作按钮的权威定义在 `dsh-client-ui-message-feedback/lib/client.js` 的 `_action` 规则里：`28×28`、`radius-sm`、`padding 6px`、`svg 15×15`、静止色 `label-tertiary`、hover `interactive-bg-hover` + `label-secondary`；tooltip 的气泡在前端 CSS 的 `_bubble` 规则里：`padding 3px 7px`、`radius-sm`、背景 `alias-tooltip-bg`、文字 `static-neutral-bluish-00`、`13px/20px`、`0.15s` 淡入。照抄这几个值，才和「复制 / 好的回答 / 有问题的回答」那排图标长得一模一样。

**悬停气泡要用 `position: fixed`。** 气泡若用 `absolute` 挂在自己身上，会被会话滚动容器在页面底部裁掉；官方 Tooltip 走 portal + fixed 就是为了这个。这里不引 `react-dom`、不建 portal：气泡仍是组件子节点，但用 `position: fixed` + 悬停时读 `getBoundingClientRect()` 计算 `left/top`，只在下方空间不足（`innerHeight` 剩不到 30px）时翻到上方。

**token 统计只信 provider 上报，不要自己估。** `assistant/message.data.usage` 是响应里带回的真实用量；自己按字符数估算会在中文、工具 JSON、缓存命中等情况下偏出数倍。

## 字体与视觉尺寸

`Theme.listTokens` 只有颜色 token，没有任何字体/行高 token，所以排版不引用变量，靠一张手写的 `T` 表（`client.js` 里 `STYLE` 之前）统一收口。**改观感只改 `T`，不要在 `STYLE` 里再写字面值**，否则又会漂回 10.5 / 11.5 / 12.5 这种半像素档。

- **字体继承 `inherit`**：只有 payload 正文换成等宽栈（`ui-monospace, SFMono-Regular, …`），标题、chips、按钮全部跟随应用字体——自带一套字体栈就会立刻显得“不是同一个软件”。
- **四级字号（`T.font`）**：14 正文 / 13 控件 / 12 说明 / 11 微标签，行高 22 / 18 / 18 / 16。**不要用半像素字号**（10.5 / 11.5 / 12.5）：小数 DPR 下会发糊，也和官方的 13 / 14 两档不成梯队——第一版正是这样写的，于是“看着不搭”。
- **圆角只用语义级（`T.radius`）**：`radius-sm` 8（按钮、chips、step 行）/ `radius-lg` 12 / `radius-panel` 16（弹框）/ 999 胶囊（进度条、计数徽标）/ 4px（`xs`，只给仪表里的分段）。原来 2 / 4 / 6 / 8 / 12 / 999 六档混用，是“碎”的主因。
- **边框用发丝线（`T.hair`）**：官方 chip 与 textarea 都是 `0.5px solid var(--dsw-alias-border-l4)`；写 `1px + border-l1` 会把每个控件都压成“灰掉”的样子。`T.hair` 对 `l4` 做了嵌套兜底（老主题只发布 `l1`）。
- **焦点环走 token（`T.focus`）**：`--dsw-focus-ring-width` / `--dsw-focus-ring-color`，兜底 `state-business-primary`；别再硬编码 `2px solid brand-primary`。
- **数字用 `tabular-nums`**：token 数、消息条数、`#k / N` 在切换时不会跳动。
- **悬停/焦点靠注入的 CSS**：`.dsh-pl-btn` / `.dsh-pl-step` / `.dsh-pl-side` / `.dsh-pl-pill` 补 `:hover`、`:focus-visible`，并在 `prefers-reduced-motion` 下关掉过渡与气泡动画。
- **滚动条**：10px 宽、不画轨道、中性 thumb（激活态不发蓝）。理由是 100k 行 payload 需要能拖的常显滚动条，而官方 overlay 条太细会让人“盲拖”；但不该因此长成 IDE 的样子。
- **触发器照抄官方动作按钮**：`28×28`、`radius-sm`、`padding 6px`、`svg 15×15`、静止 `label-tertiary`、hover `interactive-bg-hover`；气泡用 `alias-tooltip-bg` + `static-neutral-bluish-00`（黑底白字）、`13px/20px`、`3px 7px`、`radius-sm`，在**下方**弹出（和同一排的“复制 / 好的回答”一致），空间不足时才翻到上方。

**还没做的**（按影响排序）：`role="dialog"` / `aria-modal` / 焦点陷阱 / portal 到 `body`、`88vh × 1040px` 的“应用窗口”尺寸收敛、阴影 token 化、JSON 语法色改走官方 shiki 高亮。

## 内部结构

`client.js` 里有两块 UI：

- `PayloadButton`：注册在 `conversation.chat.assistant-actions`，渲染一个 `{ }` 图标按钮（悬停出气泡），只负责把 `messageId` 重建为「本轮第几次调用」并把结果 publish 给弹框
- `PayloadOverlay`：注册在 `shell.overlay`，是**唯一**的弹框实例；它订阅一个模块级 pub/sub（`publishDialog` / `subscribeDialog`），所以同一个页面里无论哪个按钮点击都复用这一个弹框，切换标签页或 step 时不需要重新挂载 DOM

`client.js` 底部有一个 `globalThis.__DSH_PAYLOAD_TEST__` 开关，只在置位时把内部函数挂到 `globalThis.__DSH_PAYLOAD_INTERNALS__`（给 Node 里的验证脚本用），浏览器里永不触发。

改完 `client.js` 后刷新界面即可生效（profile 里是 `link:` 依赖，不需要重装；桌面端是 `Ctrl+R`，偶尔要退出重开）。

## messages 里区分历史与本轮

- 切分依据：这条回复所属 Turn 的 `turn/start.seq`。`buildMessages(events, cutSeq, turnStartSeq)` 折叠消息数组时，记下第一条 `seq >= turnStartSeq` 的消息下标作为 `historyEnd`，挂在 `call.meta.historyEnd` 上——**不写进 `request`**，payload 保持和实际发出的那份一致。
- 渲染：`JsonNode` 收到 `messagesHistoryEnd`（只对 `messages` 数组生效，并向下透传一层）后，把前 `historyEnd` 条收进 `JsonHistoryGroup`（一行 `历史消息 (n)` + 「已折叠」提示），其后的消息用真实下标渲染并套上 `STYLE.jsonCurrent`：左边缘 2px 品牌色竖线 + 淡色底，颜色取自 `PALETTES[scheme].currentBorder/currentBg`。`marginLeft:-10px` 配 `paddingLeft:10px` 让竖线正好压在 `jsonGuide` 的引导线上，文字位置不变，连续几条本轮消息连成一条通栏竖线。
- 折叠只是显示层：展开后下标仍是数组里的真实下标（用 `offset` 传给子节点），复制出来的 JSON 一字不差。
- 「全部展开」会把历史组一起展开（`JsonHistoryGroup` 的初始态是 `mode === 'all'`）；`messages` 标题上另有 `本轮 n` / `历史 n` 两个计数，弹框 meta 行和 step 列表也带上本轮条数。
- 数值验证：`verify-against-session.cjs` 断言 `historyEnd` 落在 `0..messages`、随 step 只增不减、且不小于上一轮最后一次调用已携带的消息数；当前真实会话 30 轮全部成立（如第 24 轮最后一次：1224 条消息里 1076 条历史、148 条本轮）。


## 「新增消息」为什么标在 JSON 里而不是单开一个面板

- 曾经有一个「相比上一次调用」的独立面板（`DiffPanel` + `DiffSlot`），把新增消息逐行摘要列出来。问题在于：它和右边的 JSON 是两份东西，摘要再详细也不如原文，「这条到底在第几行」还得自己去数组里找；而且它为了显示摘要，把每条新增消息的完整副本挂在 `call.meta.diff.added` 上——一份 Turn 有 94 次调用时，光这些副本就按调用数×窗口大小膨胀。
- 现在只留**计数**：`diffRequests` 返回 `{prefix, added: number, removed, rewritten, changed, prevMessages}`，`added` 是数字而不是消息数组，内存开销可以忽略（实测 Turn 87 的 94 次调用，`meta.diff` 合计 8.1 KB）。渲染时 `JsonNode` 拿到 `messagesDiff`，把下标 `>= prefix` 的行换成绿色轨道（`STYLE.jsonFresh`：`borderLeft: '2px dashed transparent'` 由父层按 `pal.freshBorder/freshBg` 上色）并在行首挂 `新增` 胶囊；`prefix` 处插一条 `STYLE.jsonFreshSep` 虚线，写着「上一次调用已有 n 条 · 以下为本次新增 m 条」。
- 一个细节：虚线的「轨道」必须和 `jsonGuide` 的引导线同宽同位（`marginLeft:-10px` + `paddingLeft:10px`），否则连续新增段会看起来断成几截。烟雾测试断言虚线轨数 = 新增条数，就是防这个。
- 判定依据是数组前缀比较（`stableJSON` 仅在首尾不等时兜底），所以「内容没变、位置挪了」不会被算成新增；`removed > 0` 单独报 `消失 n`，因为那是压缩的痕迹，不是新增。


## 响应侧（重建的 chat-completion 响应）

- 数据来源全部是这一步自己的记录：`assistant/message` 给正文（`content` 分块：`text` / `reasoning` / `tool-call`）、`usage` 和 `source`（真实 model/provider）；它 `.data.stream` 末尾的 `finish` 分块给出结束原因（`kind` + `failure{message, code, status}`）；`assistant/attempt` 是这一步失败过的每一次尝试，各自也带一份 `stream`/`finish`；时间从分块的 `time`（或 `time0 + dt[]`）里还原，`step/start.time` 到第一个分块是「首字节」，首尾之差是「总时长」。
- 重建的响应体用 OpenAI chat-completion 形态（`choices[0].message` + `finish_reason` + `usage`），因为它才是「复制出去就能直接喂给别的工具」的形状；`finish_reason` 由 finish kind 映射（`tool-calls` → `tool_calls`、`max-tokens` → `length`、`aborted` → `aborted`）。
- 两个坑：**没有回复的步骤**在日志里只有 `assistant/attempt`，没有 `assistant/message`——这时不能伪造 body，要把失败尝试列出来；而一条 step 的最后一次尝试可能只是流断了（`stream` 里没有 finish 分块），所以结束原因要取**最后一条带 finish 的尝试**（`lastFinishOf`），否则真正的 502/AUTH 原因会被静默吞掉。
- 响应体的 `tool_calls` 复用请求侧的工具卡片：`ResponsePanel` 把 `meta.toolDetailsByCallId` 继续传给 `JsonNode`，所以回复自己发起的调用能直接看到后来的成败与耗时。
- 验证：`verify-against-session.cjs` 的 `responses` 段落逐调用对账结束原因、正文长度、`tool_calls` id 序列、usage 合计、重试次数，并断言回复自己的调用不能落到「未返回」。

## 请求 / 响应为什么在 JSON 右上角

试过三种摆法。**放弹框顶部**：层级变成「先选一半，再选第几步」，同一个 step 在请求侧列表和响应侧列表里各出现一次。**放每个 step 行右侧**：列表不再重复，但每行都长出一对按钮，一个 20 次调用的 Turn 就是 40 个按钮，行宽也被挤掉，选中哪一半还得先找到那一行。**最终摆法**：step 由左侧列表选，看哪一半由 JSON 区自己的右上角决定——两个控件各管一件事，位置就在它们影响的内容旁边，一次点击只改一件事。

- 只有 1 次调用时也保留这一对按钮：它们是弹框里唯一的半边开关，藏起来就没有入口。左侧也同样只有一行，不再退化成「顶部一张卡片」。
- 选中没有回复的 step 时，`响应` 按钮灰显（`dsh-pl-side-off`），点进去仍走响应侧的空态文案，不伪造空回复。
- 曾经还有第三屏「网络」，把一轮每次调用排成一行表格。它被删掉了：状态、耗时、token 在 step 行和响应侧 chip 里已经都有，多一屏只是多一次选择，还要为它让出卡片/列表的宽度。

## 为什么只有左侧一种列表，以及弹框为什么定高

**一种列表**：曾经按调用次数分流——不多于 12 次用顶部 #1 #2 #3 卡片，超过 12 次换成左侧列表。12 是个没人想记住的数：调用少的会话看到卡片、多的看到列表，同一个弹框在两份截图里长得不一样，用户的记忆得带着条件分支。现在只有左侧列表一种形状，一次调用也是它（一行，选中，右侧是那一步的 JSON），四十次也是它（一列，可以滚）。dsh-pl-tab* 那套卡片样式和 TAB_LIMIT 常量随之删掉，冒烟测试也从「1 次调用没有 step 列表」翻转成「1 次调用必须有且只有一行」。

**定高**：请求 和 响应 的量级差得很远——请求可能是几 MB、几千条消息，响应常常只有几百字节。原先弹框只有 maxHeight: 88vh，内容短就缩，于是点一下 响应 窗口猛地缩到一半，再点 请求 又弹回去，眼睛还要重新找按钮。现在弹框是固定高度的三行 flex 列：header（自动） + split（flex: 1 1 auto，左侧列表与右侧 pane 各自滚动） + foot（自动）。请求侧那条「日志比模型读到的多得多」的脚注只在请求侧出现，也只会挤压 JSON 区的高度，不会改变窗口外框。加载态与错误态仍用 height: auto 的小窗：那时没有两种内容可比，缩着反而更好读。

- 定高的前提是**每个滚动容器都 minHeight: 0**：split、pane、dialogBody 任意一层漏掉，flex 子项的最小高度就会把弹框撑破。冒烟测试因此直接断言根节点 style.height === '88vh'。
- step 列表自己滚（overflowY: auto，flex: 0 0 auto 撑宽 236px），所以 20 次调用不会把右侧 JSON 挤窄，也不会把 header 顶掉。
## 长对话第一次打开为什么慢，以及慢在哪

量出来的，不是猜的。用 41 MB / 19 596 条记录的真实会话（93 个 Turn，最后一条消息所在 Turn 6 696 条消息）逐段计时：

| 步骤 | 耗时 | 说明 |
| --- | --- | --- |
| 读文件 + zstd 解压 + JSON.parse | 703 ms | 只在测试脚本里出现，浏览器里这段由 Host 做，摊在翻页往返中 |
| `collectEvents`（19 596 条） | 3 ms | 不是问题 |
| `buildTurnCalls`（Turn 93，75 次调用） | 172 ms | 每次调用平均 2.3 ms，随 Turn 内步数线性增长 |
| 同上，Turn 90（19 次调用） | 118 ms | 主体的成本是「每步折叠一次 6 400 条消息」 |
| 同上，Turn 1（1 次调用） | 5.5 ms | 早期 Turn 很便宜 |
| `diffRequests` 全部相邻对 | 1 ms | 引用相等短路有效，不用动 |
| `DialogBody` 首次渲染（请求侧） | 58 ms / 7 172 个节点 | 可接受 |
| `byteLength(request)`（13.7 MB） | 30 ms | **曾经每次渲染都算一遍** |

三处真正的浪费，按收益排序：

1. **翻页方式**（最大的那块，也是用户感觉到的「卡几秒」）。请求携带的是整段对话，所以必须把事件窗口往前读到底；而一页只有约两个 Turn（Host 在超过 50 条消息的第一个 Turn 起点停），长会话就是 40 多页。原来调 `loadOlder()`：**每翻一页都会 publish 一次**，于是对话框开出来之前，背后的对话区被重渲染 40 多遍，而且是一页一页串行 await。DSH 另有一个跳跃接口 `loadThrough(seq)`：Host 私下翻页、用 200 条一页的跳跃页大小、覆盖到目标后**只 publish 一次有序 prepend**，重复调用共享同一个 in-flight promise。目标 seq 取 0（要的就是全部），一次跳跃替掉整个循环。三条退回路径都保留：没有这个接口、跳跃抛错、跳跃没进展（`hasMore` 仍为真）时，仍用 `loadOlder()` 走完，行为不比原来差。
2. **每渲染一次就重算 13 MB 的字节数**。`bodyBytes` 原先是 `JSON.stringify(call.request).length`，写在 `DialogBody` 的渲染体里——切 step、切 请求|响应、折叠、点复制，每一次都是 40-50 ms 的主线程停顿。改为 `bytesOfBody(value)`：`WeakMap` 按请求对象缓存，用 `byteLength`（不建字符串，30 ms 而非 47 ms）算一次终身复用。因为重建结果有缓存，请求对象的生命周期和缓存一致，命中率接近 100%。
3. **缓存键太粗**。`builtCache` 的键里带着「整个窗口最大的 seq」，于是会话里任何一条新事件都会让**所有** Turn 的缓存失效——在 93 个 Turn 的会话里，缓存每次都是冷的，刚看过的 Turn 再点一次还是要全量重建。改成「该 Turn 自己的 seq 区间（`turn/end` 或下一个 `turn/start - 1`）+ 窗口首个 seq」：已结束的 Turn 是不可变的，它的请求只可能由区间内的事件（和区间之前的 header）决定，所以键稳定。窗口首个 seq 留着，是因为更旧的页被读进来后可能出现新的 governing header，那时必须重建。顺带把淘汰从「满 40 条全清」改成 LRU，并且**命中时也重新插入**——否则淘汰顺序不是复用顺序，正在看的那个 Turn 反而最先被扔掉。

## 加载态为什么要数秒

首次读取没有任何增量结果可显示（一次请求要么整份，要么不给），所以唯一诚实的进度信号就是已经过去的时间，而这恰好也是本次修的重点：对话越长，这段越久。加载态每 250 ms 更新一次「正在读取整段会话历史 n 秒…」，不到 0.4 秒不显示（缓存命中时重开只有几十毫秒，闪一个 0.0 秒比不显示更糟），超过 180 秒自动停表。

- 每次 tick 都会 publish 一次新的 payload，所以 overlay 里绑定 `keydown` 的那个 effect 的依赖从 `payload.id` 改成了「有没有对话框」——否则每 250 ms 解绑重绑一次。
- 顺手修了一个老 bug：读取途中按 Esc 关掉对话框，等结果回来会**把对话框重新弹开**。现在每次打开带一个 `dialogToken`，回调里先比对「当前还是不是我这次」，不是就直接丢弃。

## 秒数为什么曾经停在「1 秒」，以及一个数字治不了的病

第一版计数用的是 `setInterval(…, 250)` + `Date.now()` 差值，用户那头的观感是：数字涨到 1 秒就不动了。数字本身没算错——错在它能不能被画出来。

读历史这件事的代价集中在两处，都在主线程上：一是 Host 把窗口一次性 publish 进来时，会话区要把两万条事件重新渲染一遍；二是随后的重建（6 600 条消息约 170 ms）和弹框里第一帧 JSON。主线程被占住的整段时间里，浏览器一帧都不画，`setInterval` 的回调就算排上了队也没有机会落到屏幕上，于是屏幕上的「1 秒」停在那儿，直到工作做完、弹框直接跳出来。看上去像计数失灵，实际上是页面卡住了——而这正是用户嫌慢的那几秒。

三处改动，各治一半：

- **按帧计数**：ticker 从 `setInterval` 改成 `requestAnimationFrame` 循环，秒数在「即将绘制」时计算，再按 250 ms 分桶（一秒最多四次 publish）。屏幕上的数字于是永远等于这一帧画出时的真实耗时，不会再出现「落后一整秒然后猛跳」。
- **纯 CSS 转圈**：加载态多了一个 `.dsh-pl-spin`，`@keyframes` 转的是 `transform`，由合成器线程执行——主线程卡死也照转。数字停住时，至少还有东西在动，读者能分清「卡住了」和「死了」。`prefers-reduced-motion` 下换成透明度脉动（同样是合成器动画），错误态不转（错误不是「忙」）。
- **分阶段说明**：`readWindow` 一返回，先把文案换成「历史已读入，正在重建这一轮（窗口内 N 条事件）」，`await nextPaint()`（一帧 + 一个宏任务）确保这句真的画上去了，再进同步的重建。等待的性质变了就换个说法，比让同一个数字硬撑到底更接近事实。

顺带：成功打开时往 console 打一行 `[dsh-payload] ready in 1234 ms`，再有人报「慢」就有共同的事实基础，不必靠猜。

还有一件同类的事：`bytesOfBody` 的注释里写过，弹框每次渲染都会重算请求体的字节数（`JSON.stringify(...).length`，13 MB 要 40 ms）。这类「在渲染路径上做大对象运算」的写法，比任何布局细节都更容易被用户感知成卡顿——加功能时先问一句「这段代码每次渲染都会跑吗」。

验证：`tools/paging-smoke.cjs` 用假 binding 把六种分页形状跑一遍（有跳跃 / 无跳跃 / 跳跃抛错 / 跳跃空转 / 跳跃后仍有 hasMore / 无 eventSource），断言「有跳跃时 `loadOlder` 调用 0 次、`loadThrough` 恰好一次且参数为 0」，以及三条退回路径都能把窗口读全；`tools/render-smoke.cjs` 的加载态断言扩展到「读数文本 + 转圈存在 + 重建阶段能报出窗口事件数 + 错误态不转圈」。


## 秒数还是会停：于是把等待挪出点击路径

按帧计数、转圈、分阶段文案上线后（1.9.8），用户的反馈没变：还是从 0 涨到 1 秒就停住。这说明问题不在计数方式——两种实现（旧的逐页 `setInterval`、新的一次跳跃 + `requestAnimationFrame`）停在同一个位置，恰恰是同一个原因：读取结束前后那一段主线程被占满，浏览器不出帧，屏幕上的文字就冻在那里。数字算得再准，没被画出来就是没被画出来。

所以这次不再改时钟，改**什么时候读**：

- **预读**（`ensurePrefetch`）：操作按钮出现 1.2 秒后开始读窗口，指针移上去（`onMouseEnter`/`onFocus`）立刻开始读。每个 session 只读一次，状态记成 pending/done/skipped/failed。预读的结果不是缓存副本，而是 Host 会话窗口本身——`loadFullWindow` 读完之后 `hasMore` 就是 false，所以随后的点击不再翻页。
- **点击与预读不重复**：`readWindow` 发现这个 session 正在预读，就 `await` 那个 promise，再照常走一遍（此时窗口已经是完整的，一遍就是 `getSnapshot` + `collectEvents`，3 ms 量级）。
- **可观测**：`[dsh-payload] prefetch N events in X ms`、`[dsh-payload] window N events in X ms · rebuild Y ms`、`[dsh-payload] ready in Z ms`，以及 rAF 里检测到单帧间隔超过 500 ms 时打的 `main thread blocked for N ms`。下次谁说「慢」，先看这四行，能立刻分清是翻页、重建、首帧渲染还是 App 自己的 publish 风暴。

诚实地记下代价：预读把等待挪到了点击之前，但没有消灭它。`loadThrough(0)` 成功时 Host 会一次性 publish 整个窗口，会话区要重排两万条事件——那一下仍然会顿，而且现在顿在你只是看着对话、还没点按钮的时候。这是 DSH 的 publish 粒度决定的，插件侧只能选择「什么时候」承受，不能选择「是否」承受。选在点击前，是因为那时读者没有在等一个弹框。

为什么不干脆不读全量：一次请求携带的是整段对话，插件拿到的只有事件流（`request/header` 只带 config 和 tools，不带 messages），要还原请求体就必须自己折叠整段历史。少读一页就是静默丢消息，比慢更糟。

验证：`tools/paging-smoke.cjs` 新增第 h 组——同一 binding 连读两次，第二次的 `loadThrough`/`loadOlder` 调用次数不得增加，窗口条数不变。这条正是预读赖以成立的前提：暖窗口再读不该翻页。

## 秒数最后还是删掉了（1.10.0）

上一节记的做法是「按帧计数」。用户第二次反馈还是停在 1 秒，说明这条路走不通——不是实现不对，而是出发点错了：**只要读窗口和重建占着主线程，屏幕上就不可能有一个在动的数字**。按帧计数能保证「显示的数字没有落后」，但保证不了「数字会继续变」，因为那几秒浏览器根本没有下一帧。

两轮反馈有个共同点值得记下来：用户在意的其实不是「秒数准不准」，而是「它是不是卡死了」。而我们给出的信号（一个精确到 0.1 秒的数字）恰好是最脆弱的那个——它一旦停住，看起来就像 bug，哪怕底下的工作正在正常推进。教训是：**在主线程可能被占满的地方，别用需要重新绘制的信号表达「我还活着」。**

1.10.0 的取舍：

- 加载文案改回一句话：「正在读取这段对话的历史…」，不打印秒数、不带括号解释。之前那句「…1.0 秒…（长对话第一次打开要把全部历史读进浏览器，同一个会话之后再打开会复用）」还因为太长而被读者当成被截断的省略号——文案自己制造了一次误读。
- 活着的信号只留纯 CSS 转圈（合成器动画）。阶段切换（读历史 → 重建）仍然换文案，因为那是真实发生的变化。
- 计时数字全部挪进 console：`prefetch … ms`、`window N events in X ms · rebuild Y ms`、`ready in Z ms`，外加 rAF 里检测 `no frame drawn for N ms`。诊断信息留在能给诊断的人手里，不放在弹框上当作承诺。
- 预读的触发从 1.2 秒提前到 0.3 秒（按钮一出现几乎立刻开始），鼠标移上去立即开始。

## 版本号上屏

这次顺手加了一件小事，却是这一串来回里最省时间的一件：弹框标题旁和加载态右下角显示版本号（`VERSION` 常量，与 package.json 同步），并在加载时打一行 `[dsh-payload] 1.10.0 loaded`。理由是「用户看到的是不是最新代码」以前只能靠猜——插件走符号链接部署，刷新页面才会加载新 client.js，浏览器还可能缓存旧 bundle。把这个事实放到屏幕上，「改了却没变化」和「改了但没生效」就能一眼分开，不用再靠对话轮次去试。

## 缓存为什么要按字节算（1.10.1）

到此为止缓存只有一道闸：`builtCache` 最多留 40 条 Turn，满了就淘汰最久没用的那条。这个数字是当初随手定的，量的是「条」，可它要挡住的是内存。一次实测把差距量化了出来：21 128 条事件的会话里，重建好的一轮 Turn 保留的堆是 6.3 / 17.3 / 16.3 / 21.1 / 31.7 MB（对应 2 / 19 / 9 / 53 / 117 次调用），均值约 18.5 MB。乘上 40 就是最坏 700 MB 级常驻——足够让浏览器在读者滚动刚打开的内容时开始回收，而回收的正是那份内容。

原因不神秘：一个 Turn 的每次调用都携带整段对话，缓存下来的 `messages` 数组里全是活着的字符串。条数相同，体积却能差五十倍（第一轮 5 条消息 vs 最后一轮 6 780 条），所以「40 条」这个上限在早期会话里宽松得无意义，在长会话里又危险得没边。

改法是把闸换成预算：`BUILT_CACHE_BYTES = 200 MB`，配合原来的 40 条上限，两个条件任一越界就从最旧开始淘汰，直到都满足。三个细节值得记：

- **体积是估算的，且故意偏悲观**。`builtWeight` 不测量，只走最宽的那个 `messages` 数组（各次调用的数组互为前缀，消息对象和字符串是共享的，逐次累加会重复计算五六十遍），按每条 160 字节 + 内容 2 字节/字符 + 每个 `tool_calls` 256 字节，最后整体乘 1.2，用来覆盖这次遍历没碰到的记账（每条消息的 `track`/`links`、每次调用的来源累加器）。拿实测校准：未乘 1.2 时估算/实际 = 0.86–1.38，乘完是 1.03–1.65。宁可早淘汰一次、多重建 100 ms，也不要晚淘汰、把内存留给 GC 去处理正在看的内容。
- **永远保留刚插入的那一条**。淘汰循环的条件是 `size > 1 &&`（条数或字节越界），所以哪怕单个 Turn 自己就超预算，它也会留下并清掉其余。否则那一轮就会陷入「每次打开都重建」的循环——预算保护内存，不该惩罚当前正在看的那一轮。
- **重新缓存同一个 key 要先减掉旧账**。`rememberBuilt` 命中同 key 时先 `builtCacheBytes -= known.weight` 再 delete，否则来回切同一轮会把计数器越加越大，最后缓存里只有一条却显示超预算。

验证放在 `tools/cache-smoke.cjs`（不需要浏览器）：估算随 Turn 增长且量级正确、40 个超大 Turn 不能全留、重复缓存同一轮不虚增、单个超预算 Turn 独占缓存并清空其余。

