/* eslint-disable no-console */
/**
 * cordis 核心概念最小示例
 * 运行：npx tsx example-basic.ts
 *
 * 覆盖 4 个核心点：
 *   1. Service —— 写一个可注入服务，自动挂到 ctx 上（ctx.database）
 *   2. inject  —— 插件声明依赖，「依赖就绪」才会激活（依赖驱动）
 *   3. effect  —— 插件里注册的副作用（事件监听），卸载时自动清理
 *   4. dispose —— 卸载插件，观察副作用被回收
 *
 * 注：cordis 的 ctx.logger 默认只写内存缓冲区、不打印到控制台，
 *     所以这里直接用 console.log 输出，方便观察。
 */
import { Context, Service } from 'cordis'

// ── 1. 用 Service 基类写一个「数据库」服务 ──
// 继承 Service 并在 super() 里传入服务名 'database'，实例化时会自动注册到 ctx。
class Database extends Service {
  private store = new Map<string, any>()

  constructor(ctx: Context) {
    super(ctx, 'database')
    console.log('  [Database] 服务已实例化并注册到 ctx')
  }

  set(key: string, value: any) {
    this.store.set(key, value)
  }

  get(key: string) {
    return this.store.get(key)
  }
}

// 通过模块合并，让 TS 知道 ctx 上有 database 属性（运行时靠服务解析，编译期靠这个声明）。
declare module 'cordis' {
  interface Context {
    database: Database
  }
}

// ── 2. 一个消费 database 的业务插件（函数式插件）──
function userPlugin(ctx: Context) {
  // 能进到这里，说明依赖 database 已经就绪（否则该回调根本不会执行）。
  console.log('  [userPlugin] ✅ 激活：database 依赖已就绪')

  ctx.database.set('alice', { age: 20 })
  console.log('  [userPlugin] 写入 alice =', JSON.stringify(ctx.database.get('alice')))

  // ── 3. 注册一个副作用：监听 'tick' 事件 ──
  // 这个监听器「记在 userPlugin 的账上」，插件卸载时会被自动清理。
  ctx.on('tick' as any, () => {
    console.log('  [userPlugin] 🔔 收到 tick 事件')
  })
}
// 声明依赖：只有 database 服务存在时，本插件才会被激活。
userPlugin.inject = ['database']

async function main() {
  // 创建根上下文
  const ctx = new Context()

  // ── 先加载业务插件（此时 database 尚未提供）──
  console.log('① 先加载 userPlugin（依赖未满足，应保持 PENDING、不执行回调）')
  const fiber = ctx.plugin(userPlugin)
  console.log('   userPlugin 当前状态 =', fiber.state, '（0=PENDING）\n')

  // ── 再加载 Database 服务 → 依赖满足，userPlugin 自动被激活 ──
  console.log('② 加载 Database 服务（依赖满足，userPlugin 应自动激活）')
  ctx.plugin(Database)
  // 注意：插件的激活是「异步驱动」的——加载 Database 后，通过 notify 事件才
  // 触发 userPlugin 的 _reload。fiber 状态机异步收敛，await 返回时状态可能
  // 还停在 LOADING，需再让出一个微任务，状态才最终提交为 ACTIVE。
  const active = await fiber
  await Promise.resolve()
  console.log('   userPlugin 当前状态 =', active.state, '（2=ACTIVE）\n')

  // ── 触发一次事件，userPlugin 的监听器应响应 ──
  console.log('③ 触发 tick 事件：')
  ctx.emit('tick' as any)
  console.log('')

  // ── 4. 卸载 userPlugin → 事件监听被自动清理 ──
  console.log('④ 卸载 userPlugin，其副作用（tick 监听）应被自动回收')
  await fiber.dispose()
  console.log('')

  console.log('⑤ 再次触发 tick 事件（应该没有任何响应了）：')
  ctx.emit('tick' as any)
  console.log('   （无输出，说明监听器已被清理 ✅）\n')

  console.log('—— 演示结束 ——')
}

main()
