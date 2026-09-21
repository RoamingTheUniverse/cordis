import { defineProperty, hyphenate } from 'cosmokit'
import { Context } from './context'
import { Fiber } from './fiber'
import { createCallable, joinPrototype, symbols, Tracker } from './utils'

// 通过模块合并，为 Intercept 声明 logger 的拦截配置类型（可设置 name、level）。
declare module './context' {
  interface Intercept {
    logger: LoggerService.Intercept
  }
}

// 日志的四种类型（对外 API 名称）。
export type LoggerType = 'error' | 'info' | 'warn' | 'debug'

// 日志方法签名：首个参数为格式串或任意值，后续为格式化参数。
export type LoggerMethod = (format: any, ...param: any[]) => void

// 自定义格式化器：接收原始值、导出器与消息，返回格式化后的字符串片段。
export type Formatter = (
  value: any,
  exporter: Exporter,
  message: Message,
) => any

// 日志级别，数值越大越详细（ERROR 最严重，DEBUG 最啰嗦）。
export const enum LoggerLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

// 一条日志消息的完整结构。
export interface Message {
  // 自增序号（sequence number），全局唯一
  sn: number
  // 时间戳（毫秒）
  ts: number
  // 日志来源名（通常为插件名）
  name: string
  // 日志类型
  type: LoggerType
  // 数值化的级别
  level: number
  // 原始日志参数
  args: any[]
  // 产生该日志的 fiber（弱引用，避免阻止其被回收）
  fiber?: WeakRef<Fiber>
}

// 导出器：决定日志「输出到哪里、怎么输出」。可配置颜色、最大长度、级别与格式化器。
export interface Exporter {
  colors?: number | false
  maxLength?: number
  levels?: Record<string, number>
  formatters?: Record<string, Formatter>
  export(message: Message): void
}

// 内置的格式化占位符实现：%s 字符串、%d/%i 整数、%f 浮点、%o/%O JSON、%c/%C 颜色。
export const defaultFormatters: Record<string, Formatter> = {
  s: (value) => String(value),
  d: (value) => Math.trunc(Number(value)),
  i: (value) => Math.trunc(Number(value)),
  f: (value) => Number(value),
  o: (value) => JSON.stringify(value),
  O: (value) => JSON.stringify(value),
  c: () => '',
  C: (value, exporter, message) => {
    return Logger.color(
      exporter,
      Logger.code(message.name, exporter.colors),
      value,
    )
  },
}

export interface LoggerOptions {
  name: string
  meta?: Partial<Message>
  level?: number
}

// 通过接口合并，让 Logger 实例同时拥有 LoggerOptions 字段与 error/info/warn/debug 方法。
export interface Logger extends LoggerOptions {}
export interface Logger extends Record<LoggerType, LoggerMethod> {}

// 判断是否为聚合错误（带有 errors 数组），以便逐条展开打印。
function isAggregateError(error: any): error is Error & { errors: Error[] } {
  return error instanceof Error && Array.isArray(error['errors'])
}

export class Logger {
  // 给文本套上 ANSI 颜色转义序列；exporter.colors 为假时直接返回原文。
  static color(exporter: Exporter, code: number, value: any, decoration = '') {
    if (!exporter.colors) return '' + value
    return `\u001b[3${code < 8 ? code : '8;5;' + code}${exporter.colors >= 2 ? decoration : ''}m${value}\u001b[0m`
  }

  // 根据 name 计算一个稳定的颜色编码：同名日志始终得到同一种颜色，便于肉眼区分来源。
  static code(name: string, level?: false | number) {
    let hash = 0
    // 简单的字符串散列，把 name 映射为一个整数。
    for (let i = 0; i < name.length; i++) {
      hash = (hash << 3) - hash + name.charCodeAt(i) + 13
      hash |= 0
    }
    // 依据颜色深度选用 16 色或 256 色调色板。
    const colors = !level ? [] : level >= 2 ? c256 : c16
    return colors[Math.abs(hash) % colors.length]
  }

  // 把一条 Message 渲染为最终字符串：处理 printf 风格占位符、拼接剩余参数并按行截断。
  static format(exporter: Exporter, message: Message): string {
    const args = message.args.slice()
    // 首参是 Error 时，改用其堆栈并补上 %s 占位符；非字符串时补上 %o 以对象形式打印。
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message
      args.unshift('%s')
    } else if (typeof args[0] !== 'string') {
      args.unshift('%o')
    }

