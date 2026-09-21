import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { Plugin } from './registry'
import {
  buildOuterStack,
  composeError,
  DisposableList,
  getTraceable,
  isConstructor,
  isObject,
  symbols,
} from './utils'
import { Impl } from './reflect'
import { StandardSchemaV1 } from '@standard-schema/spec'

// 通过模块合并，把 fiber 与 effect 挂到 Context 上（ctx.fiber / ctx.effect）。
// 使用 TypeScript 的「模块增强（Module Augmentation）」功能，在不修改 context.ts
// 源文件的前提下，为 Context 接口补充额外的类型信息。
//
// 为什么需要它？
// 运行时 Fiber 构造函数通过 parent.extend({ fiber: this }) 把 fiber 实例挂到 ctx 上，
// 而 effect 方法也来自 Fiber 类，因此 ctx 在运行时确实具备 fiber 属性和 effect 方法。
// 但 TypeScript 编译器并不知道这一点（这些属性不在 Context 原始接口定义里），
// 所以需要通过模块增强"通知"编译器，让 ctx.fiber 和 ctx.effect 也能获得正确的类型提示。
declare module './context' {
  // 这里做了两件事：
  // 1. extends Pick<Fiber, 'effect'>：让 Context 继承 Fiber 类上的 effect 方法，
  //    用 Pick 精确挑出只需要的成员，避免把 Fiber 里不相关的东西都拉进来。
  // 2. fiber: Fiber：新增 fiber 属性，指向当前 ctx 所属的 Fiber 实例。
  export interface Context extends Pick<Fiber, 'effect'> {
    fiber: Fiber
  }
}

const kValidationError = Symbol.for('ValidationError')

// 配置校验失败时抛出的错误：把 schema 的 issues 汇总为可读的多行信息。
export class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(
      `invalid config:\n`
      + issues
        .map((issue) => {
          if (issue.path) {
            return `  - ${issue.message} (at ${issue.path.join('.')})`
          } else {
            return `  - ${issue.message}`
          }
        })
        .join('\n'),
    )
  }
}

Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

// 用插件的 Config schema 校验并规范化 config；不支持异步校验。
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  // 插件未声明 Config（可选）时直接原样返回——这正是「不带 Config 的插件」也能正常加载的原因。
  if (!runtime.Config) return config
  // TODO: async validation
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}

// 一个「可 await 的 disposer」：既能作为函数直接调用来清理，也能被 await 以等待清理完成。
interface AsyncDisposable<
  T extends Awaitable<void> = Awaitable<void>,
> extends PromiseLike<() => T> {
  (): T
}

// 清理函数类型。
export type Disposable<T = any> = () => T

// 副作用（effect）的返回值：可以是同步/异步的清理函数，或（异步）可迭代的清理函数序列。
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>

type SyncEffect<T = any> = Disposable<T> | Iterable<Disposable<T>, void, void>

type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>

// 副作用的元信息（用于调试展示 effect 树）。
export interface EffectMeta {
  label: string
  children: EffectMeta[]
}

// effect 执行器的内部结构：epoch 用于判定当前执行是否已过期。
interface EffectRunner<T> {
  epoch: T
  execute: () => any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

// Fiber（纤程）的生命周期状态。
export const enum FiberState {
  // 依赖未满足，等待中
  PENDING,
  // 正在加载（执行插件回调）
  LOADING,
  // 已激活
  ACTIVE,
  // 加载中出错
  FAILED,
  // 已销毁
  DISPOSED,
  // 正在卸载
  UNLOADING,
}

// cordis 的通用错误类型。
export class CordisError extends Error {
  constructor(
    public code: CordisError.Code,
    message?: string,
  ) {
    super(message ?? CordisError.Code[code])
  }
}

export namespace CordisError {
  export type Code = keyof typeof Code

