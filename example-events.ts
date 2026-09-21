/* eslint-disable promise/param-names */
/* eslint-disable no-console */
/**
 * cordis 事件总线示例：on / once / emit / parallel / serial / bail / waterfall
 * 运行：npx tsx example-events.ts
 *
 * 五种分发模式一图流：
 *   - emit      —— 同步依次触发，忽略返回值（最常用的「广播」）
 *   - parallel  —— 并发触发、等待全部完成，聚合错误为 AggregateError
 *   - serial    —— 串行 await，某个监听「命中」（返回非 null/false/undefined）就短路返回
 *   - bail      —— 同步版 serial，命中即短路
 *   - waterfall —— 洋葱式中间件，靠 next() 逐层向内传递
 *
 * 注：cordis 的事件名默认走类型表 Events，自定义事件用 `as any` 绕过类型即可。
 */
import { Context } from 'cordis'

async function main() {
  const ctx = new Context()

  // ── 1. emit：同步广播，不关心返回值 ──
  console.log('① emit —— 同步依次触发所有监听器')
  ctx.on('ping' as any, (n: number) => console.log('   监听 A 收到:', n))
  ctx.on('ping' as any, (n: number) => console.log('   监听 B 收到:', n))
  ctx.emit('ping' as any, 42)
  console.log('')

  // ── 2. once：只触发一次，触发后自动注销 ──
  console.log('② once —— 只响应第一次')
  ctx.once('boot' as any, () => console.log('   boot 首次触发（之后不再响应）'))
  ctx.emit('boot' as any)
  ctx.emit('boot' as any) // 第二次无输出
  console.log('')

  // ── 3. parallel：并发触发，等待所有监听完成 ──
  console.log('③ parallel —— 并发触发并等待全部完成')
  ctx.on('load' as any, async () => {
    await new Promise((r) => setTimeout(r, 30))
    console.log('   慢监听（30ms）完成')
  })
  ctx.on('load' as any, async () => {
    console.log('   快监听（0ms）完成')
  })
  await ctx.parallel('load' as any)
  console.log('   —— 所有监听均已完成 ✅\n')

  // ── 4. serial：串行 await，命中即短路 ──
  // 「命中」= 返回值不是 null/false/undefined。这里第二个监听返回结果，后续不再执行。
  console.log('④ serial —— 串行触发，命中就短路返回')
  ctx.on('find' as any, () => {
    console.log('   查询源 1：未命中（返回 undefined）')
    return undefined
  })
  ctx.on('find' as any, () => {
    console.log('   查询源 2：命中，返回结果')
    return 'result-from-2'
  })
  ctx.on('find' as any, () => {
    console.log('   查询源 3：不会被执行（已短路）')
    return 'result-from-3'
  })
  const found = await ctx.serial('find' as any)
  console.log('   最终结果 =', found, '\n')

  // ── 5. bail：同步版 serial ──
  console.log('⑤ bail —— 同步串行，命中即短路（无需 await）')
  ctx.on('check' as any, (x: number) => (x < 0 ? '负数不合法' : undefined))
  ctx.on('check' as any, (x: number) => (x > 100 ? '超出上限' : undefined))
  console.log('   check(-1)  =>', ctx.bail('check' as any, -1))
  console.log('   check(200) =>', ctx.bail('check' as any, 200))
  console.log('   check(50)  =>', ctx.bail('check' as any, 50), '（无命中）\n')

  // ── 6. waterfall：洋葱式中间件 ──
  // 每个监听器最后一个参数是 next()，调用它才会进入下一层；不调用则短路。
  console.log('⑥ waterfall —— 洋葱模型，靠 next() 逐层深入')
  ctx.on('request' as any, (payload: string, next: () => any) => {
    console.log('   中间件 1 进入，payload =', payload)
    const result = next() // 深入内层
    console.log('   中间件 1 离开')
    return '1-' + result
  })
  ctx.on('request' as any, (payload: string, next: () => any) => {
    console.log('   中间件 2 进入')
    const result = next()
    console.log('   中间件 2 离开')
    return '2-' + result
  })
  // 最后一个参数（inner）是「洋葱最内核」，所有中间件都放行后才执行。
  const output = ctx.waterfall('request' as any, 'hello', () => {
    console.log('   ★ 到达最内层，生成响应')
    return 'RESPONSE'
  })
  console.log('   最终返回 =', output, '\n')

  console.log('—— 事件总线演示结束 ——')
}

main()
