import { defineProperty } from 'cosmokit'
import type { Context, Service } from '.'

/**
 * DisposableList：可按插入逆序清理的「一次性对象」列表。
 *
 * 内部同时维护「序号 -> 值」的 Map 和「值 -> 序号」的 WeakMap：
 * - push 返回一个「就地删除」的清理函数；
 * - clear 返回逆序快照（用于按 LIFO 顺序销毁副作用）。
 * 泛型约束 WeakKey 保证值可作为 WeakMap 的键。
 */
export class DisposableList<T extends WeakKey> {
  // 自增序号，保证插入顺序可追溯
  private sn = 0
  // 序号 -> 值
  private map = new Map<number, T>()
  // 值 -> 序号（弱引用，避免阻止值被回收）
  private weak = new WeakMap<T, number>()

  get length() {
    return this.map.size
  }

  // 追加一个值，返回把它从列表中移除的清理函数。
  push(value: T) {
    const sn = ++this.sn
    this.map.set(sn, value)
    this.weak.set(value, sn)
    return () => this.map.delete(sn)
  }

  // 按值删除（利用 WeakMap 反查序号）。
  delete(value: T) {
    const sn = this.weak.get(value)
    if (!sn) return false
    return this.map.delete(sn)
  }

  // 清空并返回逆序快照，便于按 LIFO 顺序执行清理。
  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  // 支持 for...of 顺序遍历（正序）。
  [Symbol.iterator]() {
    return this.map.values()
  }

  // Node.js 中 console.log 时以数组形式展示内容。
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}

// Tracker：附加在服务/值上的追踪元信息，指导 traceable 代理的行为。
export interface Tracker {
  // 关联前缀：允许 ctx.foo.bar 解析到服务 `foo.bar`
  associate?: string
  // 用于反向定位「使用方 ctx」的属性名（如 Service 的 'ctx'）
  property?: string
  // 是否禁用 shadow（不改写方法的 this 上下文）
  noShadow?: boolean
}

// 全局共享的 Symbol 表：使用 Symbol.for 保证跨模块/跨副本一致。
export const symbols = {
  // internal symbols
  // 这些仅作内部临时标记使用，无需作为 Context/Service 的公开计算属性键，
  // 因此保持普通 `symbol` 类型即可，不必对齐 unique symbol。
  shadow: Symbol.for('cordis.shadow'),
  caller: Symbol.for('cordis.caller'),
  receiver: Symbol.for('cordis.receiver'),
  original: Symbol.for('cordis.original'),
  metadata: Symbol.for('cordis.metadata'),
  initHooks: Symbol.for('cordis.initHooks'),
  checkProto: Symbol.for('cordis.checkProto'),

  // context symbols
  // 断言为 `typeof Context.xxx`（而非 `as unique symbol`，后者不允许出现在断言位置）：
  // 借用 Context 上已声明的 `static readonly xxx: unique symbol` 拿到 unique symbol 类型，
  // 使这些 symbol 既能作为 Context 接口的计算属性键，又与 Context.xxx 是同一类型身份，
  // 从而 ctx[symbols.xxx] 与 ctx[Context.xxx] 完全等价。
  effect: Symbol.for('cordis.effect') as typeof Context.effect,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  // 同上：对齐 Service 上的 unique symbol，让 obj[symbols.xxx] 与 obj[Service.xxx] 互通。
  init: Symbol.for('cordis.init') as typeof Service.init,
  check: Symbol.for('cordis.check') as typeof Service.check,
  config: Symbol.for('cordis.config') as typeof Service.config,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  resolveConfig: Symbol.for(
    'cordis.resolveConfig',
  ) as typeof Service.resolveConfig,
}

// 预先获取 Generator / AsyncGenerator 的构造器，用于 isConstructor 判定。
const GeneratorFunction = function* () { }.constructor
const AsyncGeneratorFunction = async function* () { }.constructor

