# 取消自动化 + 合规显示层 · 实施计划

> 状态：已确认，等待执行
> 目标版本：0.2.0
> 范围：仅做高亮与自动分析；不发送任何点击/键盘事件

## 1. 用户决定（5 项）

| # | 决定项 | 选择 |
|---|---|---|
| 1 | 版本号 | **0.2.0**（首版移除一整类功能，按语义化主版本号处理） |
| 2 | 显示层唯一化（盐化 ID / 类名 / 存储 key） | **保留** |
| 3 | `data-msah-label` → `aria-label` 替换 | **接受** |
| 4 | [自动] 选项（棋盘变化自动重分析） | **保留** |
| 5 | 状态条文案 | **保留**：`棋盘 WxH \| 安全 N \| 确定雷 N \| 未开 N \| 旗 N` |

## 2. 范围

- **移除**：开安全格 / 标雷 / 批量动作 / 速度 / 随机间隔 / 鼠标事件派发（含 `PointerEvent` 轨迹、抖动、对数正态节奏、顺序洗牌）。
- **保留**：确定性求解、高亮、自动重新分析、概率显示、面板、设置持久化。
- **新增**：显示层唯一化（盐化 ID / 类名 / `aria-label` / `localStorage` key），用于避免命名冲突并减少固定选择器痕迹。

`isTrusted` 相关风险：因为不再派发事件，这类问题不再存在；仍是本计划的"不做的事"之一。

## 3. 删除清单

### 3.1 常量（`minesweeper-online-helper.user.js:14-25`）

- `DEFAULT_ACTION_DELAY_MS`
- `MIN_ACTION_DELAY_MS`
- `MAX_ACTION_DELAY_MS`
- `RANDOM_DELAY_MIN_FACTOR`
- `RANDOM_DELAY_MAX_FACTOR`
- `MAX_AUTOMATION_ROUNDS`
- `BOARD_SETTLE_MIN_MS`

保留：`ASSISTANT_VERSION`、新构造的动态 `STORAGE_KEY`、`CELL_ID_RE`、`TYPE_CLASS_RE`、`FLAG_CLASS_RE`。

### 3.2 函数（全部删除）

- `clampActionDelayMs`（:44-48）
- `getNextActionDelayMs`（:50-62）
- `dispatchMouse`（:702-716）
- `leftClick` / `rightClick`（:718-728）
- `waitForBoardChange`（:730-739）
- `isClosedElement`（:672-674，仅 `runAutomation` 使用）
- `getActionableKeys`（:649-659，仅 `runAutomation` 使用）
- `boardSignature`（:661-665，仅 `waitForBoardChange` / `runAutomation` 使用）
- `runAutomation`（:801-867）
- `clickForAction`（:797-799）
- `automationLabel`（:793-795）

### 3.3 闭包状态（在 `bootstrap` 中清理）

- `automationRunId`（:749）
- `runAutomation` 整段调用链

### 3.4 UI 元素（`createPanel` + `ensureStyle`）

**删除**：
- 按钮 `data-msah-action="open-safe"`
- 按钮 `data-msah-action="flag-mines"`
- 复选框 `data-msah-option="automation"`
- 复选框 `data-msah-option="random-delay"`
- 整个 `.msah-speed` 行（label + range + number + ms）
- `data-msah-requires-consent` 按钮的 CSS（:445-460）
- `.msah-warning` 文案替换为"纯高亮，无任何点击事件"

### 3.5 设置字段

| 旧字段 | 处理 |
|---|---|
| `auto` | 保留，默认 `true` |
| `showProbabilities` | 保留，默认 `false` |
| `collapsed` | 保留，默认 `false` |
| `actionDelayMs` | 丢弃 |
| `randomDelayEnabled` | 丢弃 |
| `automationAcknowledged` | 丢弃 |

### 3.6 测试

- `solver.test.mjs`：删 `getActionableKeys` 段（:136-153）+ `getNextActionDelayMs` 段（:155-165）
- `soundness.test.mjs`：不动

