import { defineProperty, Dict } from 'cosmokit'
import { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context'
import { Fiber } from './fiber'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils'

// 判断是否为「对象式插件」——即带有 apply 方法的普通对象（区别于函数/类插件）。
function isApplicable(object: Plugin) {
  return (
    object && typeof object === 'object' && typeof object.apply === 'function'
  )
}

// 依赖声明：可以是「服务名数组」，也可以是「服务名 -> 拦截配置」的映射对象。
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

// 可注入的服务名集合：从 Context 上筛选出那些「带有 config 声明」的服务键。
export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.config]: any }
  ? K
  : never]: any;
}

// @Inject() 装饰器：用于在类或类方法上声明依赖注入。
// - 作用于类：把依赖挂到类的 inject 原型链上（沿原型合并，checkProto 标记用于 resolve 时递归）。
// - 作用于方法：把依赖记录到元数据，并在实例初始化时通过 ctx.inject 包裹方法调用。
export function Inject<K extends InjectKey>(
  name: K,
  config?: Context[K] extends { [symbols.config]: infer T } ? T : never,
) {
  return function (
    value: any,
    decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>,
  ) {
    if (decorator.kind === 'class') {
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(
          value,
          'inject',
          Object.create(Object.getPrototypeOf(value).inject ?? null),
        )
        defineProperty(value.inject, symbols.checkProto, true)
      }
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      const inject = ((value[symbols.metadata] ??= {}).inject
        ??= Object.create(null))
      inject[name] = config
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property;
        (this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            return value.call(
              property ? withProps(this, { [property]: ctx }) : this,
            )
          })
        })
      })
    } else {
      throw new Error('@Inject() can only be used on class or class methods')
    }
  }
}

export namespace Inject {
  // 把各种形态的 inject 声明归一化为「服务名 -> 配置」的字典：
  // - 数组：值统一为 null（无额外配置）
  // - 带 checkProto 标记的对象：先递归合并原型链上的声明，再覆盖自身键
  // - 普通对象：直接展开键值
  export function resolve(
    inject: Inject | null | undefined,
    result: Dict = Object.create(null),
  ) {
    if (!inject) return result
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = null
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      Object.assign(result, resolve(Object.getPrototypeOf(inject)))
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    } else {
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    }
    return result
  }
}

// 插件的三种形态：函数插件、类插件（构造函数）、对象插件（含 apply 方法）。
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

export namespace Plugin {
  // 所有插件共有的可选元信息。
  export interface Base<T = any> {
    // 插件名（用于日志、调试）
    name?: string
    // 配置的校验/转换 schema
    Config?: StandardSchemaV1<any, T>
    // 依赖声明
    inject?: Inject
    // 该插件会提供（provide）的服务名
    provide?: string | string[]
    // 拦截配置
    intercept?: Dict<boolean>
  }

  // 配置转换：把外部输入 S 转换为内部使用的 T。
  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  // 函数式插件：直接以 (ctx, config) 调用。
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  // 类式插件：以 new (ctx, config) 实例化。
  export interface Constructor<T = any> extends Base<T> {
    new(ctx: Context, config: T): any
  }

  // 对象式插件：通过 apply(ctx, config) 生效。
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }

  // 运行时（Runtime）：同一个插件回调对应一份 runtime，聚合其所有 fiber 实例。
  export interface Runtime {
    name?: string
    // 该 runtime 下所有的 fiber（同一插件可被多次加载）
    fibers: DisposableList<Fiber>
    // 归一化后的插件回调
    callback: globalThis.Function
    Config?: StandardSchemaV1
  }
}

// 根据配置类型 T 推导 plugin() 的可选参数：允许 undefined 时 config 可省略。
type Spread<T> = undefined extends T ? [config?: T] : [config: T]

// 从插件类型 P 中提取「除 ctx 之外的参数列表」（兼容函数/类/对象三种形态）。
type GetPluginParameters<P> = P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

// 从插件类型 P 中提取「配置类型」：Transform 取其输入 S，否则取参数列表首项。
type GetPluginConfig<P> =
  P extends Plugin.Transform<infer S, any> ? S : GetPluginParameters<P>[0]

// 通过模块合并，把 inject / plugin 方法挂到 Context 上（返回可 await 的 Fiber）。
declare module './context' {
  export interface Context {
    inject(
      deps: Inject,
      callback: Plugin.Function<void>,
    ): Fiber & PromiseLike<Fiber>
    plugin<P extends Plugin>(
      plugin: P,
      ...args: Spread<GetPluginConfig<P>>
    ): Fiber & PromiseLike<Fiber>
  }
}

/**
 * RegistryService：插件注册中心。
 *
 * 以「插件回调函数」为 key 维护一张 runtime 表：同一个插件被多次加载时共享一份
 * runtime，但各自拥有独立的 Fiber。负责插件的注册（plugin）、查询（get/has）、
 * 卸载（delete）以及提供 counter 等自增序号。
 */
export class RegistryService {
  // fiber 的自增计数器（每次读取 counter 递增）
  private _counter = 0
  // 插件回调 -> runtime 的映射表
  private _internal = new Map<Function, Plugin.Runtime>()

