/* eslint-disable no-console */
/**
 * cordis 插件形态与服务声明示例
 * 运行：npx tsx example-plugin-forms.ts
 *
 * 覆盖点：
 *   1. 三种插件形态 —— 函数插件 / 类插件 / 对象插件（apply）
 *   2. @Inject 装饰器 —— 在类插件上声明依赖注入
 *   3. ctx.provide  —— 不借助 Service 基类，直接声明并提供一个服务
 *   4. ctx.accessor —— 声明一个「虚拟属性」（getter/setter）
 *   5. ctx.mixin    —— 把服务上的方法混入到 ctx，直接 ctx.xxx() 调用
 */
import { Context, Inject, Service } from 'cordis'

// 一个基础「配置中心」服务，供后面的插件注入。
class Config extends Service {
  private data: Record<string, string> = { env: 'prod' }

  constructor(ctx: Context) {
    super(ctx, 'config')
  }

  read(key: string) {
    return this.data[key]
  }
}

declare module 'cordis' {
  interface Context {
    config: Config
    version: string // 供 accessor 演示
  }
}

async function main() {
  const ctx = new Context()
  ctx.plugin(Config)

  // ============ 1. 三种插件形态 ============
  console.log('========== 三种插件形态 ==========\n')

  // (a) 函数插件：最简单，(ctx, config) => void
  function funcPlugin(_ctx: Context, config: { tag: string }) {
    console.log(`   [函数插件] 激活，tag = ${config.tag}`)
  }
  ctx.plugin(funcPlugin, { tag: 'F' })

  // (b) 对象插件：带 apply 方法的普通对象
  const objectPlugin = {
    name: 'objectPlugin',
    apply() {
      console.log('   [对象插件] 通过 apply() 激活')
    },
  }
  ctx.plugin(objectPlugin)

  // (c) 类插件 + @Inject：声明依赖 config，就绪后才激活
  @Inject('config')
  class ClassPlugin {
    constructor(ctx: Context) {
      // 能进构造函数说明 config 已就绪。
      console.log('   [类插件] 激活，读取 config.env =', ctx.config.read('env'))
    }
  }
  // 注意「激活时机」的差异：
  //   - 函数插件 / 对象插件「无依赖」，plugin() 时同步立即执行；
  //   - ClassPlugin 带 @Inject('config')「有依赖」，激活是「异步驱动」的——
  //     即使 config 早已加载好（见上方 ctx.plugin(Config)），它也不会同步激活，
  //     而要走「依赖满足 → notify 事件 → _reload → 状态机收敛」这条异步链路。
  // 所以这里不能只用 `await Promise.resolve()`（仅让出一个微任务 tick，不够走完
  // 整个加载流程），否则本段结束时 ClassPlugin 还没激活，日志会「跑到后面」输出。
  // 用 fiber.await() 循环等待其 inertia 收敛到稳定态，输出顺序才与书写顺序一致。
  const classFiber = ctx.plugin(ClassPlugin)
  await classFiber.await()
  console.log('')

  // ============ 2. ctx.provide：不用 Service 基类也能提供服务 ============
  console.log('========== ctx.provide / accessor / mixin ==========\n')

  await ctx.plugin(async (ctx: Context) => {
    // ── provide：不借助 Service 基类，直接声明并提供一个全新服务 clock ──
    // 返回的 dispose 会在插件卸载时移除该服务。
    ctx.provide('clock', { now: () => 12345 })
    console.log('   provide 后 ctx.clock.now() =', (ctx as any).clock.now())

    // ── accessor：声明一个「虚拟属性」version，读写走自定义 get/set ──
    let _version = '1.0.0'
    ctx.accessor('version', {
      get: () => _version,
      set: (value: string) => {
        _version = value
        return true
      },
    })
    console.log('   accessor 读取 ctx.version =', ctx.version)
    ctx.version = '2.0.0'
    console.log('   写入后 ctx.version =', ctx.version)

    // ── mixin：把 config 服务的 read 方法混入到 ctx，可直接 ctx.readConfig() ──
    // mixin 内部会读取 ctx.config，因此需先用 ctx.inject 声明依赖，等它就绪再混入。
    ctx.inject(['config'], (ctx) => {
      ctx.mixin('config', { read: 'readConfig' })
      console.log('   mixin 后 ctx.readConfig("env") =', (ctx as any).readConfig('env'))
    })
  }).await()

  console.log('\n—— 插件形态演示结束 ——')
}

main()
