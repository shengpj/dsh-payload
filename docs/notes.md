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

## 分组的几个细节

- 切点是该 step 的**首个响应事件**，不是 `step/start`：本轮的运行时上下文注入（`Time sampled while preparing turn N, step M…` 这类 `user/message`）是在 `step/start` **之后**才写进日志的，用 `step/start` 当切点会把它们漏掉，`messages` 甚至可能为空。
- 因为切点是逐次推进的，第 2 次调用天然包含第 1 次的 assistant 消息和 `tool/result`——**逐次累积**，与真实请求一致。
- 标签页的 `title` 与面板摘要都带 `messages` 条数、`tools` 个数和 `reason`；`reason` 来自继承到的 header，只说明这份配置是何时写的，不代表本次调用的类型（`initial` / `change` / `resume` / `series`）。
- 只有 1 次调用时不显示标签页，退化成单个浏览视图；超过 12 次换成左侧 step 列表（一个 Turn 可能有几十次调用）——下拉框只能塞下一行 `#k`，看不到 step 号、消息条数和 token，列表都能看到，且右侧 JSON 仍占满剩余宽度。
- 上界不依赖插槽的 `seq`（那只是兜底），避免 `seq` 恰好落在某个中间事件时把后面的调用截掉。

## 踩过的坑

**不要在 Slot 组件里调用 `props.useSessions()` 之类的“看起来像 hook”的注入属性。** 首次实现时在组件顶层调用了它，渲染期抛错后框架会**剥夺（abdicate）**该条目：按钮完全不渲染，而 `Slots` inspect 里该条目的 `active` 变成 `false`。诊断顺序是：先挂两个零依赖的静态探针（`conversation.composer.dock` / `turnTail`）二分定位——两个探针都出现即说明插件加载正常，问题在组件自身；然后把服务获取改成**点击时**再 `ctx.get('sessions')`，渲染期不依赖任何注入服务。

**不要用 `request/header` 当作调用边界。** 第一版就是这么写的，结果一次调用都分不出来（标签页永远不出现）。`request/header` 只在调用配置变化时写一条，密集工具调用的 Turn 里可能一次都没有（实测一个 1148 条记录的会话里只有 5 条，而 `step/start` 有 186 条）。分组锚点必须是 `step/start`，配置则从不超过该 step 的最近一条 header 继承。

**`system/message` / `user/message` 是增量记录。** 空的 `content: []` 表示“这一轮没有新增”，不是“发送一条空消息”，重建时必须跳过，否则会把模型根本没收到过的空 system 塞进 payload。

**内联样式做不出 `:hover`。** 图标按钮要在悬停时浮出文字气泡，而 `style={}` 无法表达伪类。做法是在 `apply()` 里往 `document.head` 注入一份 `<style>`（`id` 固定、幂等、只用 `.dsh-pl-` 前缀，避免和官方类名打架），按钮用 `className` 而非 `style`。注入失败只影响观感，组件照常工作。

**不要凭印象写 CSS 变量名。** 弹框第一版用了 `--dsw-alias-bg-primary` / `--dsw-alias-text-primary` 这类**不存在**的 token，于是全部走 fallback：背景是随手写的暗色 `#1f2023`，文字色 fallback 到 `inherit`（浅色主题下就是深色字），于是深底深字糊成一片。正确做法是先查 client 的 `Theme` inspect provider（`listTokens`）拿真实清单——本 Harness 的 `listTokens` 只收录 14 个语义色：`bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-overlay` / `border-l1` / `border-l2` / `brand-primary` / `label-primary` / `label-secondary` / `state-{error,idle,success,warn}-primary` / `specific-sidebar-fill`。改完跑一次「用到的 `--dsw-*` 是否都在清单内」的静态对账，且 fallback 要按**浅色**主题给（深色主题下真 token 一定存在，fallback 只可能在浅色或第三方主题里被用到）。

**`listTokens` 不是全集，别把它当白名单。** 那 14 个只是 `alias` 语义色里被 provider 收录的一部分；真正定义 token 的是两处：`dsh-client-ui-theme/lib/client.js`（整张 `--dsw-*` 变量表，浅/深两套）和 `dsh-web-frontend/dist/assets/index-*.css`（组件级规则）。图标按钮、tooltip 用到的 `--dsw-alias-label-tertiary`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-tooltip-bg`、`--dsw-radius-sm`、`--dsw-focus-ring-*` 都在那里。查法：从 `app.asar` 里按 `size/offset` 抽出目标 `lib/client.js` 与前端 CSS 再搜（仓库里的 `tools/asar-extract.cjs` 就是那次的脚本），比猜名字快得多。

**照着官方组件的真样式写，而不是“看着差不多”。** 图标动作按钮的权威定义在 `dsh-client-ui-message-feedback/lib/client.js` 的 `_action` 规则里：`28×28`、`radius-sm`、`padding 6px`、`svg 15×15`、静止色 `label-tertiary`、hover `interactive-bg-hover` + `label-secondary`；tooltip 的气泡在前端 CSS 的 `_bubble` 规则里：`padding 3px 7px`、`radius-sm`、背景 `alias-tooltip-bg`、文字 `static-neutral-bluish-00`、`13px/20px`、`0.15s` 淡入。照抄这几个值，才和「复制 / 好的回答 / 有问题的回答」那排图标长得一模一样。

**悬停气泡要用 `position: fixed`。** 气泡若用 `absolute` 挂在自己身上，会被会话滚动容器在页面底部裁掉；官方 Tooltip 走 portal + fixed 就是为了这个。这里不引 `react-dom`、不建 portal：气泡仍是组件子节点，但用 `position: fixed` + 悬停时读 `getBoundingClientRect()` 计算 `left/top`，只在下方空间不足（`innerHeight` 剩不到 30px）时翻到上方。

**token 统计只信 provider 上报，不要自己估。** `assistant/message.data.usage` 是响应里带回的真实用量；自己按字符数估算会在中文、工具 JSON、缓存命中等情况下偏出数倍。

## 字体与视觉尺寸

`Theme.listTokens` 只有颜色 token，没有任何字体/行高 token，所以排版不引用变量，靠几条纪律和 GUI 对齐：

- **字体继承 `inherit`**：只有 payload 正文换成等宽栈（`ui-monospace, SFMono-Regular, …`），标题、chips、按钮全部跟随应用字体——自带一套字体栈就会立刻显得“不是同一个软件”。
- **四级字号 + 统一 20px 行高**：14 标题 / 13 控件（标签页、step 列表）/ 12 正文（chips、按钮、等宽 payload）/ 11.5 微标签（`step 3 · 12 条消息`）。控件高度 28–30px、圆角 8px（弹框 12px），和官方按钮、气泡的尺度一致。
- **数字用 `tabular-nums`**：token 数、消息条数、`#k / N` 在切换时不会跳动。
- **悬停/焦点靠注入的 CSS**：`.dsh-pl-btn` / `.dsh-pl-tab` / `.dsh-pl-step` 三个类补上 `:hover`、`:focus-visible` 和应用的 150ms 过渡。
- **触发器照抄官方动作按钮**：`28×28`、`radius-sm`、`padding 6px`、`svg 15×15`、静止 `label-tertiary`、hover `interactive-bg-hover`；气泡用 `alias-tooltip-bg` + `static-neutral-bluish-00`（黑底白字）、`13px/20px`、`3px 7px`、`radius-sm`，在**下方**弹出（和同一排的“复制 / 好的回答”一致），空间不足时才翻到上方。

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