## 4. 保留 + 微调

### 4.1 求解与高亮（不变）

- `keyOf` / `parseKey` / `classNamesOf`
- `readCellStateFromClassNames` / `normalizeBoard` / `neighborKeys`
- `normalizeConstraintForKnownCells` / `buildConstraints` / `applyConstraint`
- `solveBoard` / `estimateProbabilities`
- `readBoardFromDom` / `clearHighlights` / `getHighlightForCell` / `renderHighlights` / `updateStatus`

### 4.2 自动重新分析（保留）

- [自动] 复选框不变
- `attachObserver` 监听 `#AreaBlock`（class 变化 + 子树）不变
- `scheduleAnalyze` 120ms 防抖不变

### 4.3 显示层唯一化（D + E 落地）

**D1 — 盐化所有 ID 与类名**：
- `<style id="msah-style-${salt}">`
- `<div id="msah-panel-${salt}">`
- 高亮类名：
  - `msah-${salt}-safe`
  - `msah-${salt}-mine`
  - `msah-${salt}-prob`
  - `msah-${salt}-flag-ok`
  - `msah-${salt}-flag-q`
  - `msah-${salt}-prob-label`（伪元素承载标签）

**D2 — 标签承载方式**：
- 格子高亮不再写 `data-msah-label`
- 改写 `aria-label="${label}"` + CSS `content: attr(aria-label)`

**E1 — 存储 key 盐化**：
- 盐位置：`localStorage["__msah_salt"]`（8 hex），首次启动生成并持久化
- 主键：`msah-${salt}-cfg`
- 旧 key `minesweeper-online-assistant-settings-v1` 一次性迁移后删除

## 5. 设置迁移逻辑（首跑）

```
旧 key: minesweeper-online-assistant-settings-v1
       ↓ 读 JSON
白名单字段: auto, showProbabilities, collapsed
丢弃字段: actionDelayMs, randomDelayEnabled, automationAcknowledged
盐: localStorage["__msah_salt"] 不存在则生成 8 hex 写入
新 key: msah-${salt}-cfg  ← 写入白名单字段
旧 key: 删除（若存在）
```

## 6. UI 新形态

```
┌──────────────────────────────────────────┐
│ 扫雷辅助 v0.2.0                    [−]   │
├──────────────────────────────────────────┤
│ 棋盘 16x16 | 安全 12 | 确定雷 3 | 未开 100| 旗 5
├──────────────────────────────────────────┤
│ [ 分析 ]   [ 清除 ]                       │
├──────────────────────────────────────────┤
│ [✓] 自动       [ ] 概率                    │
├──────────────────────────────────────────┤
│ 提示：本脚本只做高亮分析，不发送任何       │
│ 鼠标事件，亦不读取网页之外的状态。        │
└──────────────────────────────────────────┘
```

CSS 调整：
- 删除 `.msah-speed` / `.msah-speed input` / `.msah-speed label` 全部规则
- 删除 `.msah-buttons button:disabled` 块（不再有禁用按钮）
- 删除 `.msah-warning` 原内容（:499-507），保留选择器替换文案
- 移除 `data-msah-requires-consent` 相关 CSS（:445-460）

## 7. `_private` 扩展

新增暴露：
- `getInstallSalt()`：返回当前安装盐
- `getStorageKey(salt)`：返回形如 `msah-${8hex}-cfg` 的 key
- `migrateSettings(doc)`：执行 §5 的迁移
- `getHighlightClassPrefix(salt)`：返回类名构造前缀（供测试与高亮复用）

不破坏现有 `_private` 列表。

## 8. 测试方案

### 8.1 现有

- `solver.test.mjs`：删 `getActionableKeys` 段（:136-153）+ `getNextActionDelayMs` 段（:155-165）
- `soundness.test.mjs`：不动

### 8.2 新增 `tests/compliance.test.mjs`

vm 加载脚本 + 假 `localStorage` / 假 `document`。断言：

