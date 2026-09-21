import { defineProperty, Promisify } from 'cosmokit'
import { Context } from './context'
import { Fiber, FiberState } from './fiber'
import { DisposableList, symbols } from './utils'

// 判断串行/短路事件的返回值是否「命中」（非 null/false/undefined 即视为命中，用于 bail/serial 提前返回）。
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

// 从函数类型中提取参数、返回值、this 类型的工具类型。
export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any
  ? T
  : never

// 事件的分发模式。
export type DispatchMode =
  | 'emit'
  | 'parallel'
  | 'serial'
  | 'bail'
  | 'waterfall'

// 通过模块合并，把事件相关方法直接挂到 Context 上，使 `ctx.on/emit/...` 具备完整类型。
declare module './context' {
  export interface Context {
    /* eslint-disable max-len */
    parallel<K extends keyof Events>(
      name: K,
      ...args: Parameters<Events[K]>
    ): Promise<void>
    parallel<K extends keyof Events>(
      thisArg: NoInfer<ThisType<Events[K]>>,
      name: K,
      ...args: Parameters<Events[K]>
    ): Promise<void>
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    emit<K extends keyof Events>(
      thisArg: NoInfer<ThisType<Events[K]>>,
      name: K,
      ...args: Parameters<Events[K]>
    ): void
    serial<K extends keyof Events>(
      name: K,
      ...args: Parameters<Events[K]>
    ): Promisify<ReturnType<Events[K]>>
    serial<K extends keyof Events>(
      thisArg: NoInfer<ThisType<Events[K]>>,
      name: K,
      ...args: Parameters<Events[K]>
    ): Promisify<ReturnType<Events[K]>>
    bail<K extends keyof Events>(
      name: K,
      ...args: Parameters<Events[K]>
    ): ReturnType<Events[K]>
    bail<K extends keyof Events>(
      thisArg: NoInfer<ThisType<Events[K]>>,
      name: K,
      ...args: Parameters<Events[K]>
    ): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(
      name: K,
      ...args: Parameters<Events[K]>
    ): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(
      thisArg: NoInfer<ThisType<Events[K]>>,
      name: K,
      ...args: Parameters<Events[K]>
    ): ReturnType<Events[K]>
    on<K extends keyof Events>(
      name: K,
      listener: Events[K],
      options?: boolean | EventOptions,
    ): () => boolean
    once<K extends keyof Events>(
      name: K,
      listener: Events[K],
      options?: boolean | EventOptions,
    ): () => boolean
    /* eslint-enable max-len */
  }
}

// 事件监听的可选项。
export interface EventOptions {
  // 是否插入到监听器队列头部（优先执行）
  prepend?: boolean
  // 是否为全局监听器（不受上下文过滤器约束）
  global?: boolean
}

// 一条已注册的钩子：记录其归属上下文与回调。
export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
}

/**
 * EventsService：事件总线服务。
 *
 * 提供 on/once 注册与 emit/parallel/serial/bail/waterfall 五种分发模式：
 * - emit：同步依次触发，无返回；
 * - parallel：并发触发并聚合错误；
 * - serial：串行触发，遇到「命中」值即返回；
 * - bail：同步串行，遇到「命中」值即返回；
 * - waterfall：洋葱式中间件，通过 next() 逐层传递。
 */
export class EventsService {
  // 事件名 -> 钩子列表
  _hooks: Record<keyof any, Hook[]> = Object.create(null)

  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    // 拦截 internal/update 的监听器注册：把它按 fiber 维度单独收集，实现「配置热更新」的中间件链。
    this.on(
      'internal/listener',
      function (this: Context, name, listener, options: EventOptions) {
        if (name === 'internal/update' && !options.global) {
          const hooks = (this.fiber._hooks['internal/update']
            ??= new DisposableList())
          const method = options.prepend ? 'unshift' : 'push'
          return hooks[method](listener)
        }
      },
    )

