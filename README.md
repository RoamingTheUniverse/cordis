# Cordis 架构解析

> 面向源码阅读的架构文档。
> 分析对象：`github.com/cordiverse/cordis`，HEAD = `0027892 fix(hmr): nested entry trees hmr and rollback (#103)`，核心包版本 `cordis@4.0.0-rc.9`。
> 全文行号均为「相对仓库根的路径:行号」。

---

## 一、这个项目是什么

Cordis 自称 **"A Meta-Framework of Spatiotemporal Composability"**（时空可组合性的元框架）。它不是 Web 框架、不是 DI 容器，而是一层**应用运行时基座**：你把功能拆成插件，Cordis 负责管理它们的**依赖关系**、**生命周期**、**副作用清理**和**热替换**。

这个"元"字的含义是：框架本身几乎不提供业务能力，只提供组合能力。HTTP 服务、数据库、日志导出、定时器，在 Cordis 里都是平等的插件。

### 1.1 "时空"是什么意思

这是理解全部设计的钥匙，它对应两个正交的维度：

| 维度 | 机制 | 解决的问题 |
|---|---|---|
| **空间**（Space） | `Context` 的派生链 | 同一个服务名，在不同上下文里可以指向不同实例；同一段代码，在不同上下文里行为可以不同 |
| **时间**（Time） | `Fiber` 的状态机 | 插件何时激活、何时卸载、依赖变化时如何级联重载、副作用如何精确回收 |

传统 DI 容器只有空间维度（作用域），传统事件框架只有时间维度（订阅/退订）。Cordis 把两者统一在 `Context` 这一个对象上：

- `ctx.foo` —— 空间：在当前上下文里解析服务 `foo`
- `ctx.effect(...)` / `ctx.on(...)` —— 时间：注册的东西会随当前上下文的生命周期自动回收

### 1.2 与 Koishi 的关系

