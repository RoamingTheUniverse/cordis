import { Dict } from 'cosmokit'
import { EventsService } from './events'
import { LoggerService } from './logger'
import { ReflectService } from './reflect'
import { InjectKey, RegistryService } from './registry'
import { getTraceable, symbols } from './utils'
import { Fiber } from './fiber'

/**
 * Context 接口：声明一个 ctx 实例上可访问的属性与内置服务。
 *
 * 该接口只是「起点」，各个子模块会通过 `declare module './context'`
 * 对它做增量扩展（如 fiber.ts 注入 `fiber` / `effect`，reflect.ts 注入
 * `get` / `set` / `provide` 等），从而实现「服务即属性」的插件化架构。
 */
export interface Context {
  /** 服务隔离表：服务名 -> 唯一 symbol，用于区分同名服务的不同「隔离域」 */
  [symbols.isolate]: Dict<symbol>
  /** 拦截配置表：服务名 -> config，供服务在被消费时读取上层注入的配置 */
  [symbols.intercept]: Dict
  /** @experimental 指向根 context（即被 Proxy 包裹后的自身） */
  root: this
  /** 可选的基础 URL，供解析相对资源时使用 */
  baseUrl?: string | undefined
  /** 事件总线服务 */
  events: EventsService
  /** 日志服务 */
  logger: LoggerService
  /** 反射服务：负责服务的 get/set/provide 及属性代理逻辑 */
  reflect: ReflectService
  /** 注册表服务：负责插件的注册与生命周期管理 */
  registry: RegistryService
}

export class Context {
  // 将内部使用的 symbol 暴露为静态属性，方便外部以 `Context.effect` 等方式引用。
  static readonly effect: unique symbol = symbols.effect
  static readonly filter: unique symbol = symbols.filter
  static readonly isolate: unique symbol = symbols.isolate
  static readonly intercept: unique symbol = symbols.intercept

  /**
   * 我说一下我的理解：Context 类有 is 方法，调用 Context.is 方法时通过判断传入的实例中是否有某个具体的 key
   * 且对应的值为 true 才认为是 Context 实例， 而这个具体的 key 可以是普通的字符串，比如 aaa，
   * 但作者这里用的 Context.is，Context.is 首先是个函数且定义了 Symbol.toPrimitive，因此当
   * Context.is 作为 key 被使用时，会调用  Symbol.toPrimitive 对应的方法，即返回了 Symbol.for('cordis.is')，
   * 所以 Context.is 方法里 “!!value?.[Context.is as any]” 相当于 “!!value?.[Symbol.for('cordis.is')]”，
   * 即变成判断 Context 的实例中是否有 Symbol.for('cordis.is')] 这个 key 且值为 true。
   * 而在第 93 行，Context.is 同样是作为 key 被使用，即等价于 Context.prototype[Symbol.for('cordis.is')]=true，
   * 因此在 !!value?.[Symbol.for('cordis.is')] 中，自身未直接定义 Symbol.for('cordis.is')，会自动到原型链上去取，便取到了 true
   */

  /**
   * 判断任意值是否为 Context 实例。
   *
   * 【一物两用】`Context.is` 这个标识符同时扮演两个角色：
   *   1. 作为「函数」：本方法，一个带类型谓词 `value is Context` 的类型守卫；
   *   2. 作为「属性键」：借助下方 static 块里定义的 `Symbol.toPrimitive`，
   *      当它被当作 key 使用时会退化成全局符号 `Symbol.for('cordis.is')`。
   *
   * 【为什么用函数而非直接定义一个 symbol 属性？】
   *   - 类型守卫 `value is Context` 只能由函数承载，能在 if 分支里把入参收窄为 Context；
   *   - `Context.is(x)` 是符合直觉的公开 API（类比 `Array.isArray`），封装了内部实现；
   *   - 借 `Symbol.toPrimitive` 让这个函数「兼职」当标记键，就无需再额外声明一个 symbol，
   *     内外共用同一个 `Context.is`。
   *
   * 【为什么不用 `instanceof`？】
   *   改为检查原型链上是否带有 `Symbol.for('cordis.is')` 标记（见下方 static 块）。
   *   因为 `Symbol.for` 走全局符号注册表，即使运行时存在多个 cordis 副本（不同 realm、
   *   或依赖被重复打包），各副本取到的都是同一个 symbol，故能跨副本正确识别 Context；
   *   而 `instanceof` 认的是「同一个类引用」，跨副本必然失败。
   *
   * 因此 `!!value?.[Context.is as any]` 等价于 `!!value?.[Symbol.for('cordis.is')]`：
   * 判断 value 身上（含原型链）是否带有该符号键且值为真；`?.` 兜住 null/undefined。
   */
  static is(value: any): value is Context {
    return !!value?.[Context.is as any]
  }

