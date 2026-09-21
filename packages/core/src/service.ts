import { defineProperty } from 'cosmokit'
import { Context } from './context'
import { createCallable, joinPrototype, symbols, Tracker } from './utils'

/**
 * Service：编写「可注入服务」的抽象基类。
 *
 * 继承它并在构造时传入 ctx 与服务名，实例就会自动通过 `ctx.reflect.provide`
 * 注册到上下文中，之后即可用 `ctx.<name>` 访问。泛型参数 `T` 表示该服务的
 * 配置类型（借由 `[symbols.config]` 声明），供 `InjectKey` 等类型推导使用。
 */
export abstract class Service<out T = never> {
  // 把内部 symbol 暴露为静态属性，方便子类以 `Service.init` 等语义化方式引用。
  // init: 异步初始化钩子；check: 依赖可用性校验；config: 配置类型标记；
  // invoke: 使服务实例「可被调用」；extend: 派生服务实例；
  // tracker: Proxy 追踪元信息；resolveConfig: 合并 intercept 配置。
  static readonly init: unique symbol = symbols.init
  static readonly check: unique symbol = symbols.check
  static readonly config: unique symbol = symbols.config
  static readonly invoke: unique symbol = symbols.invoke
  static readonly extend: unique symbol = symbols.extend
  static readonly tracker: unique symbol = symbols.tracker
  static readonly resolveConfig: unique symbol = symbols.resolveConfig

  // 仅用于类型层面标记配置类型 T，运行时并不存在该字段。
  declare [symbols.config]: T

  public name!: string

  constructor(
    protected ctx: Context,
    name: string,
  ) {
    // 未显式传名时，回退到子类静态属性 `provide` 声明的服务名。
    name ??= this.constructor['provide'] as string

    let self = this
    // 追踪信息：associate 让 `ctx.foo.bar` 能关联到 `foo.bar` 服务；property 指明
    // 「使用点上下文」挂在实例的哪个属性上（这里是 `ctx`）。
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    // 若服务定义了 `[symbols.invoke]`，则把实例包装成「可调用对象」（既是对象又能当函数调用）。
    if (self[symbols.invoke]) {
      self = createCallable(
        name,
        joinPrototype(Object.getPrototypeOf(this), Function.prototype),
        tracker,
      )
    }
    self.ctx = ctx
    self.name = name
    defineProperty(self, symbols.tracker, tracker)

    // 向反射服务注册自身，check 为可选的「依赖是否就绪」校验函数。
    self.ctx.reflect.provide(name, self, this[symbols.check])
    return self
  }

  // 事件过滤器：仅当目标 ctx 与本服务处于同一隔离域时，才响应相关事件。
  protected [symbols.filter](ctx: Context) {
    return (
      ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
    )
  }

  // 派生一个继承当前服务的新实例，并覆盖/附加 props（用于 ctx 切换等场景）。
  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      // 可调用服务需重新包一层 callable，保持可调用特性。
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  // 解析最终配置：沿 intercept 原型链自底向上收集各层配置，再与 base/head 合并。
  [symbols.resolveConfig](base?: T, head?: T): T {
    let intercept = this.ctx[Context.intercept]
    const configs: any[] = []
    // 遍历原型链，把每一层显式声明的拦截配置按「由外到内」顺序收集起来。
    while (this.name in intercept) {
      if (Object.hasOwn(intercept, this.name)) {
        configs.unshift(intercept[this.name])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    // base 优先级最低，置于最前；head 优先级最高，置于最后。
    if (base) configs.unshift(base)
    if (head) configs.push(head)
    // 若配置 schema 提供了自定义 merge，则用它合并；否则浅合并。
    if (this['Config']?.merge) {
      return this['Config'].merge(...configs)
    } else {
      return Object.assign({}, ...configs)
    }
  }

  // 自定义 instanceof 行为：由于服务实例常被 Proxy 包裹，无法用默认原型链判断，
  // 故手动沿构造函数的原型链逐层比对（并跳过 Proxy 层）。
  static [Symbol.hasInstance](instance: any) {
    if (!instance) return false
    let constructor = instance.constructor
    while (constructor) {
      // constructor 可能是一个 proxy，取其 prototype.constructor 还原真实构造函数
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor &&= Object.getPrototypeOf(constructor)
    }
    return false
  }
}
