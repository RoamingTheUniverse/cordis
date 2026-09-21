/* eslint-disable no-console */
/**
 * cordis 生命周期与注册表示例：Fiber 状态机 + ctx.registry 查询
 * 运行：npx tsx example-lifecycle.ts
 *
 * 覆盖点：
 *   1. Fiber 状态机  —— PENDING → LOADING → ACTIVE → DISPOSED
 *   2. fiber.await() —— 等待状态收敛到稳定
 *   3. fiber.update()—— 更新配置并自动重启
 *   4. fiber.restart()— 强制重启（先卸载再加载）
 *   5. fiber.getEffects() — 查看该 fiber 名下登记的副作用
 *   6. ctx.registry  —— 插件注册表的查询能力（size/has/get/delete）
 *
 * FiberState 枚举：PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5
 */
import { Context, FiberState } from 'cordis'

// FiberState 是 const enum（无运行时对象），不能用 FiberState[值] 反向取名，
// 这里手动维护「数值 → 名称」映射，索引与枚举值一一对应。
const STATE_NAMES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const
const stateName = (state: FiberState) => STATE_NAMES[state]

// 一个「可配置」的插件：读取 config.label，注册一个副作用便于观察生命周期。
function greeterPlugin(ctx: Context, config: { label: string }) {
  console.log(`   [greeter] 激活，label = "${config.label}"`)
  // 注册一个副作用，卸载时会打印清理日志（LIFO 顺序回收）。
  ctx.effect(() => {
    console.log(`   [greeter] 副作用已登记（label=${config.label}）`)
    return () => console.log(`   [greeter] 副作用被清理（label=${config.label}）`)
  })
}

async function main() {
  const ctx = new Context()

  // ============ 第一部分：Fiber 状态机 ============
  console.log('========== Fiber 生命周期 ==========\n')

  console.log('① 加载插件，观察状态迁移')
  const fiber = ctx.plugin(greeterPlugin, { label: 'v1' })
  // 无依赖插件会立即进入加载，但状态机异步收敛，此刻可能是 LOADING。
  console.log('   刚 plugin() 后 state =', stateName(fiber.state))

  // fiber.await()：循环等待进行中的 inertia，直到收敛为稳定状态。
  await fiber.await()
  console.log('   await() 收敛后 state =', stateName(fiber.state), '（应为 ACTIVE）\n')

  // ② getEffects：查看该 fiber 名下登记了哪些副作用。
  console.log('② getEffects —— 查看名下副作用')
  for (const meta of fiber.getEffects()) {
    console.log('   副作用:', meta.label, JSON.stringify(meta))
  }
  console.log('')

  // ③ update：更新配置，内部会走 internal/update（waterfall）并自动 restart。
  console.log('③ update —— 更新配置并自动重启')
  fiber.update({ label: 'v2' })
  await fiber.await()
  console.log('   update 后 state =', stateName(fiber.state), '\n')

  // ④ restart：强制重启（先卸载旧副作用，再重新加载）。
  console.log('④ restart —— 强制重启')
  await fiber.restart()
  console.log('   restart 后 state =', stateName(fiber.state), '\n')

  // ============ 第二部分：ctx.registry 注册表 ============
  console.log('========== registry 注册表查询 ==========\n')

  // 再加载一个匿名插件，让注册表里有多个 runtime。
  const fiber2 = ctx.plugin(() => {
    console.log('   [anonymous] 激活')
  })
  await fiber2.await()

  console.log('⑤ registry 查询能力')
  console.log('   registry.size =', ctx.registry.size, '（已注册的插件种类数）')
  console.log('   has(greeterPlugin) =', ctx.registry.has(greeterPlugin))
  const runtime = ctx.registry.get(greeterPlugin)
  console.log('   get(greeterPlugin).fibers 数量 =', runtime?.fibers.length)
  console.log('   注册表里的插件名列表 =', Array.from(ctx.registry.keys(), (fn) => fn.name || '(anonymous)'))
  console.log('')

  // ⑥ dispose：卸载插件，观察副作用被逆序清理，注册表随之收缩。
  console.log('⑥ dispose —— 卸载 greeterPlugin')
  await fiber.dispose()
  console.log('   dispose 后 state =', stateName(fiber.state), '（应为 DISPOSED）')
  console.log('   has(greeterPlugin) =', ctx.registry.has(greeterPlugin), '（应为 false）\n')

  console.log('—— 生命周期演示结束 ——')
}

main()