  static {
    // 第 1 步：给函数 `Context.is` 定义 Symbol.toPrimitive。
    // 当一个值被用作属性键时，JS 内部走 ToPropertyKey -> ToPrimitive；由于这里定义了
    // Symbol.toPrimitive，转换结果就是 `Symbol.for('cordis.is')`。且 ToPropertyKey 对
    // 「返回值为 symbol」的情况会原样保留该 symbol 当键（不会再 ToString 成字符串），
    // 这保证了「写标记」与「读标记」用的是同一个全局符号。
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    // 第 2 步：把标记打在「原型」而非「静态属性」或「每个实例」上。
    // 本行等价于 `Context.prototype[Symbol.for('cordis.is')] = true`。
    // - 为何是原型：实例的原型链是 `ctx -> Context.prototype -> ...`，并不经过 Context
    //   类本身，所以标记必须挂在 Context.prototype 上，实例才能沿原型链读到 true；
    //   挂成静态属性（Context[key]）实例根本读不到。
    // - 相比「每个实例各挂一份」：挂原型只存一份、所有实例共享，省内存也不污染自有属性；
    //   且 extend() 用 Object.create 派生的子 context 也能自动沿原型链继承，无需额外处理。
    Context.prototype[Context.is as any] = true
  }

  constructor() {
    // 初始化两张「无原型」的空表，避免受 Object.prototype 污染。
    this[symbols.isolate] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    // 用 ReflectService.handler 代理自身，实现「访问 ctx.foo 即解析服务 foo」的能力。
    const self = new Proxy<this>(this, ReflectService.handler)
    this.root = self
    this.baseUrl = undefined
    // 创建根 fiber（runtime 为 null 的特殊 fiber，代表根节点，直接处于 ACTIVE 状态）。
    this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
    // 依次实例化内置服务，统一传入被代理的 `self` 而非原始 this，保证服务追踪链路正确。
    this.reflect = new ReflectService(self)
    this.registry = new RegistryService(self)
    this.events = new EventsService(self)
    this.logger = new LoggerService(self)
    // 清空构造期间产生的 disposables：根 fiber 不应因初始化而残留可清理副作用。
    this.fiber._disposables.clear()
    // 返回代理对象，使外部拿到的始终是被 Proxy 包裹的 context。
    return self
  }

  // Node.js 中 `console.log(ctx)` 的自定义展示，输出形如 `Context <root>`。
  // util.inspect（console.log 底层）会优先调用对象上的该 symbol 方法，用其返回值作为展示结果。
  // 这里定制它，是为了避免把被 Proxy 包裹、挂满服务的 Context 递归铺开打印（刷屏且可能触发意外 getter）；
  // 用 Symbol.for 全局符号而非 import 'util'，可让本行在非 Node 环境也不报错（只是不生效）。
  // this.fiber.name 会沿 fiber 链向上取最近的插件名，根节点则为 'root'。
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.fiber.name}>`
  }

  /**
   * 派生一个继承当前 context 的新 context，并在其上附加 `meta` 中的属性。
   *
   * 新 context 以原型链方式继承当前 context，因此上层的变更可向下透传，
   * 而新 context 自身的修改不会反向影响上层——这是 cordis 上下文分层的基础。
   */
  extend(meta = {}): this {
    // 取出当前 context 上可能携带的 shadow（区分服务「定义点」与「使用点」的信息）。
    const shadow = Reflect.getOwnPropertyDescriptor(
      this,
      symbols.shadow,
    )?.value
    // 以可追踪的原型对象为原型创建新对象，保证服务解析仍走 Proxy 逻辑。
    const self = Object.create(getTraceable(this, this))
    // 逐个复制 meta 的属性描述符（保留 getter/setter、可枚举性等完整元信息）。
    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(
        self,
        prop,
        Reflect.getOwnPropertyDescriptor(meta, prop)!,
      )
    }
    // 当前 context 不携带 shadow，直接返回派生结果。
    if (!shadow) return self
    // 否则把 shadow 信息延续到新 context 上，供后续服务追踪使用。
    //
    // 【为什么要「再包一层」而不是直接 self[symbols.shadow] = shadow？】
    // 双站点追踪（见 utils.ts 的 createTraceable）靠「一个对象的自有 shadow 属性 = 定义点
    // (def site)，它的原型 = 使用点 (use site)」这层原型关系来区分二者：
    //   const defSite = ctx[symbols.shadow] ?? ctx
    //   const useSite = ctx[symbols.shadow] ? Object.getPrototypeOf(ctx) : ctx
    // 因此带 shadow 的那一层，其「原型」必须正好是 use site。这里以 self 为原型再建一个
    // 对象、把 shadow 挂在最外层，恰好构造出「自有 shadow = defSite、原型 = self（use site）」
    // 的关系；若直接挂在 self 上，self 的原型是「可追踪的当前 ctx」，会让 use site 错位。
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
  }

  /**
   * 创建一个服务隔离域：为指定服务名分配一个新的 symbol，
   * 使得派生 context 中对该服务的解析与外层隔离开来（互不可见）。
   */
  isolate(name: string, label?: symbol) {
    const shadow = Object.create(this[symbols.isolate])
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  // 为指定服务设置拦截配置，返回携带该配置的派生 context。
  intercept<K extends InjectKey>(
    name: K,
    config: Context[K] extends { [symbols.config]: infer T } ? T : never,
  ): this

  intercept(name: string, config: any): this
  intercept(name: string, config: any) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}