Cordis 是从聊天机器人框架 [Koishi](https://github.com/koishijs/koishi) 里抽离出来的内核。如果你搜到的资料里配置项带 `$` 前缀（`$if` / `$filter` / `$isolate`），那是 Koishi v4 时代的 loader 语法，**本仓库已完全重构，配置字段不带 `$`**（详见第六章）。

### 1.3 阅读本文的前置

代码大量使用 `Proxy`、`Reflect`、`Symbol.for`、原型链操作和 generator。特别是 `packages/core/src/utils.ts` 里的 traceable 代理，是全项目最烧脑的一段。建议先看完第三、四章的概念，再直接读源码。

---

## 二、仓库地图与阅读顺序

Monorepo，yarn workspaces，约 9200 行 TS（含测试）。

```
packages/
├── core/            cordis                              ← 内核，必读
│   ├── src/context.ts    Context 类本体（78 行，很薄）
│   ├── src/fiber.ts      Fiber 状态机 + effect（488 行，最核心）
│   ├── src/reflect.ts    Proxy handler + 服务注册表（283 行）
│   ├── src/registry.ts   插件注册表 + @Inject 装饰器（214 行）
│   ├── src/events.ts     事件系统（188 行）
│   ├── src/service.ts    Service 基类（80 行）
│   ├── src/logger.ts     日志服务（246 行）
│   ├── src/utils.ts      traceable 代理 + 错误栈拼接（282 行）
│   └── bin.js            CLI 入口（16 行，一眼看懂全貌）
├── loader/          @cordisjs/plugin-loader             ← 配置树 → Fiber 树
├── include/         @cordisjs/plugin-include            ← YAML/JSON 配置文件读写
├── group/           @cordisjs/plugin-group              ← 2 行 re-export，实体在 loader 里
├── hmr/             @cordisjs/plugin-hmr                ← 模块级热重载
├── timer/           @cordisjs/plugin-timer              ← 生命周期感知的定时器
├── logger-console/  @cordisjs/plugin-logger-console     ← 日志 Exporter 实现
├── utils/           @cordisjs/utils (private)           ← 一个 List 工具类
└── create/          create-cordis                       ← 脚手架，与运行时无关
```

### 建议的阅读顺序

1. **`packages/core/bin.js`**（16 行）—— 看清整个框架的启动路径
2. **`packages/core/src/context.ts`** —— Context 只有 78 行，先建立"它其实很薄"的认知
3. **`packages/core/tests/plugin.spec.ts` + `service.spec.ts`** —— 用测试建立 API 直觉
4. **`packages/core/src/fiber.ts`** —— 核心中的核心，反复读
5. **`packages/core/src/reflect.ts`** 的 `ReflectService.handler` —— 服务解析的全部魔法
6. **`packages/core/src/utils.ts:141-221`** —— traceable / shadow，最后攻克
7. **`packages/loader/`** —— 理解配置如何映射到运行时
8. **`packages/hmr/`** —— 建立在前面所有机制之上

---

## 三、七个核心概念

### 3.1 Context —— 空间坐标

`packages/core/src/context.ts:21`

一个 Context 就是一个"你在应用里的位置"。它本体极薄，真正的能力全靠 Proxy 拦截和服务挂载：

```ts
constructor() {
  this[symbols.isolate] = Object.create(null)      // 服务名 → 隔离 symbol
  this[symbols.intercept] = Object.create(null)    // 服务名 → 拦截配置
  const self = new Proxy<this>(this, ReflectService.handler)   // ← 关键
  this.root = self
  this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
  this.reflect = new ReflectService(self)
  this.registry = new RegistryService(self)
  this.events = new EventsService(self)
  this.logger = new LoggerService(self)
  return self                                       // 返回的是 Proxy，不是 this
}
```

**三种派生方式**（都不修改原 Context，返回新对象）：

| 方法 | 位置 | 语义 |
|---|---|---|
| `extend(meta)` | `context.ts:55` | `Object.create` 派生 + 挂属性。所有派生的基础 |
| `isolate(name, label?)` | `context.ts:65` | 在 `[symbols.isolate]` 原型链上覆盖一个服务名 → 新 symbol |
| `intercept(name, config)` | `context.ts:71` | 在 `[symbols.intercept]` 原型链上叠加一层配置 |

注意 `isolate` / `intercept` 用的都是 **`Object.create(原表)` + 覆盖单键**，因此这两张表天然是原型链结构，向上查找即可拿到继承的配置。`Service[symbols.resolveConfig]`（`service.ts:51`）就是沿这条链自底向上收集并合并的。

**`Context.is(value)`**（`context.ts:27`）用 `Symbol.for('cordis.is')` 做跨 realm 安全的类型判定——多个 cordis 副本共存时仍能互认。

### 3.2 Fiber —— 时间坐标

`packages/core/src/fiber.ts:103`

**一个插件实例 = 一个 Fiber**。它持有该插件的配置、依赖声明、所有副作用，并驱动一个状态机。

```ts
export const enum FiberState {
  PENDING,     // 依赖未就绪，插件未执行
  LOADING,     // 正在执行 apply / [Service.init]
  ACTIVE,      // 运行中
  FAILED,      // apply 抛错，粘性状态
  DISPOSED,    // 已销毁
  UNLOADING,   // 正在清理副作用
}
```

#### epoch：依赖快照

`fiber.ts:385-397` 的 `_refresh()` 把当前所有依赖的**提供者 fiber uid** 拼成一个字符串：

```ts
_refresh() {
  let epoch = ''
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name]
    if (!impl) { epoch = INACTIVE; break }    // 任一依赖缺失 → 整体失活
    epoch += ':' + impl.fiber.uid
  }
  this._setEpoch(epoch)
}
```

于是：
- 任一依赖不存在 → epoch = `'__INACTIVE__'` → 插件不加载（PENDING）
- 某个依赖换了提供者（uid 变了）→ epoch 变化 → 触发 unload + reload
- 依赖只是内部状态变了但 uid 没变 → epoch 不变 → 不重载

这是一个非常轻量而精确的依赖失效判据。

#### inertia lock：加载/卸载不可重入

`fiber.ts:399-415` 的 `_setEpoch()`：

```ts
private _setEpoch(epoch: string) {
  if (epoch === oldEpoch) return
  if (this._error) return              // FAILED 是粘性的，只有 update() 能解
  this._runner.epoch = epoch
  if (this.inertia) return             // ← 惯性锁：正在装/卸时不打断
  this._updateState(() => {
    if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
      this.inertia = this._reload();  return FiberState.LOADING
    } else {
      this.inertia = this._unload();  return FiberState.UNLOADING
    }
  })
}
```

`_reload()` / `_unload()` 结束时会**再比对一次 epoch**（`fiber.ts:429-436`、`452-459`），如果期间变了，就立刻续跑反向操作。这实现了"加载途中依赖被撤销 → 先装完再卸"的语义，避免半初始化状态。测试 `packages/core/tests/fiber.spec.ts:7-63` 三个 case 精确刻画了这个行为。

#### FAILED 的粘性

apply 抛错后 `_error` 被设置，此后**任何依赖变化都不会重新加载**（`fiber.ts:402-403` 的守卫）。只有显式 `fiber.update(config)`（`fiber.ts:478`）会清 `_error` 并 restart。设计意图：避免"插件坏了 → 依赖抖动 → 反复重试刷屏"。

### 3.3 Effect —— 副作用的统一抽象

`packages/core/src/fiber.ts:275-340`

Cordis 里**一切副作用都必须通过 `ctx.effect()` 注册**。这是资源不泄漏的根本保证。

支持四种返回形态（`fiber.ts:52-64`）：

```ts
// (a) 单个 disposable
ctx.effect(() => {
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)
}, 'my.timer')                              // 第二参 label 会出现在 getEffects() 里

// (b) generator —— 多段清理，倒序执行
ctx.effect(function* () {
  yield dispose1
  yield ctx.on('custom-event', handler)     // 事件监听本身也是 effect
  yield dispose2
})

// (c) Promise<Disposable>
ctx.effect(async () => { await connect(); return () => disconnect() })

// (d) async generator —— 逐段注册，可在任意 await 边界被中断
ctx.effect(async function* () {
  await sleep(100); yield cleanup1
  await sleep(100); yield cleanup2
})
```

**关键语义**（由 `packages/core/tests/dispose.spec.ts` 全面覆盖）：

- **清理是后进先出**（`fiber.ts:283` 的 `.splice(0).reverse()`），嵌套 effect 内部也倒序
- **异步 disposer 串行等待**（`fiber.ts:285-291`），不并发
- **async generator 在下一个 await 边界终止**（`fiber.ts:262-266` 每轮检查 `runner.epoch`），不是立即中断
- **执行期抛错 → 已注册部分被清理后再抛**（`fiber.ts:311-316`）
- **dispose 幂等**（`fiber.ts:323-324`）
- **effect wrapper 本身是 thenable**（`fiber.ts:333-337`），`await dispose` 得到"加载完成后的 dispose 函数"

`fiber.getEffects()`（`fiber.ts:342`）返回 effect 树，label 形如 `'ctx.on("custom-event")'`、`'ctx.provide("foo")'` —— 这是调试资源泄漏的利器。

**框架内部所有注册行为都建立在 effect 之上**：`ctx.on`（`events.ts:136`）、`ctx.provide`（`reflect.ts:392`）、`ctx.mixin`（`reflect.ts:457`）、`ctx.plugin`（`fiber.ts:170`）、`ctx.logger.exporter`（`logger.ts:395`）。这就是为什么插件卸载时一切都能自动收回。

### 3.4 Service —— 有生命周期的单例

`packages/core/src/service.ts:5`

```ts
class Foo extends Service {
  constructor(ctx: Context) { super(ctx, 'foo') }   // 第二参 = 服务名
}
await root.plugin(Foo)
root.foo instanceof Foo   // true
```

`Service` 构造函数（`service.ts:18-35`）做四件事：设置 tracker、必要时把自己变成可调用对象、挂 `symbols.tracker`、调 `ctx.reflect.provide(name, self, check)`。

**几个特殊 symbol**：

| Symbol | 用途 | 示例位置 |
|---|---|---|
| `Service.init` | 异步初始化。未完成前服务不算 ACTIVE，下游 inject 会一直等 | `packages/loader/src/config/group.ts:84` |
| `Service.invoke` | 让服务变成可调用对象：`ctx.foo()` | `packages/core/src/logger.ts:414` |
| `Service.extend` | 派生一个带覆盖属性的服务实例，保留 intercept 上下文 | `packages/core/tests/invoke.spec.ts:40` |
| `Service.check` | 额外的可用性检查，返回 false 则视为服务不可用 | `packages/loader/src/index.ts:133` |
| `Service.tracker` | 声明 traceable 代理的行为（见 3.7） | 到处都是 |
| `Service.resolveConfig` | 沿 intercept 原型链收集配置 | `service.ts:51` |

**层级服务名**：`super(ctx, 'foo.bar')` 会把服务挂到 `ctx.foo.bar`（`packages/core/tests/associate.spec.ts:15`）。

### 3.5 Registry —— 插件注册表

`packages/core/src/registry.ts:125`

**Plugin ↔ Runtime ↔ Fiber 的三层关系**：

- **Plugin**：函数 / 类 / `{ apply }` 对象，四种形态（`registry.ts:63-100`）
- **Runtime**：`Map<Function, Runtime>` 的值，一个插件对应一个 Runtime，持有 `fibers: DisposableList<Fiber>`
- **Fiber**：同一个插件被 `ctx.plugin()` 多次就有多个 Fiber

```ts
plugin(plugin, config, getOuterStack) {
  const callback = this.resolve(plugin)          // 拿到函数本体
  this.ctx.fiber.assertActive()
  let runtime = this._internal.get(callback)
  if (!runtime) { runtime = { name, callback, fibers: new DisposableList(), Config }; ... }
  const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
  const wrapped = Object.create(fiber)           // ← 返回的是 wrapper
  wrapped.then = (onF, onR) => fiber.await().then(onF, onR)
  return wrapped
}
```

返回的 **wrapper 是 `Object.create(fiber)`**，同时是 Fiber 又是 thenable。这里有个隐蔽的契约：`restart()` / `update()` 内部都先取 `const fiber = this.ctx.fiber` 再操作（`fiber.ts:470-487`），**绝不能在 wrapper 上写自有属性**，否则会与原型上的真实 fiber 状态脱节。测试 `packages/core/tests/fiber.spec.ts:156-168` 专门用 `Object.hasOwn` 断言了这一点。

**`@Inject` 装饰器**（`registry.ts:17-40`）有两种用法：

```ts
// 类装饰器 → 写入 static inject，支持原型链继承合并
@Inject('foo')
class Bar extends Service { ... }

// 方法装饰器 → 依赖就绪时自动执行该方法，返回值即 dispose
class Bar extends Service {
  @Inject('foo')
  method() { start(); return stop }
}
```

### 3.6 Reflect —— 服务解析的全部魔法

`packages/core/src/reflect.ts:275`，其中 `ReflectService.handler`（`reflect.ts:276-349`）是 Context 的 Proxy handler。

`ctx.foo` 的完整解析流程（`reflect.ts:277-314`）：

```
1. isSpecialProperty(prop)?            → 直通
   （symbol / 'prototype' / 'then' / 纯数字串 / '_' 开头）
2. Reflect.has(target, prop)?          → getTraceable(ctx, 值)
3. props[prop] 是 accessor?            → 调 accessor.get
4. def site 没有 fiber.runtime?        → 无条件放行（root 上直接 provide 的东西）
5. waterfall('internal/get', ...) 包裹下，沿 fiber 链向上查找：
     while (true) {
       impl = fiber.store?.[prop]
       if (impl) return getTraceable(ctx, impl.value)          ← 找到
       if (prop in fiber.inject) throw '在失活上下文中'          ← 声明了但没就绪
       if (!fiber.runtime) throw '未 inject'                    ← 到根了
       if (fiber.parent[isolate][prop] !== key) throw '未 inject' ← 跨越隔离边界
       fiber = fiber.parent.fiber
     }
```

**注意第 5 步的核心约束**：一个插件只能访问它 **`inject` 声明过的**服务。这不是软约定，是硬报错。两种错误信息要区分：

- `cannot get property "foo" without inject` —— 没声明
- `cannot get required service "foo" in inactive context` —— 声明了，但当前 fiber 已失活

**服务注册**：`reflect.provide()`（`reflect.ts:391`）是一个 effect，其清理回调的顺序值得注意：

```ts
return async () => {
  delete this.store[key]
  const fibers = this.notify([name])                        // 唤醒所有 inject 了它的 fiber
  await Promise.allSettled(fibers.map(f => f.await()))      // 等它们全部卸载完
  delete this.ctx.fiber.store![name]                        // 最后才移除自己
}
```

最后一行的注释是 `// ensure self access before dependencies cleanup` —— **依赖方卸载期间，仍然能访问到正在被销毁的服务**。这是个重要的契约。

**`notify(names, filter)`**（`reflect.ts:421`）：遍历 registry 里所有 fiber，按 isolate key 过滤，逐个 `_checkImpl` + `_refresh`，最后广播 `internal/service` 事件。这是服务变化传播的唯一入口。

**`mixin(source, mixins)`**（`reflect.ts:455`）：把服务上的方法平铺到 Context 上。`ctx.mixin('timer', ['timeout', 'interval'])` 之后，`ctx.timeout(...)` 等价于 `ctx.timer.timeout(...)`。实现上是批量注册 accessor。

### 3.7 traceable / shadow —— 最烧脑的一段

`packages/core/src/utils.ts:141-221`

**要解决的问题**：服务 `Outer` 内部访问 `this.ctx.inner`，这个 `this.ctx` 到底是谁的 ctx？

- 如果是**调用方**的 ctx：那么 `Outer` 能否访问 `inner` 就取决于调用方声明了什么 inject —— 荒谬，`Outer` 的依赖应该由 `Outer` 自己声明。
- 如果是**定义方**的 ctx：那么调用方设置的 `intercept` / `isolate` 就失效了 —— 也不对。

**Cordis 的答案：两者都要，用一对 (def site, use site) 表示。**

```ts
// utils.ts:158-163
// `ctx` may be a shadow, i.e. a pair of:
// - def site: where the accessing code was defined, governs service resolution
// - use site: where the service is consumed, governs intercept, isolate and effects
function createTraceable(ctx, value, tracker) {
  const defSite = ctx[symbols.shadow] ?? ctx
  const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) : ctx
  ...
}
```

- **def site** 治理：服务解析、inject 检查
- **use site** 治理：intercept 配置、isolate 隔离、effect 归属

**`Service.tracker`** 声明一个对象如何参与这套机制：

```ts
interface Tracker {
  associate?: string    // 关联命名空间，见下
  property?: string     // 哪个属性是 ctx（通常是 'ctx'）
  noShadow?: boolean    // 不参与 shadow 机制
}
```

当你访问 `ctx.foo` 时，如果 `foo` 有 tracker，返回的不是原始对象而是一个 Proxy（`utils.ts:164`）。这个 Proxy 拦截 `get`：

- 读 `tracker.property`（即 `ctx`）→ 返回 **use site**
- 读 `symbols.caller` → 返回 **def site**
- 读方法 → 包一层 `createShadowMethod`，调用时把 `thisArg` 替换成带 shadow 的版本（`utils.ts:149-156`）

**关键结论**（由 `packages/core/tests/shadow.spec.ts` 验证）：

1. 服务内部访问其他服务，**始终以自己的 inject 声明为准**，即使从 root 调用进来也一样（`shadow.spec.ts:60-91`）
2. **shadow 深度恒为 1**，不会层层套娃（`shadow.spec.ts:93-155`）
3. root 上直接 `provide` 的对象保持 unchecked 访问，因为它没有 fiber，无从声明 inject（`reflect.ts:294-295`）
4. `noShadow: true` 的服务仍暴露 `symbols.caller` 但不做 shadow —— core 内部的 `reflect` / `registry` / `events` / `logger` 都是这样

**associate**：让任意对象拥有服务命名空间。

```ts
class Session {
  [Service.tracker] = { property: 'ctx', associate: 'session' }
  constructor(public ctx: Context) {}
}
// 某个服务里
ctx.mixin('bar', { answer: 'session.answer' })
// 之后任何 Session 实例都有 .answer()，且解析规则跟随 Bar 服务自己的 inject
```

实现在 `utils.ts:172-176`：`session.answer` 被改写成 `Reflect.get(ctx, 'session.answer', ...)`。

### 3.8 Events —— 五种分发模式

`packages/core/src/events.ts:45`

| 方法 | 语义 |
|---|---|
| `emit` | 同步遍历，异常直接抛 |
| `parallel` | `Promise.allSettled`，错误聚合成 `AggregateError` |
| `serial` | 串行 await，遇到非 `null`/`false`/`undefined` 即返回 |
| `bail` | `serial` 的同步版 |
| `waterfall` | 洋葱模型，每个 handler 收到 `next`，逐层下钻 |

**`waterfall` 是框架内部的扩展点机制**（`events.ts:117-132`）。`internal/get`、`internal/set`、`internal/update`、`loader/patch-context` 都是 waterfall —— 插件可以插到中间改写行为。`next()` 重复调用会抛 `next() called multiple times`。

**过滤器分发**：`emit` 的第一参可选传 `thisArg`，若它有 `[Context.filter]` 方法，则只有通过过滤的 handler 会被调用（`events.ts:78-80`）。`Service` 默认实现按 isolate key 过滤（`service.ts:37-39`），这就是"隔离的服务发出的事件只有同隔离域能收到"的原因。

**内部事件清单**（`events.ts:178-188`）：

```ts
'internal/plugin'(fiber)                          // fiber 创建（uid 有值）/ 销毁（uid === null）
'internal/status'(fiber, oldState)                // 状态机迁移
'internal/service'(name, value)                   // 服务变化
'internal/update'(config, noSave, next)           // 配置更新（waterfall）
'internal/get'(ctx, name, error, next)            // 属性读取（waterfall）
'internal/set'(ctx, name, value, error, next)     // 属性写入（waterfall）
'internal/listener'(name, listener, prepend)      // 监听器注册拦截
'internal/dispatch'(mode, name, args, thisArg)    // 所有非 internal 事件的旁路观察
```

读源码时看到这些事件名就要意识到：**这是一个扩展点，某个插件可能挂在这里改写行为**。

---

## 四、三条主链路

### 4.1 插件加载

```
ctx.plugin(Foo, config)
  └─ registry.plugin()                                  registry.ts:193
       ├─ resolve(plugin) → callback
       ├─ assertActive()                                fiber.ts:224
       ├─ 建/取 Runtime
       └─ new Fiber(ctx, config, inject, runtime, stack)  fiber.ts:122
            ├─ uid = registry.counter
            ├─ ctx = parent.extend({ fiber: this })
            ├─ 把 inject 里的 config 写进 [Context.intercept]
            ├─ emit('internal/plugin', this)            ← loader 在这里认领 entry
            ├─ 对每个 inject 的名字 _checkImpl()
            └─ dispose = parent.fiber.effect(() => {    ← 注册到父 fiber！
                 runtime.fibers.push(this)
                 this.config = resolveConfig(runtime, config)   // standard-schema 校验
                 this._refresh()                        ← 算 epoch，可能触发 _reload
                 return async () => { ...卸载逻辑... }
               }, 'ctx.plugin()')
```

**注意 `dispose` 是注册在父 fiber 上的 effect** —— 这就是插件树级联卸载的实现：父插件卸载 → 它的 effect 全部清理 → 子插件的 dispose 被调用。

`_reload()`（`fiber.ts:417`）：

```ts
this.store = { ...this._store }        // 冻结依赖快照，apply 期间看到的服务是一致的
await Promise.resolve()                // 强制异步，保证 apply 不在同步栈里执行
await this._execute(this._runner)      // 真正调 apply / new Plugin() / [Service.init]
```

对构造器插件，`execute`（`fiber.ts:149-159`）还会跑 `[symbols.initHooks]`（`@Inject` 方法装饰器注册的）和 `[symbols.init]`。

### 4.2 服务提供与消费

```
提供侧：
new Service(ctx, 'foo')
  └─ ctx.reflect.provide('foo', self, check)            reflect.ts:391
       └─ ctx.fiber.effect(() => {
            props['foo'] = { type: 'service' }
            root[isolate]['foo'] ??= Symbol('foo')
            store[key] = { name, value, fiber, check }
            fiber.store['foo'] = impl
            if (fiber.state === ACTIVE) notify(['foo'])  ← 唤醒等待者
            return async () => { ...见 3.6... }
          })

消费侧：
ctx.foo
  └─ ReflectService.handler.get                         reflect.ts:277
       └─ 沿 defSite.fiber 链向上找 store['foo']
            └─ getTraceable(ctx, impl.value)            utils.ts:110
```

`_checkImpl(name)`（`fiber.ts:371`）是"某个依赖当前是否可用"的判定：拿到 impl、跑 `check()`（如果有）、结果写进 `_store`。`_refresh()` 再据此算 epoch。

### 4.3 卸载与级联

```
fiber.dispose()
  └─ effect wrapper（父 fiber 上的那个）
       └─ 卸载回调（fiber.ts:179-198）
            ├─ uid = null                              ← 立刻失活，assertActive 开始报错
            ├─ emit('internal/plugin', this)           ← loader 在这里判断是否"插件自杀"
            ├─ runtime.fibers 移除自己；空了就 registry.delete
            ├─ _setEpoch(INACTIVE) → _unload()
            │    └─ Promise.all(_disposables.clear().map(dispose))
            │         └─ 所有 effect 倒序清理
            │              └─ 其中包含子 fiber 的 dispose → 递归
            └─ while (this.inertia) await this.inertia  ← 等惯性结算
```

**服务卸载的级联**走的是另一条路：`provide` 的清理回调 → `notify([name])` → 所有 inject 了它的 fiber `_refresh()` → epoch 变 INACTIVE → 各自 `_unload()`。

**root fiber 的 dispose 是 restart 语义**（`fiber.ts:211`）：`root.fiber.dispose()` 不会把 root 变成 null，而是清空所有子插件后保持 uid = 0。

---

## 五、隔离与拦截

### 5.1 isolate —— 服务的空间分区

服务在内部是按 **symbol** 索引的，不是按字符串名。`ctx[symbols.isolate]` 是"服务名 → symbol"的映射表。

```ts
root.provide('foo', { bar: 100 })
root.foo.bar            // 100

const ctx1 = root.isolate('foo')          // 匿名：Symbol('foo')，谁也不共享
ctx1.foo                // undefined
ctx1.provide('foo', { bar: 200 })         // ctx1 有自己的实现

const label = Symbol('shared')
const a = root.isolate('foo', label)
const b = root.isolate('foo', label)      // 同 label ⇒ a 和 b 共享
a.provide('foo', { bar: 300 })
b.foo.bar               // 300
```

**事件也受隔离约束**：`Service[symbols.filter]`（`service.ts:37`）比对 isolate key，所以隔离域内的服务发出的事件不会泄漏到域外（`packages/core/tests/isolate.spec.ts:104-122`）。

### 5.2 intercept —— 服务的调用配置

```ts
const ctx1 = root.intercept('foo', { b: 2 })
ctx1.foo()    // 服务通过 Service.resolveConfig 拿到合并后的 { a: 1, b: 2 }
```

`ctx.inject({ foo: cfg }, callback)` 是隐式 intercept —— Fiber 构造函数会把 inject 的 config 写进 `[Context.intercept]`（`fiber.ts:137-144`）。

配置合并沿原型链自底向上（`service.ts:51-67`），若服务类上有 `Config.merge` 则用之，否则 `Object.assign`。

---

## 六、Loader 层：配置树 → Fiber 树

### 6.1 整体设计

`@cordisjs/plugin-loader` 把**一棵声明式配置树**映射成**一棵运行中的 Fiber 树**，并维持双向同步。

关键的抽象倒置：**loader 本身不认识 YAML**。`Loader` 是抽象基类 `EntryTree` 的一个内存实现，`write()` 是 no-op（`packages/loader/src/index.ts:129-131`）。真正的文件读写在独立包 `@cordisjs/plugin-include` 里。这让整个配置树逻辑可以脱离文件系统单测（`packages/loader/tests/utils.ts:30`）。

启动全貌就是 `packages/core/bin.js` 的 16 行：

```js
const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: { path: './cordis.yml' },
})
```

### 6.2 四个核心抽象

| 类 | 位置 | 职责 |
|---|---|---|
| `EntryTree` | `packages/loader/src/config/tree.ts:6` | 一个配置源（一个 YAML 文件 / loader 的内存根） |
| `Entry` | `packages/loader/src/config/entry.ts:34` | 一条配置项 ↔ 一个 Fiber |
| `EntryGroup` | `packages/loader/src/config/group.ts:5` | 有序 entry 列表容器 |
| `Group` | `packages/loader/src/config/group.ts:73` | 面向用户的分组插件（`@cordisjs/plugin-group` 的实体） |

**树的嵌套**：一个 entry 如果加载的是 `@cordisjs/plugin-include`，那个 Include 实例本身是个 EntryTree，就成了该 entry 的 `subtree`。`EntryTree.entries()`（`tree.ts:25`）深度优先遍历会跨越树边界。层级 id 用 `:` 分隔：`include1:group2:plugin3`。

### 6.3 配置字段

来自 `packages/loader/src/config/entry.ts:8-15` + `isolate.ts:5-14`：

| 字段 | 语义 |
|---|---|
| `id` | 树内唯一标识，缺省时随机生成 8 位十六进制 |
| `name` | 模块 specifier。`./x` 相对 baseUrl，`@scope/pkg` 走 node resolve，`cordis:x` 查内建表 |
| `config` | 传给插件的配置。非 group 时会做 JS 表达式插值；group 时是子 entry 数组 |
| `group` | 标记为分组容器：`disabled` 计算跳过自身、日志静默 |
| `disabled` | 停用，**向下继承给整个子树** |
| `inject` | 追加依赖声明，与插件自身的 `inject` 合并 |
| `intercept` | 拦截配置，**沿 group 链原型继承** |
| `isolate` | `true` = 私有隔离域，字符串 = 具名共享域 |

典型配置：

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root: ['.']
    debounce: 100
- id: alpha
  name: '@cordisjs/plugin-group'
  group: true
  isolate:
    bar: true                # 私有域，symbol = Symbol('bar#alpha')
  intercept:
    foo: { a: 1 }
  config:
    - id: inner
      name: ./my-plugin
```

**JS 表达式插值**是配置里唯一的动态语法，通过 YAML 自定义标签 `!!js` 实现（`packages/include/src/index.ts:8-16`）：

```yaml
config:
  port: !!js process.env.PORT || 8080
```

解析成 `{ __jsExpr: '...' }`，由 `interpolate()`（`packages/loader/src/config/utils.ts:10`）在 entry 的 context 里 `with (ctx) { eval(...) }` 求值；写回时还原成原表达式文本，不会被求值结果污染。

### 6.4 双向同步与防环

**方向 A：配置 → Fiber**（`packages/loader/src/config/entry.ts:100-134`）

```
Entry.update(options, create, force)
  1. 合并 options（nullable 值 = 删除该键），sortKeys 归一化
  2. if (this.disabled) → fiber.dispose(); return
  3. if (fiber 活着):
       diff = 变化的键
       if (!diff.length && !force) return                    ← 无变化短路
       emit('loader/partial-dispose', ...)
       _patchContext(diff) → fiber.update(config, noSave=true)  ← 注意 noSave
     else:
       await this.init()  → registry.plugin(...)
```

**方向 B：Fiber → 配置**（`packages/loader/src/index.ts:74-80`，`{ global: true, prepend: true }`）

```ts
ctx.on('internal/update', function (config, noSave, next) {
  if (!this.entry || noSave || this.parent.fiber?.entry === this.entry) return next()
  this.entry.options.config = unparse ? unparse(config) : config
  this.entry.parent.tree.write()
  return next()
}, { global: true, prepend: true })
```

**三层防环设计**：
1. 配置→Fiber 时传 `noSave=true`
2. Fiber→配置时检查三个跳过条件
3. 文件层再加 `read()` 内容比对 + `.tmp` + `rename` 原子写（`packages/include/src/index.ts:87, 201-202`）

**`_patchContext` 为什么用 waterfall**（`entry.ts:84-92`）：

```ts
this.context.waterfall('loader/patch-context', this, () => {
  Object.setPrototypeOf(this.ctx, this.parent.ctx)
  if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
    this.fiber.update(this._resolveConfig(...), true)
  }
})
```

因为 isolate 插件需要把"Fiber 重载"这一步**夹在 isolate map 替换的前后**（`packages/loader/src/config/isolate.ts:92-149` 的 7 步流程），才能在服务换隔离域时不误伤注入者。这个执行顺序是正确性必需的。

### 6.5 "插件自杀"的六层排除

`packages/loader/src/index.ts:88-124` 是整个 loader 里最微妙的一段。`internal/plugin` 事件在 fiber 创建和销毁时都会发，loader 需要精确识别"用户插件主动调了 `ctx.fiber.dispose()`"，才好把 `disabled: true` 写回配置文件：

```
case 1  fiber.uid 有值           → 这是创建事件
case 2  !fiber.entry             → 不归 loader 管
case 3  parent.fiber.entry 相同  → entry 内部的子插件
case 4  !registry.has(callback)  → 是 registry.delete() 引发的（HMR 走这条）
case 5  tree 在卸载              → 整棵树下线
case 6  entry.disabled           → 是配置/祖先 group 造成的
--------------------------------------------------------
活到最后 → 真·插件自杀 → options.disabled = true; tree.write()
```

case 4 的注释点出了关键：**插件自杀是 dispose→delete，HMR 是 delete→dispose，顺序相反**。这是 loader 与 hmr 协作的核心判据。

---

## 七、HMR：模块级热重载

`packages/hmr/src/index.ts:51`

### 7.1 物理基础：Node 内部 ModuleLoader

`packages/loader/src/internal.ts` 通过两条路径抓取 Node 的**内部 ESM CascadedLoader 实例**：

1. `--expose-internals` + `require('internal/modules/esm/loader')`
2. `node-addon-require-builtin` 这个 native addon（optional peer dep）

拿到后能访问 `loadCache`（url → ModuleJob 映射）、`resolveSync`、`import`。**`loadCache` 是能够失效模块的唯一途径**，`ModuleJob.linked` 则是依赖图的边。

`internal.ts:50-92` 用 v1/v2 两套接口定义把 Node 22/23 与 Node 24 的破坏性变更收敛在一处（方法改名、参数顺序反转、`loadCache` 结构变化）。缺失时 loader 优雅降级为普通 `import()`，功能正常但 HMR 不可用（hmr 构造时直接抛错）。

### 7.2 四个 URL 集合

```
externals   CLI 入口的依赖闭包，改动 → 整进程重启
stashed     待处理的原始文件变更
accepted    应当被重载的模块
declined    不应被重载的模块
```

### 7.3 文件变更的四路分发

`packages/hmr/src/index.ts:127-152`：

```
1. 在 externals 里          → loader.exit()          全量重启
2. 在 loadCache 里          → stashed.add + debounce  局部热重载
3. 是某个 Include 的配置文件 → include.refresh()      配置重载（走 6.4 方向 A）
4. 兜底                     → emit('hmr/change', url)
```

### 7.4 失效传播：不动点迭代

`analyzeChanges()`（`hmr/src/index.ts:174-227`）的规则：

> 一个模块被 accepted，当且仅当它被直接改动，或它的某个依赖被 accepted；
> 被 declined，当且仅当它所有依赖都 declined，或它是 external。

反复扫描 pending 集合直到一轮无变化。**循环依赖里无法判定的一律 declined** —— 保守策略，宁可少 reload。

### 7.5 partialReload 的七个阶段

`hmr/src/index.ts:229-381`：

1. **收集所有 entry 的插件名，按 baseUrl 分桶** —— 嵌套配置树里的相对 specifier 必须用它自己那棵树的 baseUrl 解析
2. **解析成 URL，筛出候选**，并把插件入口自身加入 declined（插件入口是原子重载单元）
3. **判定需重载的插件**：临时摘出自己，收集依赖闭包，闭包里有 accepted 文件则该插件需重载
4. **清缓存并备份**：必须用 `Map.prototype.delete.call()` 而非 `loadCache.delete()`（Node 24 重写了 delete，只置空 type 槽）；同时清 `require.cache`
5. **重新 import**：任一失败 → 回滚 + 提前返回，**不动任何已运行的插件**（这是"语法错误时旧插件继续工作"的保证）
6. **替换 registry 里的插件**：

```ts
this.ctx.registry.delete(plugin)                                    // 旧插件下线
const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber.config, stack)
fiber.entry = oldFiber.entry          // ← 关键
if (fiber.entry) fiber.entry.fiber = fiber   // ← 关键
```

这两行赋值是 **loader 与 hmr 协作的唯一硬耦合点**。用 `oldFiber.parent.registry` 而非全局 registry，保持了原来的 context 层级，因而 group 嵌套、isolate realm、intercept 原型链全部保留。

7. **失败回滚**：`touched` 记录已处理的插件，任一失败则逐个反向操作。

### 7.6 错误处理的三层

- **构建/语法错误**（`hmr/src/error.ts:10-35`）：识别 esbuild `BuildFailure`，用 `@babel/code-frame` 生成带高亮的代码框
- **HMR 流程内错误**：import 阶段和 reload 阶段各有独立回滚
- **插件 apply 运行时错误**：**不由 HMR 处理**，由 fiber 系统吞下存进 `_error`。结果是旧插件已卸载、新插件 FAILED，但进程与 HMR 服务存活，改对文件后自动恢复

---

## 八、周边包速览

### timer —— `@cordisjs/plugin-timer`

生命周期感知的定时器，全部注册为 effect，插件卸载自动清理。

```ts
ctx.timeout(cb, delay)      // → dispose
await ctx.timeout(delay)    // Promise 形态，context dispose 时 reject
ctx.interval(cb, delay)     // → dispose
for await (const _ of ctx.interval(1000)) { ... }   // 异步迭代器形态
ctx.throttle(cb, delay)     // → fn & { dispose }
ctx.debounce(cb, delay)     // → fn & { dispose }
```

通过 `ctx.mixin('timer', [...])`（`packages/timer/src/index.ts:14`）把方法平铺到 Context 上。异步迭代器版本支持并发 `next()`、`return()`、`throw()`。

### group —— `@cordisjs/plugin-group`

**整个包只有两行**（`packages/group/src/index.ts:1-2`），re-export loader 里的 `Group` 类。存在的意义是让配置文件能写 `name: '@cordisjs/plugin-group'`。

### include —— `@cordisjs/plugin-include`

把另一个配置文件挂载为子配置树，并支持 patch 改写：

```yaml
- name: '@cordisjs/plugin-include'
  config:
    path: ./base.yml
    patches:
      - id: inner
        disabled: true                    # 覆盖字段
      - id: some-group
        insert: [{ id: extra, name: ./x }]  # 插入新 entry
