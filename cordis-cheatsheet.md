# Cordis 速查笔记（Cheatsheet）

> Cordis 是一个基于「上下文（Context）+ 插件（Plugin）+ 依赖注入」的框架。
> 本笔记按**概念主题**组织，每个 API 采用统一的四段式：**定位 → 最小代码 → 关键机制 → 对应示例**。
> 所有「关键机制」均核对自 `packages/core/src` 源码，标注了精确位置便于回查。

## 目录

1. [上下文与服务（Context / Service）](#1-上下文与服务context--service)
2. [依赖注入（inject / @Inject）](#2-依赖注入inject--inject)
3. [副作用与生命周期（effect / Fiber 状态机 / dispose）](#3-副作用与生命周期effect--fiber-状态机--dispose)
4. [事件总线（emit / parallel / serial / bail / waterfall）](#4-事件总线emit--parallel--serial--bail--waterfall)
5. [服务隔离与配置注入（isolate / intercept）](#5-服务隔离与配置注入isolate--intercept)
6. [服务声明进阶（provide / accessor / mixin）](#6-服务声明进阶provide--accessor--mixin)
7. [插件三形态与注册表（plugin / registry）](#7-插件三形态与注册表plugin--registry)

配套可运行示例（均已通过 `tsc` + `tsx` 验证）：

| 示例文件                       | 覆盖主题                                          |
| ------------------------------ | ------------------------------------------------- |
| `example-basic.ts`             | Service / inject / effect / dispose               |
| `example-events.ts`            | 事件总线 5 种分发模式                             |
| `example-lifecycle.ts`         | Fiber 状态机 / update / restart / registry        |
| `example-plugin-forms.ts`      | 插件三形态 / @Inject / provide / accessor / mixin |
| `example-isolate-intercept.ts` | isolate / intercept                               |
| `example-plugin-config.ts`     | 插件配置校验 Config / 规范化 / ValidationError    |

---

## 1. 上下文与服务（Context / Service）

### Context

- **定位**：贯穿全局、承载所有服务的核心对象；一切能力都挂在 `ctx` 上，派生上下文通过 `extend` 沿原型链继承。
- **最小代码**：

```typescript
import { Context } from "cordis";

const ctx = new Context();
```

- **关键机制**：`ctx` 是一个 Proxy，服务属性（如 `ctx.database`）在**读取时**才从「隔离域 + store」里实时解析，而非静态字段。
- **对应示例**：所有示例。

### Service（服务基类）

- **定位**：编写可注入服务时继承它；实例化即自动注册到 `ctx`。
- **最小代码**：

```typescript
class Database extends Service {
  constructor(ctx: Context) {
    super(ctx, "database"); // 第二参数即服务名
  }
  set(key: string, value: any) {
    /* ... */
  }
}

// 让 TS 知道 ctx 上有 database（运行时靠服务解析，编译期靠这个声明）
declare module "cordis" {
  interface Context {
    database: Database;
  }
}

ctx.plugin(Database); // 加载后即可 ctx.database.set(...)
```

- **关键机制**：`super(ctx, name)`（`service.ts:30-59`）在构造末尾调用 `ctx.reflect.provide(name, self, check?)`（`service.ts:57`）完成**自动注册**；若 `name` 省略则回退到子类静态 `provide`。
- **对应示例**：`example-basic.ts`（Database）、`example-plugin-forms.ts`（Config）。

> ⚠️ **多个示例文件都 `declare module 'cordis'` 声明同名属性（如 `database`）时会 TS2717 冲突**——因为同名属性的类型必须完全一致。单独跑某个示例没问题，但让 IDE 同时把它们纳入同一编译单元就会报错。

---

## 2. 依赖注入（inject / @Inject）

### plugin.inject（函数/对象插件声明依赖）

- **定位**：插件声明它依赖哪些服务；**依赖就绪才激活**（依赖驱动）。
- **最小代码**：

```typescript
function userPlugin(ctx: Context) {
  // 能进来说明 database 已就绪
  ctx.database.set("alice", { age: 20 });
}
userPlugin.inject = ["database"];

ctx.plugin(userPlugin); // database 未提供时保持 PENDING，不执行回调
ctx.plugin(Database); // 依赖满足 → userPlugin 自动激活
```

- **关键机制**：`inject` 可以是**服务名数组** `string[]`，也可以是 **名→拦截配置的映射** `{ [name]: config }`（`registry.ts:15`）。
- **对应示例**：`example-basic.ts`。

### ctx.inject(deps, callback)（内联依赖注入）

- **定位**：临时声明依赖并在就绪后执行回调，是「匿名对象插件」的语法糖。
- **最小代码**：

```typescript
ctx.inject(["config"], (ctx) => {
  // 此处 ctx.config 一定可用
  ctx.mixin("config", { read: "readConfig" });
});
```

- **关键机制**：内部就是 `this.plugin({ inject, apply: callback, name: callback.name })`（`registry.ts:258-260`），返回可 `await` 的 `Fiber`。
- **对应示例**：`example-plugin-forms.ts`（mixin 前置）。

### @Inject 装饰器

- **定位**：在 class / method 上声明依赖，等价于 `inject`。
- **最小代码**：

```typescript
@Inject("config")
class ClassPlugin {
  constructor(ctx: Context) {
    console.log(ctx.config.read("env")); // config 已就绪
  }
}
ctx.plugin(ClassPlugin);
```

- **关键机制**：是 **TC39 标准（stage-3）装饰器**，不是 legacy（`registry.ts:27-63`）。按 `decorator.kind` 分流：`'class'` 挂到类的 `inject` 原型链；`'method'` 通过 `addInitializer` 把方法调用包进 `ctx.inject(...)`；其他 kind 抛错。
- **对应示例**：`example-plugin-forms.ts`（ClassPlugin）。

---

## 3. 副作用与生命周期（effect / Fiber 状态机 / dispose）

### effect（副作用注册）

- **定位**：在插件里登记「需要清理的资源」，插件卸载时自动回收。
- **最小代码**：

```typescript
ctx.effect(() => {
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer); // 返回清理函数
});
```

- **关键机制**：单个 `effect` 内部的多个 disposable **按 LIFO（后进先出）清理**（`fiber.ts:369-438`，disposer 里 `.reverse()`）。注意：fiber 整体卸载 `_unload()` 时，是把各顶层 disposable 用 `Promise.all` **并行**跑（`fiber.ts:579-602`）。
- **对应示例**：`example-basic.ts`（tick 监听）、`example-lifecycle.ts`。

### Fiber 状态机

- **定位**：每次 `ctx.plugin()` 返回一个 Fiber，代表该插件实例的生命周期。
- **状态枚举**（`FiberState`，`fiber.ts:110-123`，是 **`const enum`**）：

| 值  | 状态      | 含义                 |
| --- | --------- | -------------------- |
| 0   | PENDING   | 依赖未满足，挂起等待 |
| 1   | LOADING   | 加载中（回调执行中） |
| 2   | ACTIVE    | 已激活、稳定运行     |
| 3   | FAILED    | 加载抛错             |
| 4   | DISPOSED  | 已卸载               |
| 5   | UNLOADING | 卸载中               |

```
              依赖满足                 加载完成
  PENDING ──────────────▶ LOADING ──────────────▶ ACTIVE
     ▲                       │                        │
     │ 依赖丢失                │ 抛错                    │ dispose()
     └───────────────────────┘  ▼                     ▼
                              FAILED             UNLOADING ─▶ DISPOSED
```

> ⚠️ **`const enum` 没有运行时对象**，不能用 `FiberState[fiber.state]` 反向取名字（TS2476）。要打印状态名请手动维护映射数组：
>
> ```typescript
> const STATE_NAMES = [
>   "PENDING",
>   "LOADING",
>   "ACTIVE",
>   "FAILED",
>   "DISPOSED",
>   "UNLOADING",
> ] as const;
> ```

- **生命周期方法**：

| 方法                   | 作用                                                             | 源码               |
| ---------------------- | ---------------------------------------------------------------- | ------------------ |
| `fiber.await()`        | 循环等待进行中的 `inertia`，直到状态收敛稳定；失败则抛 `_error`  | `fiber.ts:606-612` |
| `fiber.update(config)` | 校验新配置 → 走 `internal/update` waterfall → 写入并 `restart()` | `fiber.ts:625-634` |
| `fiber.restart()`      | 强制重启：先卸载（INACTIVE）再重新加载                           | `fiber.ts:615-621` |
| `fiber.dispose()`      | 卸载插件、清理副作用、从注册表移除                               | `fiber.ts:243-271` |
| `fiber.getEffects()`   | 返回名下副作用的元信息（label + 子树）                           | `fiber.ts:441-445` |

> ⚠️ **状态机异步收敛**：`await fiber` 返回时状态可能还停在 LOADING，通常需再让出一个微任务（`await Promise.resolve()`）或直接用 `await fiber.await()` 才能看到 ACTIVE。

- **对应示例**：`example-lifecycle.ts`。

---

## 4. 事件总线（emit / parallel / serial / bail / waterfall）

五种分发模式一览（均声明在 `Context` 上，`events.ts:27-84`）：

| 方法        | 同步/异步 | 返回值          | 语义                                 |
| ----------- | --------- | --------------- | ------------------------------------ |
| `emit`      | 同步      | `void`          | 依次触发所有监听，忽略返回值（广播） |
| `parallel`  | 异步      | `Promise<void>` | 并发触发、等待全部完成               |
| `serial`    | 异步      | `Promise<结果>` | 串行 await，命中即短路               |
| `bail`      | 同步      | 结果            | serial 的同步版                      |
| `waterfall` | 同步      | 结果            | 洋葱式中间件，靠 `next()` 逐层深入   |

### emit / on / once

- **最小代码**：

```typescript
const off = ctx.on("ping", (n) => console.log(n)); // 返回注销函数
ctx.once("boot", () => {}); // 只触发一次，触发后自动注销
ctx.emit("ping", 42);
off(); // 手动注销
```

- **关键机制**：`on(name, listener, options?)`（`events.ts:263-286`）。⚠️ **第二个 options 参数若不是对象会被当作 `{ prepend: options }`**——即传 `true` 表示「插到监听队列最前」。
- **对应示例**：`example-events.ts`（①②）。

### parallel

- **最小代码**：

```typescript
await ctx.parallel("load"); // 并发跑所有监听并等待
```

- **关键机制**：用 `Promise.allSettled` 并发执行，若有多个监听抛错，**聚合成一个 `AggregateError` 抛出**（`events.ts:181-190`）。
- **对应示例**：`example-events.ts`（③）。

### serial / bail

- **最小代码**：

```typescript
const result = await ctx.serial("find"); // 异步串行
const err = ctx.bail("check", -1); // 同步串行
```

- **关键机制**：**「命中」判定 = `isBailed`**（`events.ts:7-9`）：返回值**不是** `null` / `false` / `undefined` 即算命中，立即返回该值、不再执行后续监听。
- **对应示例**：`example-events.ts`（④⑤）。

### waterfall

- **最小代码**：

```typescript
ctx.on("request", (payload, next) => {
  const result = next(); // 调用 next 才进入下一层；不调则短路
  return result;
});
const out = ctx.waterfall("request", "hello", () => "RESPONSE");
//                                              ^ 最内核 inner
```

- **关键机制**（`events.ts:217-233`）：最后一个位置参数被 `pop` 出来当 **`inner`（最内核）**；每个监听收到 `[...args, next]`，`next()` 推进到下一层，所有监听放行后执行 `inner()`。⚠️ **同一层 `next()` 不能调用两次**，否则抛 `next() called multiple times`。
- **对应示例**：`example-events.ts`（⑥）。

---

## 5. 服务隔离与配置注入（isolate / intercept）

### ctx.isolate(name)

- **定位**：让**同名服务**在不同上下文里**互不可见**（各自独立实例）。
- **最小代码**：

```typescript
const ctxA = root.isolate("store");
const ctxB = root.isolate("store");
new Store(ctxA).tag = "A";
new Store(ctxB).tag = "B";
ctxA.store?.tag; // 'A'
ctxB.store?.tag; // 'B'（两者互不干扰）
```

- **关键机制**（`context.ts:168-172`）：为该服务名分配一个**全新的 isolate 符号** `Symbol(name)`，返回派生 ctx，使该服务的解析域与外层隔离。
- **对应示例**：`example-isolate-intercept.ts`。

### ctx.intercept(name, config)

- **定位**：同一个服务实例，让不同调用方（use-site）读到**不同配置**。
- **最小代码**：

```typescript
const ctxCn = root.intercept("greeter", { greeting: "你好" });
const ctxJp = ctxCn.intercept("greeter", { greeting: "こんにちは" });
ctxCn.greeter.hello("世界"); // 你好, 世界!
ctxJp.greeter.hello("世界"); // こんにちは, 世界!
```

- **关键机制**（`context.ts:175-185`）：在派生 ctx 的 `[symbols.intercept]` 原型链上挂 `{ [name]: config }`，服务在解析配置时（`Service[symbols.resolveConfig]`）按调用方上下文读取，实现「同实例、按 use-site 取不同配置」。
- **对应示例**：`example-isolate-intercept.ts`。

---

## 6. 服务声明进阶（provide / accessor / mixin）

这三个都挂在 `ReflectService` 上并混入 `ctx`（`reflect.ts:201`），用于**不继承 Service 基类**也能扩展 `ctx`。

### ctx.provide(name, value?, check?)

- **定位**：直接声明并提供一个服务。
- **最小代码**：

```typescript
ctx.provide("clock", { now: () => Date.now() });
ctx.clock.now();
```

- **关键机制**（`reflect.ts:245-285`）：声明 `service` 类型属性、在 `ctx.root` 分配稳定 isolate 符号、写入 store；返回 effect disposer，卸载时移除服务。⚠️ **同一 isolate 内重复 provide 同名服务会抛「has been registered」**。
- **对应示例**：`example-plugin-forms.ts`。

### ctx.accessor(name, options)

- **定位**：声明一个「虚拟属性」，读写走自定义 `get`/`set`。
- **最小代码**：

```typescript
let _v = "1.0.0";
ctx.accessor("version", {
  get: () => _v,
  set: (val) => {
    _v = val;
    return true;
  },
});
ctx.version = "2.0.0";
```

- **关键机制**（`reflect.ts:324-337`）：声明 `accessor` 类型属性，读写代理到 `get`/`set`；返回 disposer 删除该属性。
- **对应示例**：`example-plugin-forms.ts`。

### ctx.mixin(source, mixins)

- **定位**：把某个服务上的方法**混入到 ctx**，可直接 `ctx.xxx()` 调用。
- **最小代码**：

```typescript
// 数组 = 同名混入；对象 = 重命名映射
ctx.mixin("config", { read: "readConfig" });
ctx.readConfig("env"); // = ctx.config.read('env')，函数成员会自动 bind
```

- **关键机制**（`reflect.ts:340-373`）：把 `source` 服务的成员以 accessor 形式暴露到 ctx；`mixins` 为 `string[]`（同名）或 `Dict<string>`（重命名）。⚠️ **mixin 内部会读取 `ctx.<source>`，需先 `ctx.inject([source], ...)` 确保依赖就绪**，否则被「without inject」拦截。
- **对应示例**：`example-plugin-forms.ts`。

---

## 7. 插件三形态与注册表（plugin / registry）

### 三种插件形态

- **最小代码**：

```typescript
// (a) 函数插件
function funcPlugin(ctx: Context, config: { tag: string }) {}
ctx.plugin(funcPlugin, { tag: "F" });

// (b) 类插件
class ClassPlugin {
  constructor(ctx: Context) {}
}
ctx.plugin(ClassPlugin);

// (c) 对象插件（带 apply）
ctx.plugin({ name: "obj", apply(ctx) {} });
```

- **关键机制**（`registry.ts:208-214` + `isApplicable` `registry.ts:8-12`）：`resolve` 判定——`typeof === 'function'` 归为函数/类（执行时再用 `isConstructor` 区分要不要 `new`，`fiber.ts:219`）；对象则取 `plugin.apply`。都不匹配则抛「invalid plugin」。
- **对应示例**：`example-plugin-forms.ts`。

### ctx.registry（注册表查询）

- **最小代码**：

```typescript
ctx.registry.size; // 已注册插件种类数
ctx.registry.has(funcPlugin); // 是否注册
const runtime = ctx.registry.get(funcPlugin);
runtime?.fibers.length; // 该插件的实例（fiber）数
ctx.registry.keys(); // 所有插件 key（可迭代）
ctx.registry.delete(funcPlugin); // 移除并卸载其所有 fiber
```

- **关键机制**（`registry.ts:198-255`）：`get(plugin)` 返回 `Plugin.Runtime`，其 `fibers` 字段是 **`DisposableList`（可迭代，非普通数组）**，可 `for...of` 或读 `.length`。`keys()`/`values()`/`entries()` 均代理内部 `Map`。
- ⚠️ **`keys()` 返回的是迭代器**，用 `Array.from(ctx.registry.keys(), fn => fn.name)` 而非 `[...].map()`（避免 `target` 较低时的 TS2802 迭代告警）。
- **对应示例**：`example-lifecycle.ts`。

### plugin.Config（配置校验与规范化）

- **定位**：插件可选声明一个 schema（`StandardSchemaV1`，如 `schemastery`），加载时自动**校验并规范化** config。
- **最小代码**：

```typescript
import z from "schemastery";

const server = {
  Config: z.object({
    host: z.string(),
    port: z.number().default(3000), // 缺省时自动补 3000
  }),
  apply(ctx, config) {
    /* config 已被规范化 */
  },
};
ctx.plugin(server, { host: "localhost" }); // apply 里读到 port === 3000
```

- **关键机制**：
  - `plugin.Config` 存到 **runtime** 上（`registry.ts:306`），加载时由 `resolveConfig(runtime, config)`（`fiber.ts:62-74`）校验。**未声明 Config 时 `if (!runtime.Config) return config` 原样透传，永不校验**。
  - ⚠️ **`Config`(schema) 一份，config(数据) 各一份**：runtime 按 callback 复用共享同一 `Config`，但每次 `plugin()` 的 config 数据存在**各自的 Fiber** 上（`fiber.ts:246`），互不干扰。
  - ⚠️ **校验错误不是同步抛出**：它发生在 fiber 的 effect 回调里，被存进 `_error`，必须 `await fiber.await()` 才会 re-throw（否则静默失败，fiber 停在 FAILED）。
- **对应示例**：`example-plugin-config.ts`。

> 💡 **「同一插件、不同场景需要不同必填规则」怎么办？**（runtime 复用的 key 是 callback 引用，非插件对象）
>
> - **配置驱动的差异**（加载时已知）→ **工厂函数**返回带不同 Config 的新插件对象（新 callback → 独立 runtime，强类型 + schema 自动校验）。
> - **运行时上下文驱动的差异**（依赖某服务是否存在等）→ schema 层统一放宽为可选，把场景化校验下沉到 **apply 内**手动处理（schema 是静态声明，管不到"当前是哪个场景"）。

---

## 附：常见「坑」速查

| 现象                                | 原因                              | 解法                                                    |
| ----------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `await fiber` 后状态还是 LOADING    | 状态机异步收敛                    | 用 `await fiber.await()` 或补 `await Promise.resolve()` |
| `FiberState[state]` 报 TS2476       | `const enum` 无运行时对象         | 手动维护 `STATE_NAMES` 数组                             |
| `[...registry.keys()]` 报 TS2802    | 迭代器展开需较高 `target`         | 改用 `Array.from(iter, fn)`                             |
| mixin/读服务报「without inject」    | 未声明依赖                        | 先 `ctx.inject([name], ...)`                            |
| 多示例声明同名 `database` 报 TS2717 | `declare module` 同名属性类型冲突 | 各示例用不同服务名，或分开编译                          |
| `provide` 报「has been registered」 | 同 isolate 内重复注册             | 换服务名，或用已有服务                                  |
| `ctx.logger` 没有控制台输出         | 默认 exporter 只写内存缓冲        | 示例里直接用 `console.log`                              |
| 传了非法 config 却不报错            | 校验错误存入 `_error`，非同步抛出 | `await fiber.await()` 触发 re-throw                     |