    // 依次替换格式串中的 %x 占位符；%% 转义为字面量 %。
    let format: string = args.shift()
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === '%%') return '%'
      const formatter = exporter.formatters?.[char] ?? defaultFormatters[char]
      if (typeof formatter === 'function') {
        const value = args.shift()
        return formatter(value, exporter, message)
      }
      return match
    })

    // 占位符消耗完后，剩余参数以空格拼接到末尾（对象用 %o 格式化）。
    const oFormatter = exporter.formatters?.o ?? defaultFormatters.o
    for (let arg of args) {
      if (typeof arg === 'object' && arg) {
        arg = oFormatter(arg, exporter, message)
      }
      format += ' ' + arg
    }

    // 逐行按 maxLength 截断，超长部分以 '...' 结尾。
    const { maxLength = 10240 } = exporter
    return format
      .split(/\r?\n/g)
      .map((line) => {
        return (
          line.slice(0, maxLength) + (line.length > maxLength ? '...' : '')
        )
      })
      .join('\n')
  }

  constructor(
    options: LoggerOptions,
    private service: LoggerService,
  ) {
    Object.assign(this, options)
    // 为四种日志类型分别生成绑定了级别的方法。
    this.error = this._method('error', LoggerLevel.ERROR)
    this.info = this._method('info', LoggerLevel.INFO)
    this.warn = this._method('warn', LoggerLevel.WARN)
    this.debug = this._method('debug', LoggerLevel.DEBUG)
  }

  // 生成某一类型的日志方法：负责错误展开、生成 Message 并分发给各导出器。
  private _method(type: LoggerType, level: number): LoggerMethod {
    return (...args: any[]) => {
      // 单个 Error 参数时：优先打印其 cause，或把聚合错误拆成多条分别打印。
      if (args.length === 1 && args[0] instanceof Error) {
        if (args[0].cause) {
          this[type](args[0].cause)
        } else if (isAggregateError(args[0])) {
          args[0].errors.forEach((error) => this[type](error))
          return
        }
      }

      const sn = ++this.service._snMessage
      const ts = Date.now()
      // 遍历所有导出器，只有当目标级别不低于当前日志级别时才输出。
      for (const exporter of this.service.exporters.values()) {
        const targetLevel
          = exporter.levels?.[this.name]
          ?? exporter.levels?.default
          ?? this.level
          ?? LoggerLevel.INFO
        if (targetLevel < level) continue
        const message: Message = {
          sn,
          ts,
          type,
          level,
          name: this.name,
          ...this.meta,
          args,
        }
        exporter.export(message)
      }
    }
  }
}

// 16 色与 256 色调色板：预设一批可读性较好的颜色编码，供 Logger.code 取模选色。
export const c16 = [6, 2, 3, 4, 5, 1]
export const c256 = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62, 63, 68,
  69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113, 129, 134, 135,
  148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172,
  173, 178, 179, 184, 185, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205,
  206, 207, 208, 209, 214, 215, 220, 221,
]

export namespace LoggerService {
  // logger 的拦截配置：可覆盖默认的日志来源名与级别。
  export interface Intercept {
    name?: string
    level?: number
  }
}

// 通过接口合并，让 LoggerService 既能像函数一样调用（返回 Logger），又带有四个快捷方法。
export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
}

/**
 * LoggerService：日志服务。
 *
 * 它本身是「可调用」的——`ctx.logger('foo')` 返回一个具名 Logger；
 * 也可直接 `ctx.logger.info(...)` 走默认 Logger。内部维护一个环形缓冲区
 * （buffer）保存最近的若干条消息，并把消息分发给注册的各个导出器。
 */
export class LoggerService {
  // 缓冲区容量上限
  bufferSize = 1000
  // 最近日志的环形缓冲区
  buffer: Message[] = []
  ctx!: Context

  // 消息与导出器的自增序号计数器
  _snMessage = 0
  _snExporter = 0
  // 已注册的导出器集合（id -> Exporter）
  exporters = new Map<number, Exporter>()

  constructor(ctx: Context) {
    const tracker: Tracker = {
      property: 'ctx',
      noShadow: true,
    }
    // 把自身构造成「可调用对象」：既保留 LoggerService 的方法，又能作为函数被调用。
    const self = createCallable(
      'logger',
      joinPrototype(Object.getPrototypeOf(this), Function.prototype),
      tracker,
    ) as unknown as LoggerService
    Object.assign(self, this)
    self.ctx = ctx
    defineProperty(self, symbols.tracker, tracker)

    // 注册一个默认导出器：把消息写入环形缓冲区，并在超出容量时丢弃最旧的消息。
    self.exporter({
      colors: 3,
      export: (message) => {
        self.buffer.push(message)
        // for better performance
        const overflow = self.buffer.length - self.bufferSize
        if (overflow === 1) {
          self.buffer.shift()
        } else if (overflow > 1) {
          self.buffer.splice(0, overflow)
        }
      },
    })

    return self
  }

  // 注册一个导出器，返回一个可注销它的 effect（随上下文卸载自动移除）。
  exporter(exporter: Exporter) {
    return this.ctx.effect(() => {
      const id = ++this._snExporter
      this.exporters.set(id, exporter)
      return () => this.exporters.delete(id)
    }, 'ctx.logger.exporter()')
  }

  // 沿 intercept 原型链收集 logger 的各层配置并合并，得到最终生效的配置。
  private _resolveConfig(): LoggerService.Intercept {
    let intercept = this.ctx[symbols.intercept]
    const configs: LoggerService.Intercept[] = []
    while ('logger' in intercept) {
      if (Object.hasOwn(intercept, 'logger')) {
        configs.unshift(intercept['logger'])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return Object.assign({}, ...configs)
  }

  // `ctx.logger(name)` 的实际入口：解析配置、推断来源名，并创建对应的 Logger。
  [symbols.invoke](name?: string): Logger {
    const config = this._resolveConfig()
    // 优先使用调用点（def site）的 ctx，从而正确归属日志来源。
    const caller = (this as any)[symbols.caller] as Context | undefined
    const fiber = (caller ?? this.ctx).fiber
    // 名称来源优先级：显式传入 > 拦截配置 > 由 fiber 名连字符化推断。
    name ??= config.name
    name ??= hyphenate(fiber.name)
    return new Logger(
      {
        name,
        level: config.level,
        meta: { fiber: new WeakRef(fiber) },
      },
      this,
    )
  }

  static {
    // 在原型上批量生成 error/info/warn/debug 快捷方法：等价于 `ctx.logger()[type](...)`。
    for (const type of ['error', 'info', 'warn', 'debug'] as const) {
      (LoggerService.prototype as any)[type] = function (
        this: LoggerService,
        ...args: any[]
      ) {
        return (this as any)()[type](...args)
      }
    }
  }
}