  // 错误码到默认消息的映射表。
  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

// 特殊的 epoch 值，表示 fiber 处于「未激活」状态。
const INACTIVE = '__INACTIVE__'

/**
 * Fiber（纤程）：插件实例的生命周期与副作用管理单元。
 *
 * 每次 `ctx.plugin()` 都会创建一个 Fiber，它持有专属的 ctx、依赖注入信息与
 * 一组可清理的副作用（disposables）。Fiber 会根据依赖是否满足在 PENDING/
 * LOADING/ACTIVE/UNLOADING 等状态间迁移，并在卸载时按逆序清理所有副作用。
 * 根上下文对应一个特殊的「无 runtime」Fiber，直接处于 ACTIVE。
 */
export class Fiber {
  // 唯一自增 id；被销毁后置为 null
  public uid: number | null
  // 该 fiber 专属的上下文
  public readonly ctx: Context
  // 规范化后的配置
  public config: any
  // 当前生命周期状态
  public state = FiberState.PENDING
  // 卸载该 fiber 的方法
  public readonly dispose: () => Promise<void>
  // 激活期间该 fiber 提供的服务实现（未激活时为 undefined）
  public store: Dict<Impl> | undefined
  // 表示「正在进行的加载/卸载」的 promise，用于串行化状态迁移
  public inertia: Promise<void> | undefined

  // 按事件名分组的钩子列表（如 internal/update）
  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  // 该 fiber 收集到的全部副作用清理函数
  public readonly _disposables = new DisposableList<Disposable>()

  // 与 `this.ctx` 指向同一个上下文，只是这里标注为更具体的 Context 类型
  protected context: Context

  // 加载失败时记录的错误
  private _error: any
  // 副作用执行器
  private _runner: EffectRunner<string>
  // 依赖满足时暂存的服务实现（激活时会拷贝到 store）
  private _store: Dict<Impl> = Object.create(null)

  constructor(
    public parent: Context,
    config: any,
    public inject: Dict<any>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
  ) {
    // 收集副作用清理函数到该 fiber 的 disposables 列表。
    const collect = (dispose: Disposable) => {
      this._disposables.push(dispose)
    }

    if (runtime) {
      // —— 普通插件 fiber ——
      this.uid = parent.registry.counter
      // 派生专属 ctx，并把自身挂到 ctx.fiber。
      this.ctx = this.context = parent.extend({ fiber: this })

      // 把注入声明中的非空配置写入 intercept，作为该 fiber 的默认拦截配置。
      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
        for (const [name, config] of injectEntries) {
          if (isNullable(config)) continue
          this.ctx[Context.intercept][name] = config
        }
      }

      // 定义「执行插件回调」的 runner：构造函数式插件走 new + init 钩子，函数式插件直接调用。
      // 呼应 registry.resolve——那里为拿到唯一 key 并不区分函数/类（class 本质也是 function），
      // 真正「该 call 还是该 new」的区分被延后到这里，通过 isConstructor 判定。
      // 注意：此处刻意用普通 function 而非箭头函数，因为 _execute 会以 runner.execute.call(this)
      //      调用它（见 _execute），需要让 this 动态绑定到当前 fiber 以访问 this.ctx / this.config。
      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function () {
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }

      // 广播插件创建事件。
      this.context.emit('internal/plugin', this)

      // 初始化各依赖的可用性状态。
      for (const name of Object.keys(this.inject)) {
        this._checkImpl(name)
      }

      // 把「注册到 runtime + 校验配置 + 刷新状态」登记为父 fiber 的一个副作用，
      // 其清理逻辑负责从 runtime 注销、清理 registry 并等待收敛。
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        try {
          this.config = resolveConfig(runtime, config)
          this._refresh()
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = error
        }
        return async () => {
          // 置空 uid ——即「死亡标记」：此后 assertActive() 会判定该 fiber 已卸载并抛
          // INACTIVE_EFFECT，从而阻止在这个僵尸上下文上继续加载插件 / 创建副作用。
          this.uid = null
          this.context.emit('internal/plugin', this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          // `this.inertia` 本身理论上永远不会 reject —— `_reload` 与 `_unload`
          // 都会通过 `ctx.logger.error` 吞掉各自的业务错误。
          // 如果它「真的」reject 了，唯一可能的原因就是 logger 自身出错，
          // 而在此处我们无法恢复（因为再次调用 logger 正是刚刚失败的操作）。
          // 此时任由该 rejection 向上传播；进程级崩溃才是诚实的结果。
          while (this.inertia) {
            await this.inertia
          }
        }
      }, 'ctx.plugin()')
    } else {
      // —— 根 fiber（无 runtime）——：直接激活，不执行任何回调。
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._runner = {
        epoch: '',
        getOuterStack,
        execute: () => { },
        collect,
      }
      this.dispose = () => this.restart()
    }
  }