  constructor(public ctx: Context) {
    // 标记 tracker，使该服务在 ctx 上被追踪时以 ctx 作为 use site，且不生成 shadow。
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })
  }

  // 返回下一个自增序号（供 fiber 分配唯一 uid）。
  get counter() {
    return ++this._counter
  }

  // 已注册的 runtime 数量。
  get size() {
    return this._internal.size
  }

  // 把任意形态的插件归一化为「回调函数」作为 map 的 key；无效插件返回 undefined。
  // 注意：这里只负责「取出唯一的 callback 用于查/存 runtime」，并不关心它是普通函数还是构造函数——
  //       「函数式调用」还是「new 实例化」的区分被延后到 Fiber 执行阶段（见 fiber.ts 的 isConstructor 判断）。
  resolve(plugin: Plugin): Function | undefined {
    // plugin.apply may throw：某些对象的 apply 可能是会抛异常的 getter，故整体包一层兜底。
    try {
      // 函数式插件与类式插件都命中此分支：在 JS 中 class 本质也是 function（typeof === 'function'），
      // 因此二者共用一个 callback（即插件自身），仅在真正执行时才用 isConstructor 区分调用方式。
      if (typeof plugin === 'function') return plugin
      // 对象式插件：以其 apply 方法作为 callback。
      if (isApplicable(plugin)) return plugin.apply
    } catch { }
  }

  // 查询插件对应的 runtime（未注册返回 undefined）。
  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  // 判断插件是否已注册。
  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  // 卸载插件：从表中移除 runtime，并逐个 dispose 其下所有 fiber。
  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of runtime.fibers) {
      fiber.dispose()
    }
    return runtime
  }

  // 以下 keys/values/entries/forEach 直接代理到内部 map，方便遍历所有 runtime。
  keys() {
    return this._internal.keys()
  }

  values() {
    return this._internal.values()
  }

  entries() {
    return this._internal.entries()
  }

  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  // 语法糖：把「依赖 + 回调」包装成一个匿名对象插件后加载。
  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  // 加载插件：核心注册入口。
  // 1. 归一化并校验插件；确保当前上下文处于激活态。
  // 2. 复用或新建 runtime。
  // 3. 创建 Fiber，并返回一个「可 await」的包装对象（await 时等待加载完成）。
  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    // check if it's a valid plugin
    // 第一步：归一化并校验插件形态。resolve 会把函数/类/对象插件统一成 callback；
    // 若拿不到 callback，说明传入的根本不是合法插件，直接 fail fast 抛错。
    const callback = this.resolve(plugin)
    if (!callback) {
      throw new Error(
        'invalid plugin, expect function or object with an "apply" method, received '
        + typeof plugin,
      )
    }
    // 第二步：确保当前上下文所属的 fiber 仍然存活（uid 未被置空）。
    // 加载插件是「制造副作用」的操作（会新建 Fiber、注册 runtime 等），若在一个已被
    // dispose 的僵尸上下文上继续加载，会造成内存泄漏与幽灵副作用，故此处守卫、快速失败。
    // 注意顺序：先校验「插件是否合法」再校验「上下文是否存活」，让报错信息更精准。
    this.ctx.fiber.assertActive()

    // 第三步：以 callback 为 key 复用或新建 runtime——同一插件多次加载时共享同一份 runtime。
    let runtime = this._internal.get(callback)
    if (!runtime) {
      let name = plugin.name
      // 匿名对象插件的 name 可能被意外推断为 "apply"，此处清空避免误用。
      // 成因：ctx.inject 语法糖会构造 { apply: callback, name: callback.name }，
      // 而 JS 中「方法简写」定义的函数（如 { apply(){} }.apply）其 .name 会取属性名，
      // 即字符串 "apply"。这只是自动推断的副产品而非真实插件名，若不清空会污染
      // runtime.name / fiber.name，在日志里显示成毫无意义的 "apply"。
      // 注意：这是启发式判断——极端情况下把插件真的命名为 "apply" 也会被清掉，但可忽略。
      if (name === 'apply') name = undefined
      runtime = {
        name,
        callback,
        fibers: new DisposableList(),
        // 插件可选声明的配置 schema（StandardSchemaV1）：存入 runtime 后，fiber 加载时
        // 由 resolveConfig 用它校验/规范化 config；插件未声明 Config 时此处为 undefined，
        // 表示「不校验配置」，config 将被原样透传（见 fiber.ts 的 resolveConfig）。
        Config: plugin.Config,
      }
      this._internal.set(callback, runtime)
    }

    // 第四步：为本次加载创建独立的 Fiber（同一 runtime 下各 fiber 相互隔离）。
    const fiber = new Fiber(
      this.ctx,
      config,
      Inject.resolve(plugin.inject),
      runtime,
      getOuterStack,
    )
    // 第五步：把 fiber 包装成「既是 Fiber 又是 thenable」的双模态返回值——
    // 既能同步访问（如立即 fiber.dispose()），也能 await 等待其加载就绪。
    //
    // 用 Object.create(fiber) 造一个原型指向 fiber 的「贴身替身」：wrapped 本身是空对象，
    // 但对它的任意属性访问（uid / dispose / await ...）都会顺原型链透传到真身 fiber，
    // 因此用起来与 fiber 完全一致。
    // 之所以套一层壳而非直接给 fiber 挂 then：fiber 是长期存活对象，若它自身变成 thenable，
    // 会在 Promise 链中被引擎误当作 Promise 递归解包，行为失控；套壳可让 then 只污染临时的 wrapped，
    // 保持真身 fiber 干净。
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    // 挂上 then 方法即成为 thenable：JS 里判断「一个值能否被 await」的唯一标准，
    // 就是看它有没有一个名为 then 的方法（即 thenable / PromiseLike 契约）——
    // await 一个 thenable 时，引擎并不要求它是真正的 Promise，只会去调用其 then 方法。
    // 因此这里手动挂 then，wrapped 就获得了「可被 await」的能力，
    // 内部转发给 fiber.await()——等待 fiber 收敛到稳定态后，加载成功则 resolve 出 fiber 自身、
    // 失败则 throw 错误（故可用 try/catch 捕获加载异常）。
    // 注意 await() resolve 的是原始 fiber（无 then），故递归解包会在此正确刹车，不会无限套娃。
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
