import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { getTraceable, symbols, withProps } from './utils'
import { Fiber, FiberState } from './fiber'

// 通过模块合并，把服务的读写/声明方法直接挂到 Context 上（ctx.get/set/provide/accessor/mixin）。
declare module './context' {
  interface Context {
    get<K extends string & keyof this>(
      name: K,
      strict?: boolean,
    ): undefined | this[K]
    get(name: string, strict?: boolean): any
    set<K extends string & keyof this>(
      name: K,
      value: undefined | this[K],
    ): void
    set(name: string, value: any): void
    provide<K extends string & keyof this>(
      name: K,
      value: undefined | this[K],
    ): () => void
    provide(name: string, value?: any): () => void
    accessor(name: string, options: Omit<Property.Accessor, 'type'>): void
    mixin<K extends string & keyof this>(
      name: K,
      mixins: (keyof this & keyof this[K])[] | Dict<string>,
    ): void
    mixin<T extends {}>(
      source: T,
      mixins: (keyof this & keyof T)[] | Dict<string>,
    ): void
  }
}

// 精简错误堆栈：去掉内部代理产生的前两帧，让报错更贴近用户代码。
function enhanceError(error: Error) {
  const lines = error.stack!.split('\n')
  lines.splice(0, 2, `Error: ${error.message}`)
  error.stack = lines.join('\n')
  return error
}

const RESERVED_WORDS = ['prototype', 'then']

// 判断是否为「特殊属性」——这类属性直接走原生 Reflect，不参与服务解析：
// - is a symbol
// - is a reserved word (prototype, then)
// - is a number string (0, 1, 2, ...)
// - starts with `_`
function isSpecialProperty(prop: string | symbol): prop is symbol {
  return (
    typeof prop === 'symbol'
    || RESERVED_WORDS.includes(prop)
    || parseInt(prop).toString() === prop
    || prop.startsWith('_')
  )
}

// 上下文属性的两种类型：service（真正的服务）与 accessor（getter/setter 形式的虚拟属性）。
export type Property = Property.Service | Property.Accessor

export namespace Property {
  export interface Service {
    type: 'service'
  }

  export interface Accessor {
    type: 'accessor'
    get: (this: Context, receiver: any, error: Error) => any
    set?: (this: Context, value: any, receiver: any, error: Error) => boolean
  }
}

// 一个服务实现（implementation）的登记信息。
export interface Impl {
  // 服务名
  name: string
  // 提供该服务的 fiber
  fiber: Fiber
  // 服务实例
  value?: any
  // 可选的「依赖是否就绪」校验
  check?: () => boolean
}

/**
 * ReflectService：反射服务，是 Context 能「按名解析服务」的核心。
 *
 * 静态 handler 就是 Context 构造时使用的 Proxy 处理器：拦截 get/set/has，
 * 把普通属性访问翻译为服务解析（沿 fiber 链向上查找、校验隔离域、触发
 * internal/get 等事件）。实例侧则负责 provide/accessor/mixin 等声明能力。
 */