  // 就近向上查找具名的 runtime，作为该 fiber 的名字；一直找不到则返回 'root'。
  get name() {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  // 断言 fiber 仍存活（uid 未被置空）；否则抛错，禁止在已卸载的上下文上创建副作用。
  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  /**
   * 执行一个 runner，并把它产生的「清理函数」收集起来。
   *
   * runner.execute 的返回值形态多样，这里逐一归一化处理：
   * - 函数：直接作为清理函数收集；
   * - null/undefined：无副作用；
   * - Promise：await 后收集其结果；
   * - （异步）可迭代对象：逐个 yield 出清理函数并收集，异步迭代过程中
   *   若 epoch 发生变化则提前中止（说明本次执行已过期，无需再收集）。
   * 全程用 composeError 包裹，以拼接跨异步边界的长堆栈。
   */
  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    return composeError((info) => {
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute.call(this)
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        // 返回 null/undefined：表示没有需要清理的副作用，直接跳过
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        return effect.then(safeCollect)
      } else if (Symbol.iterator in effect) {
        info.error = new Error()
        const iter = effect[Symbol.iterator]()
        while (true) {
          const result = iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = effect[Symbol.asyncIterator]()
        return (async () => {
          // 主动 await 一次，强制生成异步调用栈，便于报错时定位到真实来源
          await Promise.resolve()
          info.error = new Error()
          while (true) {
            if (runner.epoch !== oldEpoch) return
            const result = await iter.next()
            safeCollect(result.value)
            if (result.done) return
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack)
  }

  /**
   * 注册一个副作用（effect）：执行 execute 收集其清理函数，并返回一个 disposer。
   *
   * 返回的 disposer 既可当函数直接调用来清理，也可被 await 等待清理完成
   * （见 AsyncDisposable）。清理时按登记的逆序（LIFO）依次执行，异步清理
   * 会串成一条 promise 链依次 await。disposer 上挂着 EffectMeta
   * （symbols.effect），用于调试时展示 effect 树。
   */
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    this.assertActive()

    const disposables: Disposable[] = []
    const dispose = () => {
      let task!: void | Promise<void>
      for (const dispose of disposables.splice(0).reverse()) {
        if (task) {
          task = task.then(dispose)
        } else {
          const result = dispose()
          if (isObject(result) && 'then' in result) {
            task = result as any
          }
        }
      }
      return task
    }

    const meta: EffectMeta = { label, children: [] }
    const runner: EffectRunner<boolean> = {
      execute,
      epoch: true,
      collect: (dispose) => {
        disposables.push(dispose)
        this._disposables.delete(dispose)
        if (dispose[symbols.effect]) {
          meta.children.push(dispose[symbols.effect])
        }
      },
      getOuterStack: buildOuterStack(),
    }

    let task: void | Promise<void>
    try {
      task = this._execute(runner)
    } catch (reason) {
      dispose()
      throw reason
    }

    // 防止未处理的 rejection —— 既包括 `task` 自身失败，也包括其后 disposer
    // 清理链未能干净收敛时抛出的错误，最终统一交给 logger 记录。
    task?.catch(dispose).catch((error) => this.ctx.logger.error(error))

    const wrapper = defineProperty(
      () => {
        if (!runner.epoch) return
        runner.epoch = false
        return task ? task.then(dispose) : dispose()
      },
      symbols.effect,
      meta,
    ) as AsyncDisposable

    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return dispose()
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    disposables.push(this._disposables.push(wrapper))
    return wrapper
  }

  // 收集当前所有副作用的元信息（EffectMeta），用于调试时展示 effect 树。
  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>((dispose) => dispose[symbols.effect])
      .filter(Boolean)
  }

  // 根据内部字段推导「应当处于」的生命周期状态：
  // uid 为空 -> DISPOSED；有错误 -> FAILED；已激活（epoch 非 INACTIVE）-> ACTIVE；否则 PENDING。
  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  /**
   * 更新状态并广播变化。
   *
   * callback 可显式返回一个目标状态（如 LOADING/UNLOADING），否则用 _getState() 推导。
   * 状态确有变化时发出 internal/status 事件；并且仅当发生「ACTIVE <-> 非 ACTIVE」的
   * 跨越时，才通知本 fiber 所提供的各服务（让依赖方感知其可用性变化）。
   */
  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    // FIXME internal/fiber-info
    this.context.emit('internal/status', this, oldState)

    // 仅在 ACTIVE 与非 ACTIVE 之间切换时才需要通知依赖方
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) {
      return
    }
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key as symbol]
      if (impl.fiber !== this) continue
      this.ctx.reflect.notify([impl.name])
    }
  }

  // 检查某个依赖服务当前是否可用，并更新到 _store：
  // 服务不存在、或其 check() 返回假 / 抛错，都视为不可用（从 _store 删除）。
  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.fiber.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  /**
   * 根据依赖满足情况重新计算 epoch 并触发加载/卸载。
   *
   * 把所有依赖的「提供者 fiber uid」拼成一个字符串作为 epoch：
   * - 任一依赖缺失 -> epoch 置为 INACTIVE（不应激活）；
   * - 全部就绪 -> epoch 形如 ":uid1:uid2..."，依赖提供者变化时 epoch 也随之改变，
   *   从而驱动重新加载。
   */
  _refresh() {
    let epoch: string | boolean = false
    epoch = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }

  /**
   * 设置新的 epoch，并据此驱动状态迁移（加载 / 卸载）。
   *
   * - epoch 未变则不处理；
   * - 处于 FAILED 的 fiber 只能通过 update() 恢复（会清空 _error），此处直接返回；
   * - 若已有正在进行的 inertia（加载/卸载任务），只更新 epoch，由该任务收尾时再决定后续；
   * - 否则：从 INACTIVE -> 激活则触发 _reload；反之触发 _unload。
   */
  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    // 失败的 fiber 只能通过 update() 恢复（update 会清空 _error）
    if (this._error) return
    this._runner.epoch = epoch
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  /**
   * 加载：执行插件回调、收集副作用，并推进状态。
   *
   * 先固化当前依赖快照到 store，await 一个微任务后执行 runner。若执行出错则记录
   * 错误、标记为 FAILED（epoch 置 INACTIVE）。执行完毕后检查 epoch 是否仍与开始时
   * 一致：一致说明加载有效，清空 inertia；否则期间依赖已变化，转而 _unload。
   */
  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      await this._execute(this._runner)
    } catch (reason) {
      // impl 保证 reason 非空（?）
      this.ctx.logger.error(reason)
      this._error = reason
      this._runner.epoch = INACTIVE
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  /**
   * 卸载：并发执行所有副作用的清理函数（各自独立 await、单独捕获错误），
   * 清空 store，再推进状态。若卸载完成后 epoch 仍为 INACTIVE 则收敛（清空 inertia）；
   * 否则说明期间依赖又满足了，转而重新 _reload。
   */
  private async _unload() {
    await Promise.all(
      this._disposables.clear().map(async (dispose) => {
        try {
          await composeError(async (info) => {
            await Promise.resolve()
            info.error = new Error()
            await dispose()
          }, this._runner.getOuterStack)
        } catch (reason) {
          this.ctx.logger.error(reason)
        }
      }),
    )
    this.store = undefined
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  // 等待该 fiber 收敛到稳定状态：循环 await 进行中的 inertia，直到没有待完成任务；
  // 若加载过程中出错则抛出该错误，否则返回自身。
  async await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
    return this
  }

  // 重启：先置 INACTIVE 强制卸载，再重新计算依赖并加载，最后等待收敛。
  async restart() {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    fiber._setEpoch(INACTIVE)
    fiber._refresh()
    await fiber.await()
  }

  // 更新配置：校验新配置后，通过 internal/update 事件走 waterfall，
  // 允许监听者拦截；默认逻辑是写入新配置、清空错误并重启该 fiber。
  update(config: any, noSave = false): Awaitable<void> {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    config = resolveConfig(fiber.runtime!, config)
    const result = fiber.context.waterfall(fiber, 'internal/update', config, noSave, () => {
      fiber.config = config
      fiber._error = undefined
      return fiber.restart()
    })
    // a listener may veto the restart, in which case there is nothing to await
    if (result === undefined) return
    const task = Promise.resolve(result)
    // the failure is already reported by the fiber, so mark it handled here:
    // a caller that drops the result cannot turn it into an unhandled
    // rejection, while `await update()` still observes it
    task.catch(() => { })
    return task
  }
}