    // internal/update 的全局处理器：把 fiber 上收集的更新钩子串成 next 链，最后回落到默认 next。
    this.on(
      'internal/update',
      function (config, noSave, next) {
        const cbs = [...(this._hooks['internal/update'] || [])]
        const _next = () => {
          const cb = cbs.shift() ?? next
          return cb.call(this, config, noSave, _next)
        }
        return _next()
      },
      { global: true, prepend: true },
    )
  }

  // 解析分发参数：分离出可选的 thisArg 与事件名，触发 internal/dispatch 探针，并按上下文过滤器筛出回调列表。
  private _resolve(type: string, args: any[]) {
    const thisArg
      = typeof args[0] === 'object' || typeof args[0] === 'function'
        ? args.shift()
        : null
    const name: string | symbol = args.shift()
    // 非 internal/ 事件且存在 dispatch 监听时，先发一个 internal/dispatch 事件（用于调试/观测）。
    if (
      (typeof name !== 'string' || !name.startsWith('internal/'))
      && this._hooks['internal/dispatch']?.length
    ) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    // 过滤器来自 thisArg：全局钩子始终保留，否则需通过过滤器校验其归属上下文。
    const filter = thisArg?.[Context.filter]
    return [
      thisArg,
      (this._hooks[name] || [])
        .filter(
          (hook) => hook.global || !filter || filter.call(thisArg, hook.ctx),
        )
        .map((hook) => hook.callback),
    ] as const
  }

  /** @deprecated */
  dispatch(type: string, args: any[]) {
    const [thisArg, callbacks] = this._resolve(type, args)
    return callbacks.map((callback) => callback.bind(thisArg))
  }

  // 并发触发所有监听器，等待全部完成；若有失败则聚合为 AggregateError 抛出。
  async parallel(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    const results = await Promise.allSettled(
      callbacks.map(async (callback) => Reflect.apply(callback, thisArg, args)),
    )
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (errors.length) { throw new AggregateError(errors.map((error) => error.reason)) }
  }

  // 同步依次触发所有监听器，忽略返回值。
  emit(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    for (const callback of callbacks) Reflect.apply(callback, thisArg, args)
  }

  // 串行（await）触发监听器，一旦某个返回「命中」值即提前返回该值。
  async serial(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('serial', args)
    for (const callback of callbacks) {
      const result = await Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  // 同步版 serial：遇到「命中」值即返回。
  bail(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('bail', args)
    for (const callback of callbacks) {
      const result = Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  // 洋葱式中间件分发：每个回调接收 next 决定是否继续，最后一个 next 回落到 inner。
  waterfall(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('waterfall', args)
    const inner = args.pop()
    const dispatch = () => {
      const callback = callbacks.shift()
      if (!callback) return inner()
      let called = false
      const next = () => {
        // 防止同一层中间件重复调用 next()。
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch()
      }
      return Reflect.apply(callback, thisArg, [...args, next])
    }
    return dispatch()
  }

  // 把钩子登记为一个 effect，随上下文卸载自动注销；prepend 决定插入队首还是队尾。
  private register(
    label: string,
    name: string | symbol,
    callback: any,
    options: EventOptions,
  ): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      const hooks = (this._hooks[name] ??= [])
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(name, callback)
    }, label)
  }

  // 从事件的钩子列表中移除指定回调；列表清空后删除该事件键。
  private unregister(name: string | symbol, callback: any) {
    const hooks = this._hooks[name]
    if (!hooks) return
    const index = hooks.findIndex((hook) => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      if (!hooks.length) delete this._hooks[name]
      return true
    }
  }

  // 注册监听器：绑定追踪、先给 internal/listener 一次拦截机会，未被拦截则正常登记。
  on(
    name: string | symbol,
    listener: (...args: any) => any,
    options?: boolean | EventOptions,
  ) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(
      this.ctx,
      'internal/listener',
      name,
      listener,
      options,
    )
    if (result) return result

    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, name, listener, options)
  }

  // 一次性监听：首次触发后立即注销自身。
  once(
    name: string | symbol,
    listener: (...args: any) => any,
    options?: boolean | EventOptions,
  ) {
    const dispose = this.on(
      name,
      function (...args: any[]) {
        dispose()
        return listener.apply(this, args)
      },
      options,
    )
    return dispose
  }
}

// 内置事件表：定义框架内部事件（internal/*）的签名，供类型推导使用。
export interface Events {
  [key: symbol]: (...args: any[]) => any
  // 插件（fiber）被创建或销毁时触发
  'internal/plugin'(fiber: Fiber): void
  // fiber 状态变化时触发
  'internal/status'(fiber: Fiber, oldValue: FiberState): void
  // 服务被 provide/卸载导致可用性变化时触发
  'internal/service'(this: Context, name: string, value: any): void
  // 插件配置热更新的中间件链
  'internal/update'(this: Fiber, config: any, noSave: boolean, next: () => void): void
  // 读取服务属性时的可拦截钩子（waterfall）
  'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any
  // 写入服务属性时的可拦截钩子（waterfall）
  'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean
  // 注册监听器时的可拦截钩子
  'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void
  // 任意事件分发时的观测探针
  'internal/dispatch'(mode: DispatchMode, name: string | symbol, args: any[], thisArg: any): void
}