```

patch 若带 `name` 字段，会做一致性断言，不匹配则 warn 并跳过。

### logger-console

`Exporter` 实现，条件导出 node/browser 两个版本。Node 版用 `util.inspect` 格式化对象 + `supports-color` 探测颜色；浏览器版直接传原始参数给 `console.log`，保留对象展开能力。

### utils（private）

只有一个 `List<T>` 类，"生命周期感知的集合"：`push` 不返回 dispose，而是把移除绑定到调用方 ctx 的 fiber 上。

### create —— `create-cordis`

脚手架 CLI，与运行时无关。值得一提的是 `stageYarnBin`（`packages/create/src/index.ts:88-168`）的 5 条 yarn 版本处理规则和跨项目共享缓存。

---

## 九、源码阅读速查表

### 核心机制定位

| 想搞清楚 | 去看 |
|---|---|
| Context 有哪些能力 | `packages/core/src/context.ts:9-19` 的 interface |
| `ctx.foo` 怎么解析的 | `packages/core/src/reflect.ts:277-314` |
| 插件什么时候被加载 | `packages/core/src/fiber.ts:385-415`（epoch + _setEpoch） |
| 副作用怎么清理的 | `packages/core/src/fiber.ts:275-340` |
| 加载/卸载竞态怎么处理 | `packages/core/src/fiber.ts:417-460`（_reload / _unload） |
| shadow 到底是什么 | `packages/core/src/utils.ts:158-216` |
| 服务卸载怎么级联 | `packages/core/src/reflect.ts:391-443`（provide 的清理回调 + notify） |
| 隔离怎么实现的 | `packages/core/src/context.ts:65-69` + `packages/core/src/service.ts:37-39` |
| 配置怎么变成插件 | `packages/loader/src/config/entry.ts:100-172` |
| 配置怎么写回文件 | `packages/loader/src/index.ts:74-80` + `packages/include/src/index.ts:192-216` |
| 热重载怎么工作 | `packages/hmr/src/index.ts:229-381` |

### 用测试当文档

`packages/core/tests/` 下的测试写得很好，几乎是可执行的规格说明：

| 文件 | 覆盖内容 |
|---|---|
| `plugin.spec.ts` | 四种插件形态、级联卸载、无泄漏保证、inactive context 报错 |
| `fiber.spec.ts` | **inertia lock 三个 case**、FAILED 粘性、wrapper 不写自有属性 |
| `dispose.spec.ts` | effect 的四种形态、清理顺序、异步中断时机、抛错时的清理契约 |
| `service.spec.ts` | `[Service.init]` 阻塞下游、多服务乱序注册不死锁、traceable effect 归属 |
| `shadow.spec.ts` | def site / use site 分离、shadow 深度恒为 1、未 inject 必报错 |
| `associate.spec.ts` | 层级服务名、mixin 到关联对象、关联访问跟随服务自身 fiber |
| `isolate.spec.ts` | 匿名 / 具名隔离、事件受隔离约束 |
| `invoke.spec.ts` | 可调用服务、`Service.extend` 保留 intercept |
| `logger.spec.ts` | logger 名字解析优先级链 |
| `events.spec.ts` | 五种分发模式、waterfall 的 next() 契约、过滤器分发 |

### 几个容易踩的坑

1. **`ctx.plugin()` 返回的是 wrapper 不是 fiber**，别在上面写属性
2. **服务里的 `this.ctx` 不是简单的 context**，它带 shadow，读它得到的是 use site
3. **`Symbol.for` 而非 `Symbol`**，所有跨模块 symbol 都用全局注册表，为的是多副本共存
4. **`internal/*` 事件不走 `internal/dispatch` 旁路**（`events.ts:75`），避免无限递归
5. **root fiber（uid = 0）没有 runtime**，很多逻辑对它有特判
6. **配置字段没有 `$` 前缀**，网上搜到的 `$if`/`$isolate` 是 Koishi 老语法

---

## 十、设计要点总结

1. **一切副作用都是 effect** —— 这是资源不泄漏的根本，也是整个框架能做热重载的前提。
2. **epoch 作为依赖失效判据** —— 用一个拼接字符串精确表达"依赖集合是否发生了实质变化"，既避免漏更新也避免过度重载。
3. **inertia lock** —— 加载/卸载不可重入，反向操作在当前操作完成后自动续跑，杜绝半初始化状态。
4. **def site / use site 分离** —— 服务解析跟定义位置走，配置与隔离跟消费位置走。这是 Cordis 最独特的设计，也是"时空可组合"这个说法的直接体现。
5. **抽象倒置** —— loader 只依赖 `EntryTree` 抽象，文件系统在 include 包里，使配置树逻辑可脱离 IO 单测。
6. **waterfall 作为扩展点** —— 内部关键路径都是 waterfall 而非 emit，让插件能精确插入到某两步之间。
7. **保守优先** —— HMR 在循环依赖处一律拒绝重载，任一环节失败就全量回滚。宁可少做，不留半崩溃状态。

---

## 附：核心符号索引

| 符号 | 位置 |
|---|---|
| `Context` | `packages/core/src/context.ts:21` |
| `Context.extend / isolate / intercept` | `packages/core/src/context.ts:55 / 65 / 71` |
| `Fiber` | `packages/core/src/fiber.ts:103` |
| `FiberState` | `packages/core/src/fiber.ts:78` |
| `Fiber.effect` | `packages/core/src/fiber.ts:275` |
| `Fiber._refresh / _setEpoch` | `packages/core/src/fiber.ts:385 / 399` |
| `Fiber._reload / _unload` | `packages/core/src/fiber.ts:417 / 439` |
| `Fiber.update / restart` | `packages/core/src/fiber.ts:478 / 470` |
| `Service` | `packages/core/src/service.ts:5` |
| `Service.resolveConfig` | `packages/core/src/service.ts:51` |
| `ReflectService.handler` | `packages/core/src/reflect.ts:276` |
| `ReflectService.provide / notify / mixin` | `packages/core/src/reflect.ts:391 / 421 / 455` |
| `RegistryService.plugin` | `packages/core/src/registry.ts:193` |
| `@Inject` | `packages/core/src/registry.ts:17` |
| `EventsService` | `packages/core/src/events.ts:45` |
| `waterfall` | `packages/core/src/events.ts:117` |
| `createTraceable`（shadow 核心） | `packages/core/src/utils.ts:161` |
| `getTraceable` | `packages/core/src/utils.ts:110` |
| `composeError`（长栈拼接） | `packages/core/src/utils.ts:264` |
| `symbols` 全表 | `packages/core/src/utils.ts:47-71` |
| `Loader` | `packages/loader/src/index.ts:47` |
| `EntryTree` | `packages/loader/src/config/tree.ts:6` |
| `Entry` / `Entry.update` | `packages/loader/src/config/entry.ts:34 / 100` |
| `EntryGroup.update`（配置 diff） | `packages/loader/src/config/group.ts:47` |
| `Group` | `packages/loader/src/config/group.ts:73` |
| isolate 插件 7 步流程 | `packages/loader/src/config/isolate.ts:92` |
| `ModuleLoader.fromInternal` | `packages/loader/src/internal.ts:111` |
| `Include` | `packages/include/src/index.ts:48` |
| `Hmr` | `packages/hmr/src/index.ts:51` |
| `Hmr.analyzeChanges` | `packages/hmr/src/index.ts:174` |
| `Hmr.partialReload` | `packages/hmr/src/index.ts:229` |
| `TimerService` | `packages/timer/src/index.ts:11` |