// 判断 func 是否为「可 new 的构造函数」：排除箭头函数、async 函数、生成器函数等。
export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  // we cannot use below check because `mock.fn()` is proxied
  // if (func.prototype.constructor !== func) return false
  if (func instanceof GeneratorFunction) return false
  // polyfilled AsyncGeneratorFunction === Function
  if (
    AsyncGeneratorFunction !== Function
    && func instanceof AsyncGeneratorFunction
  ) {
    return false
  }
  return true
}

// 把 proto1 的自有属性「拷贝合并」到以 proto2 为终点的新原型链上，
// 递归到 Object.prototype 为止（用于 Service 的原型拼接）。
export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  const result = Object.create(
    joinPrototype(Object.getPrototypeOf(proto1), proto2),
  )
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(
      result,
      key,
      Object.getOwnPropertyDescriptor(proto1, key)!,
    )
  }
  return result
}

// 判断是否为对象或函数（可用作代理目标 / 可挂载属性）。
export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

// 沿原型链查找某属性的属性描述符（含继承来的）。
export function getPropertyDescriptor(target: any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

/**
 * getTraceable：把一个值包装为「可追踪」代理（若其带有 tracker 元信息）。
 *
 * - 非对象：原样返回；
 * - 若值本身是一个 shadow（自有 shadow 符号）：解包为其原型（真实值）；
 * - 若带 tracker：创建 traceable 代理以贯通 ctx 追踪链路；
 * - 否则原样返回。
 */
export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

// 以 props 覆盖 target 的读写：命中 props 的键走 props，其余透传给 target。
export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') {
        return Reflect.get(props, prop, receiver)
      }
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') {
        return Reflect.set(props, prop, value, receiver)
      }
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

// withProps 的便捷版：只覆盖单个（不可写）属性。
function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(
    target,
    Object.defineProperty(Object.create(null), prop, {
      value,
      writable: false,
    }),
  )
}

// 构造一个「带 shadow 的 receiver」：把服务方法运行时的 def site 绑定到 receiver 上。
// property 为空时（无 tracker.property）无需 shadow，直接返回原 receiver。
function createShadow(
  useSite: Context,
  target: any,
  property: string | undefined,
  receiver: any,
) {
  if (!property) return receiver
  const value = getPropertyDescriptor(target, property)?.value
  if (!value) return receiver
  const defSite = (value[symbols.shadow] as Context | undefined) ?? value
  return withProp(
    receiver,
    property,
    useSite.extend({ [symbols.shadow]: defSite }),
  )
}

// 包裹一个方法：当以「外层代理」为 this 调用时，替换成携带 shadow 的 this，
// 从而让方法内部访问服务时能正确区分 def site / use site；返回值再做一次 traceable。
function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

/**
 * createTraceable：核心的「双站点追踪」代理。
 *
 * `ctx` 可能是一个 shadow，即一对：
 * - def site（定义点）：访问代码的定义位置，决定服务解析（沿谁的 fiber 链找服务）；
 * - use site（使用点）：服务被消费的位置，决定 intercept / isolate / effect 归属。
 *
 * 该代理拦截 get/set/apply：
 * - 特殊符号（original/caller/property）直接返回目标/def site/use site；
 * - 支持 associate 前缀（让 ctx.foo.bar 等价于 ctx['foo.bar']）；
 * - 对返回的子对象/方法递归包裹，保证追踪链路贯通。
 */
