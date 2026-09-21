/* eslint-disable no-console */
/**
 * cordis 插件配置校验（Plugin.Config）示例
 * 运行：npx tsx example-plugin-config.ts
 *
 * 覆盖点：
 *   1. 无 Config —— 插件不声明 Config，config 原样透传，永不校验
 *   2. 有 Config —— 用 schemastery 声明 schema，加载时自动「校验 + 规范化」
 *   3. 校验失败 —— 传入非法 config 会抛 ValidationError
 *   4. 默认值   —— schema 里的 .default() 会在规范化时补齐缺省字段
 *
 * 关键链路（见源码注释）：
 *   plugin.Config → runtime.Config（registry.ts）
 *     → fiber 加载时 resolveConfig(runtime, config)（fiber.ts）
 *       → 有 Config：校验/规范化；无 Config：原样返回
 */
import { Context } from 'cordis'
import z from 'schemastery'

async function main() {
  const ctx = new Context()

  // ============ 1. 无 Config：config 原样透传，不做任何校验 ============
  console.log('========== 无 Config 的插件 ==========\n')

  // 这个插件没有声明 Config，所以 resolveConfig 里 `if (!runtime.Config) return config`
  // 直接命中——传什么就是什么，哪怕字段完全不合理也不会报错。
  function plainPlugin(_ctx: Context, config: any) {
    console.log('   [无 Config] 收到的 config =', JSON.stringify(config))
  }
  // 插件激活是「异步驱动」的，用 fiber.await() 等它收敛，日志顺序才与书写顺序一致。
  await ctx.plugin(plainPlugin, { anything: 'goes', 乱传: 123 } as any).await()
  console.log('')

  // ============ 2. 有 Config：自动校验 + 规范化（补默认值） ============
  console.log('========== 有 Config 的插件（合法配置） ==========\n')

  interface ServerConfig {
    host: string
    port?: number
  }

  // 对象插件形态：直接把 Config 挂成属性。
  const serverPlugin = {
    name: 'server',
    // 声明 schema：host 必填，port 可选且默认 3000。
    Config: z.object({
      host: z.string(),
      port: z.number().default(3000),
    }) as z<ServerConfig>,
    apply(_ctx: Context, config: ServerConfig) {
      // 注意 port 并未传入，却能读到 3000 —— 说明 config 已被 schema「规范化」过。
      console.log(`   [有 Config] 规范化后 host=${config.host} port=${config.port}`)
    },
  }
  // 只传 host，故意省略 port，观察默认值补齐。
  await ctx.plugin(serverPlugin, { host: 'localhost' }).await()
  console.log('')

  // ============ 3. 校验失败：非法 config 抛 ValidationError ============
  console.log('========== 有 Config 的插件（非法配置） ==========\n')

  try {
    // port 期望 number，这里故意传字符串，触发校验失败。
    // 注意：校验发生在 fiber 的 effect 回调里，错误被存入 _error 而非同步抛出，
    // 因此必须 await fiber.await() 才能把它 re-throw 出来（见 fiber.ts 的 await/_reload）。
    await ctx.plugin(serverPlugin, { host: 'localhost', port: 'oops' } as any).await()
  } catch (error) {
    console.log('   [校验失败] 捕获到错误：')
    console.log('   ' + (error as Error).message.split('\n').join('\n   '))
  }

  console.log('\n—— 插件配置校验演示结束 ——')
}

main()
