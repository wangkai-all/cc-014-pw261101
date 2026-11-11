# Pointwise 本地埋点闭环

浏览器端先过滤字段再上报的 TypeScript 埋点 SDK，配演示商品页、调试台与 Node.js + SQLite 接收端，
本地一条命令跑通「同意 → 采集 → 过滤 → 暂存 → 投递 → 校验落库 → 调试」全链路。

## 启动

```bash
npm install
npm run dev          # 同时启动接收端 :4000 和演示页 :5173
# 或分开启动：npm run dev:server / npm run dev:web
```

浏览器打开 http://localhost:5173 ，先在横幅里同意采集，再到商品页点击、搜索、加购、提交订阅。

其他命令：

```bash
npm test             # 过滤引擎 + 服务端 17 个测试（含原值不泄漏、幂等、逐条校验）
npm run typecheck    # 全仓 TypeScript 检查
npm run build        # 打包 SDK 到 packages/sdk/dist（ESM + CJS + d.ts，零运行时依赖）
```

## 目录结构

```
packages/
  shared/   事件注册表（版本+字段白名单）、PII 识别脱敏、浏览器过滤引擎、服务端校验器
  sdk/      可嵌入页面的 SDK：同意状态、IndexedDB 暂存、分批重试、调试事件流
  server/   Express + node:sqlite：逐条校验、event_id 幂等、拒绝原因留档
  web/      React 演示商品页 + 调试台（Vite）
tests/      过滤引擎与服务端集成测试
scripts/    一键启动脚本
```

## 关键设计如何对应需求

### 同意管理（同意前不缓存、撤回即清空）

- `track()` 入口先检查 consent，非 `granted` 直接丢弃，只留一条不含数据的调试记录，**不缓存不补发**。
- 同意状态持久化在 localStorage；`withdrawConsent()` 会停掉定时器、清空 IndexedDB 队列和死信。
- 见 `packages/sdk/src/tracker.ts`。

### 字段白名单与逐层处理

- 每类事件在 `packages/shared/src/schema.ts` 声明版本号与字段规则（类型、PII 标记、嵌套 `properties`、数组 `items`）。
- `filter.ts` 递归处理嵌套对象和数组元素：白名单外删除、类型不符删除、对象清空后整体移除。
- 每条处理动作写入 trace（字段路径 + 动作 + 原因），**trace 与 payload 都不含被删除的原值**，
  测试 `安全红线：原值不泄漏` 对整个过滤结果做序列化断言。

### PII 删除 / 脱敏

- `pii.ts` 识别手机号与邮箱；标记为 `freetext` 的字段还会扫描文本内嵌的联系方式。
- 策略可配置：`drop`（字段删除，原值在过滤函数内即丢弃）或 `mask`（`138****8000`、`z***@example.com`）。
- 过滤在入队之前完成，因此原值不会进入网络请求、IndexedDB 或调试日志。

### 断网暂存与重试（event_id 幂等）

- 只有过滤后的事件写入 IndexedDB（`store.ts`，主键即 event_id）。
- 断网时不发请求、只滞留；`online` 事件或定时 flush 触发分批发送。
- 网络错误 / 超时一律视为**结果未知**，保留原 event_id 重试，客户端绝不自行去重。
- 服务端 `events.event_id` 为主键 + `INSERT OR IGNORE`：重复到达返回 `duplicate`，
  浏览器超时但服务端已落库的场景不会多记一条。超过重试次数进死信，不再投递。

### 服务端逐条校验

- `validator.ts` 与浏览器共用同一份注册表，但策略是严格拒绝：未知字段、类型错误、版本不符、
  未处理的 PII（`pii_leak`）都判该条不合法。
- 批次接口对每条返回独立结果，非法条进 `rejected_events`（只存路径和原因，不存原值），
  合法条正常落库，互不影响。

### 调试台

- 时间线把每条事件的规则版本、字段处理原因（trace 表格）、过滤后 payload、投递状态
  （queued/sending/accepted/duplicate/retry_wait/deadletter）和尝试次数放在一起。
- 控制项：切换同意、模拟断网（拦截 fetch）、立即刷发、切换 PII 策略、
  直发「1 条非法 + 1 条合法」混合批次验证服务端兜底、同 event_id 连发验证幂等。
- 右侧实时展示 SQLite 落库事件、按类型统计和服务端拒绝记录，可直接核对：
  敏感字段是否在发送前挡住、恢复联网后有无重复或漏发。

## SDK 嵌入方式

```ts
import { createTracker } from '@pointwise/sdk';

const tracker = createTracker({
  endpoint: '/api/events/batch',
  pii: { phone: 'mask', email: 'mask', freetext: 'drop' },
});
tracker.grantConsent();
tracker.track({ event_type: 'add_to_cart', properties: { product_id: 'SKU-1', price: 359 } });
// tracker.withdrawConsent(); // 撤回：停采集、停重试、清空队列
```