function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  // 从 ctx 中解出 def site 与 use site。
  const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
  const useSite = ctx[symbols.shadow]
    ? (Object.getPrototypeOf(ctx) as Context)
    : ctx
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      // 内部符号：暴露原始值 / def site / use site。
      if (prop === symbols.original) return target
      if (prop === symbols.caller) return defSite
      if (prop === tracker.property) return useSite
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      // `ctx` rather than `useSite`, so that `ctx.foo.bar` and `ctx['foo.bar']` are
      // governed by the same def site
      if (
        tracker.associate
        && useSite.reflect.props[`${tracker.associate}.${prop}`]
      ) {
        return Reflect.get(
          ctx,
          `${tracker.associate}.${prop}`,
          withProp(ctx, symbols.receiver, receiver),
        )
      }
      let shadow: any, innerValue: any
      const desc = getPropertyDescriptor(target, prop)
      // 数据属性直接取 value；访问器属性则以带 shadow 的 receiver 触发其 getter。
      if (desc && 'value' in desc) {
        innerValue = desc.value
      } else {
        shadow = createShadow(useSite, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        // 子对象自带 tracker：递归包裹（以 useSite 为新的追踪起点）。
        return createTraceable(useSite, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        // 普通方法：包一层 shadow method 以修正调用时的 this。
        shadow ??= createShadow(useSite, target, tracker.property, receiver)
        return createShadowMethod(useSite, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      // 内部符号只读，禁止写入。
      if (prop === symbols.original) return false
      if (prop === symbols.caller) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      // associate 前缀的写入同样重定向到 ctx['foo.bar']。
      if (
        tracker.associate
        && useSite.reflect.props[`${tracker.associate}.${prop}`]
      ) {
        return Reflect.set(
          ctx,
          `${tracker.associate}.${prop}`,
          value,
          withProp(ctx, symbols.receiver, receiver),
        )
      }
      const shadow = createShadow(useSite, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      // 调用代理本身（可调用服务）：按需构造带 shadow 的 receiver 后执行。
      const receiver = tracker.noShadow
        ? proxy
        : createShadow(useSite, target, tracker.property, proxy)
      return applyTraceable(receiver, target, thisArg, args)
    },
  })
  return proxy
}

// 执行 traceable 目标：若定义了自定义 invoke 符号则走它（以 proxy 为 this），否则普通调用。
function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

// 创建一个「可调用对象」：本体是函数（调用时经 traceable 代理执行），原型指向 proto。
// 用于把服务实现为「既能当函数调用、又挂着方法」的可调用服务。
export function createCallable(name: string, proto: {}, tracker: Tracker) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return Reflect.apply(proxy, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

// 记录「内层错误」的堆栈信息，用于拼接长堆栈。
interface StackInfo {
  offset: number
  error: Error
}

// 把「外层调用栈」拼接到错误堆栈上，形成跨异步边界的长堆栈（long stack trace），
// 让报错能一路追溯到真正触发副作用的用户代码位置。
function handleError(
  info: StackInfo,
  reason: any,
  getOuterStack: () => string[],
): never {
  const innerLines = info.error.stack!.split('\n')

  // malformed error
  if (typeof reason?.stack !== 'string') {
    const outerError = new Error(reason)
    const lines = outerError.stack!.split('\n')
    lines.splice(1, Infinity, ...getOuterStack())
    outerError.stack = lines.join('\n')
    throw outerError
  }

  // long stack trace
  const lines: string[] = reason.stack.split('\n')
  // 以内层错误的定位帧为锚点，找到需要截断并接上外层栈的位置。
  let index = lines.indexOf(innerLines[2])
  if (index === -1) throw reason

  index -= info.offset
  // 跳过匿名帧，尽量贴近有意义的调用点。
  while (index > 0) {
    if (!lines[index - 1].endsWith(' (<anonymous>)')) break
    index -= 1
  }
  lines.splice(index, Infinity, ...getOuterStack())
  reason.stack = lines.join('\n')
  throw reason
}

// 包裹一次可能抛错的调用：无论同步抛出还是 Promise reject，都用 handleError 补全长堆栈。
export function composeError<T>(
  callback: (info: StackInfo) => T,
  getOuterStack = buildOuterStack(),
): T {
  const info: StackInfo = { offset: 1, error: new Error() }

  try {
    const result: any = callback(info)
    if (isObject(result) && 'then' in result) {
      return (result as any).then(undefined, (reason) =>
        handleError(info, reason, getOuterStack),
      ) as T
    } else {
      return result
    }
  } catch (reason: any) {
    handleError(info, reason, getOuterStack)
  }
}

// 在「当前调用点」抓取一份外层堆栈快照，返回一个惰性获取该堆栈行的函数。
// slice(3 + offset) 用于跳过本函数与内部包装帧，只保留真正的用户调用栈。
export function buildOuterStack(offset = 0) {
  const outerError = new Error()
  return () => outerError.stack!.split('\n').slice(3 + offset)
}