1. **盐稳定**：同 `random` 注入下 `getInstallSalt()` 两次相等；不同 `random` → 不同盐
2. **存储 key 形态**：`getStorageKey(salt)` 形如 `/^msah-[0-9a-f]{8}-cfg$/`
3. **迁移逻辑**：在假 `localStorage` 写旧 key（含全部 6 字段）→ 调 `migrateSettings()` → 新 key 含白名单 3 字段、旧 key 被删除、被丢弃的 3 字段不出现在新 key
4. **面板 DOM 不含自动化痕迹**：解析 `createPanel` 输出的 HTML（字符串或假 DOM），断言不包含 `open-safe` / `flag-mines` / `automation` / `random-delay` / `.msah-speed` / `requires-consent`
5. **高亮类名带盐**：`getHighlightForCell` 在传入 `salt='abc12345'` 的派生上下文时返回的 `className` 形如 `msah-abc12345-safe`
6. **回归**：`npm test` 三套全绿

### 8.3 手动验证清单

- [ ] 进 minesweeper.online 开局，右下角看到带盐的 `#msah-panel-XXXXXXXX`
- [ ] DOM 搜索 `msah-safe`（无盐） / `data-msah-label` / `open-safe` / `flag-mines` / `msah-speed`，全部 0 命中（盐前缀的版本除外）
- [ ] DevTools → Application → Local Storage 能看到 `msah-${8hex}-cfg`，旧 key 不存在
- [ ] 取消 [自动] 后棋盘变化不再高亮；勾选后恢复
- [ ] 勾选 [概率] 后未确定格显示蓝色百分比
- [ ] 控制台无 `Uncaught` 报错，Performance 面板录制 30 秒无明显长任务

## 9. 文档

### 9.1 README 改写

- **顶部新增**："本脚本只做高亮分析，不发送任何点击/键盘事件，不会操作网页棋盘状态。"
- **删除**段：
  - "使用"里所有"开安全格 / 标雷 / 间隔 / 随机间隔 / 批量动作 / 自动标雷"条目
  - "技术说明"里所有"开安全格 / 标雷 / 鼠标事件 / 脚本派发"相关句子
  - "批量动作会发送脚本鼠标事件"警告
- **末尾新增**"行为边界"节：能做（高亮 OK / M / ? / %）；不做（点击、插旗、自动开格、自动标雷、跨域通信、图像识别、外部网络）

### 9.2 版本号

- `package.json` → `"version": "0.2.0"`
- `// @version` → `0.2.0`
- `ASSISTANT_VERSION` → `"0.2.0"`

## 10. 落盘顺序

1. 顶部常量清理 + 盐 / 迁移工具
2. `createPanel` / `ensureStyle` 改造
3. `bootstrap` 简化（删 `runAutomation` 引用 + 接入迁移）
4. `loadSettings` / `saveSettings` 改造
5. `getHighlightForCell` 加 `salt` 参数 + 改用 `aria-label`
6. `_private` 扩展
7. 写 `tests/compliance.test.mjs` + 改 `solver.test.mjs` + 改 `package.json` `test` 脚本
8. `npm test` 全绿
9. 改 README
10. 改三处版本号

## 11. 风险

- 旧 key 迁移一次性完成；用户清缓存 / 隐身窗口 / 换设备会重置盐（不读取旧设置），属可接受
- 面板 ID 加盐后外部 CSS 选择器（如有）失效；当前项目无外部依赖
- 现有用户习惯点击"开安全格"按钮——会全部失效；需在 README 顶部明确
- `aria-label` 在某些屏幕阅读器会朗读"OK" / "M" / "60%" 等，可能造成噪音；如不希望可改回 `data-*`（仅需把 §4.3 D2 撤回）

## 12. 验证前不做

- 不再向用户脚本注入任何 `MouseEvent` / `PointerEvent`
- 不使用 CDP / WebDriver / 原生驱动
- 不调用任何外部网络资源
- 不读取 `localStorage` 之外的用户状态