export class ReflectService {
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      // 特殊属性直接透传，不做服务解析。
      if (isSpecialProperty(prop)) {
        return Reflect.get(target, prop, ctx)
      }
      // 已存在的自有/原型属性：包一层 traceable 后返回（保持追踪链路）。
      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx))
      }

      const error = new Error(`cannot get property "${prop}" without inject`)

      try {
        // accessor 类型的属性走自定义 getter。
        const def = target.reflect.props[prop]
        if (def?.type === 'accessor') {
          return def.get.call(ctx, ctx[symbols.receiver], error)
        }

        // a fiber-less def site cannot declare `inject` at all, so it keeps the unchecked root access.
        const defSite = (ctx[symbols.shadow] as Context | undefined) ?? ctx
        if (!defSite.fiber.runtime) return ctx.reflect.get(prop, false)
        // 通过 waterfall 触发 internal/get，允许外部拦截；默认逻辑沿 fiber 链向上解析服务。
        return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
          const key = target[symbols.isolate][prop]
          let fiber = defSite.fiber
          while (true) {
            // 命中当前 fiber 的服务实现即返回。
            const impl = fiber.store?.[prop]
            if (impl) return getTraceable(ctx, impl.value)
            // 该服务在 inject 声明中，但当前上下文尚未激活。
            if (prop in fiber.inject) {
              error.message = `cannot get required service "${prop}" in inactive context`
              throw error
            }
            if (!fiber.runtime) throw error
            // 隔离域不一致，说明上层看不到该服务，终止查找。
            if (fiber.parent[symbols.isolate][prop] !== key) throw error
            fiber = fiber.parent.fiber
          }
        })
      } catch (e: any) {
        // 仅对我们自己抛出的 error 精简堆栈，其它错误原样抛出。
        throw e === error ? enhanceError(e) : e
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (isSpecialProperty(prop)) {
        return Reflect.set(target, prop, value, ctx)
      }

      const error = new Error(`cannot set property "${prop}" without provide`)
      const def = target.reflect.props[prop]
      // 未声明的属性：非激活态允许直接写（初始化阶段），否则报错。
      if (!def) {
        if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)
        throw enhanceError(error)
      }

      try {
        // accessor 走自定义 setter（无 setter 则拒绝写入）。
        if (def.type === 'accessor') {
          if (!def.set) return false
          return def.set.call(ctx, value, ctx[symbols.receiver], error)
        }

        // service 通过 waterfall 触发 internal/set，默认逻辑委托给 reflect.set。
        return ctx.events.waterfall(
          'internal/set',
          ctx,
          prop,
          value,
          error,
          () => {
            return ctx.reflect.set(prop, value, error)
          },
        )
      } catch (e: any) {
        throw e === error ? enhanceError(e) : e
      }
    },

    has: (target, prop) => {
      if (isSpecialProperty(prop)) {
        return Reflect.has(target, prop)
      }
      if (Reflect.has(target, prop)) return true
      // 声明过的服务/accessor 也算「存在」。
      return !!target.reflect.props[prop]
    },
  }

  // 全部服务实现：以隔离域 symbol 为键。
  public store: Dict<Impl, symbol> = Object.create(null)
  // 全部属性声明：service 或 accessor。
  public props: Dict<Property> = Object.create(null)

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    // 把各内置服务的部分方法「混入」到 ctx 上，使 `ctx.on`、`ctx.plugin` 等可直接调用。
    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
    this.mixin('fiber', ['runtime', 'effect'])
    this.mixin('registry', ['inject', 'plugin'])
    this.mixin('events', [
      'on',
      'once',
      'parallel',
      'emit',
      'serial',
      'bail',
      'waterfall',
    ])
  }

  // 按名获取服务值；strict 为 true 时要求提供者 fiber 处于 ACTIVE 状态。
  get(name: string, strict = true) {
    return getTraceable(this.ctx, this._getImpl(name, strict)?.value)
  }

  // 解析服务实现：先经隔离域映射到 symbol，再从 store 取出，并按需校验激活状态。
  _getImpl(name: string, strict = true) {
    const key = this.ctx[symbols.isolate][name]
    const impl = key && this.store[key]
    if (!impl) return
    if (strict && impl.fiber.state !== FiberState.ACTIVE) return
    return impl
  }

  // 直接设置服务值：要求该服务已 provide，且必须在其提供者 fiber 内设置。
  set(name: string, value: any, error?: Error) {
    const key = this.ctx[symbols.isolate][name]
    const impl = this.store[key]
    if (!impl) {
      throw new Error(`cannot set property "${name}" without provide`)
    }
    if (impl.fiber !== this.ctx.fiber) {
      throw new Error(`cannot set property "${name}" in multiple fibers`)
    }
    impl.value = value
    return true
  }

  // 声明并提供一个服务：登记 props、分配隔离域 symbol、写入 store，
  // 返回的 effect 在卸载时会移除服务并等待相关 fiber 收敛。
  provide(name: string, value?: any, check?: () => boolean) {
    return this.ctx.fiber.effect(
      () => {
        // 若已存在同名 accessor 声明则报错，否则登记为 service 类型。
        if (!this.props[name]) {
          this.props[name] ??= { type: 'service' }
        } else if (this.props[name].type !== 'service') {
          throw new Error(
            `property "${name}" is already declared as ${this.props[name].type}`,
          )
        }
        this.props[name] = { type: 'service' }

        // 在根上下文分配一个稳定的隔离域 symbol（同名服务共享）。
        this.ctx.root[symbols.isolate][name] ??= Symbol(name)
        const key = this.ctx[symbols.isolate][name]
        const impl: Impl = { name, value, fiber: this.ctx.fiber, check }
        // 同一隔离域下不允许重复注册同名服务。
        if (this.store[key]) {
          throw new Error(
            `service "${name}" has been registered at <${this.store[key].fiber.name}>`,
          )
        }
        this.store[key] = impl
        this.ctx.fiber.store![name] = impl
        // 若当前 fiber 已激活，立即通知依赖方服务已就绪。
        if (this.ctx.fiber.state === FiberState.ACTIVE) {
          this.notify([name])
        }
        // 卸载逻辑：移除服务、通知依赖方，等待它们收敛后再清理自身引用。
        return async () => {
          delete this.store[key]
          const fibers = this.notify([name])
          await Promise.allSettled(fibers.map((fiber) => fiber.await()))
          // ensure self access before dependencies cleanup
          delete this.ctx.fiber.store![name]
        }
      },
      `ctx.provide(${JSON.stringify(name)})`,
    )
  }

  // 服务可用性变化时的通知：刷新所有注入了该服务的 fiber，并广播 internal/service 事件。
  notify(
    names: string[],
    filter = (ctx: Context, name: string) =>
      ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name],
  ) {
    const fibers: Fiber[] = []
    // 遍历所有插件运行时下的 fiber，凡注入了相关服务且通过过滤器的，重新校验并刷新。
    for (const runtime of this.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false
        for (const name of names) {
          if (!(name in fiber.inject)) continue
          if (!filter(fiber.ctx, name)) continue
          hasUpdate = true
          fiber._checkImpl(name)
        }
        if (!hasUpdate) continue
        fiber._refresh()
        fibers.push(fiber)
      }
    }
    // 为每个服务名广播 internal/service，附带一个仅对匹配上下文生效的过滤器。
    for (const name of names) {
      const self: Context = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => filter(target, name)
      this.ctx.events.emit(
        self,
        'internal/service',
        name,
        this._getImpl(name, false)?.value,
      )
    }
    return fibers
  }

  // 声明一个 accessor（虚拟属性）：读写将走自定义的 get/set，随 effect 卸载而移除。
  accessor(name: string, options: Omit<Property.Accessor, 'type'>) {
    return this.ctx.fiber.effect(
      () => {
        if (name in this.props) {
          throw new Error(
            `property "${name}" is already declared as ${this.props[name].type}`,
          )
        }
        this.props[name] = { type: 'accessor', ...options }
        return () => delete this.props[name]
      },
      `ctx.accessor(${JSON.stringify(name)})`,
    )
  }

  // 把 source 服务上的若干成员「混入」为 ctx 的 accessor，使其可经 ctx 直接读写/调用。
  mixin(source: any, mixins: string[] | Dict<string>) {
    const self = this
    return this.ctx.fiber.effect(
      function* () {
        // 支持数组（同名映射）或对象（重命名映射）两种形式。
        const entries = Array.isArray(mixins)
          ? mixins.map((key) => [key, key])
          : Object.entries(mixins)
        const getTarget = (ctx: Context, error: Error) => {
          // TODO enhance error message
          return ctx[source]
        }
        // 为每个成员生成一个 accessor：读取时绑定到目标服务，函数成员自动 bind。
        for (const [key, value] of entries) {
          yield self.accessor(value, {
            get(receiver, error) {
              const service = getTarget(this, error)
              if (isNullable(service)) return service
              const mixin = receiver ? withProps(receiver, service) : service
              const value = Reflect.get(service, key, mixin)
              if (typeof value !== 'function') return value
              return value.bind(mixin ?? service)
            },
            set(value, receiver, error) {
              const service = getTarget(this, error)
              const mixin = receiver ? withProps(receiver, service) : service
              return Reflect.set(service, key, value, mixin)
            },
          })
        }
      },
      `ctx.mixin(${JSON.stringify(source)})`,
    )
  }

  // 把任意值包装为可追踪对象（供服务解析链使用）。
  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  // 包装回调：调用/构造时，对 this 与各参数做 trace，使它们在正确的上下文中被解析。
  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return Reflect.apply(
          target,
          this.trace(thisArg),
          args.map((arg) => this.trace(arg)),
        )
      },
      construct: (target, args, newTarget) => {
        return Reflect.construct(
          target,
          args.map((arg) => this.trace(arg)),
          newTarget,
        )
      },
    })
  }
}
