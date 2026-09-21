/* eslint-disable no-console */
/**
 * cordis 进阶示例：isolate（服务隔离）与 intercept（拦截配置）
 * 运行：npx tsx example-isolate-intercept.ts
 *
 * - isolate  —— 让「同名服务」在不同子树各存一份、互不可见
 * - intercept —— 同一个服务实例，被不同 ctx 消费时读到不同配置
 */
import { Context, Service } from 'cordis'

// ============ 第一部分：isolate ============

// 一个简单的「存储」服务，带一个 tag 便于区分是哪一份实例。
class Store extends Service {
  public tag = ''
  constructor(ctx: Context) {
    super(ctx, 'store')
  }
}

declare module 'cordis' {
  interface Context {
    store: Store
    greeter: Greeter
  }
}

function isolateDemo() {
  console.log('========== isolate 演示 ==========\n')
  const root = new Context()

  // 从 root 派生两个「隔离域」，各自拥有独立的 store 命名空间。
  const ctxA = root.isolate('store')
  const ctxB = root.isolate('store')

  // 在两个隔离域里分别提供各自的 store 实例。
  const storeA = new Store(ctxA)
  storeA.tag = 'A'
  const storeB = new Store(ctxB)
  storeB.tag = 'B'

  console.log('ctxA.store.tag =', ctxA.store?.tag, '（期望 A）')
  console.log('ctxB.store.tag =', ctxB.store?.tag, '（期望 B）')
  console.log('两个 store 是同一个实例吗？', ctxA.store === ctxB.store, '（期望 false）')
  console.log('root.store 能看到吗？', root.store?.tag, '（期望 undefined —— 隔离域外看不到）\n')
}

// ============ 第二部分：intercept ============

// 一个「问候」服务：hello() 会读取「使用点 ctx」上注入的配置。
class Greeter extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  hello(name: string) {
    // resolveConfig 会沿「使用点 ctx」的 intercept 原型链收集配置。
    // 关键：这里的 this.ctx 是 use site（调用方 ctx），而非 def site。
    const config: any = this[Service.resolveConfig]()
    const greeting = config.greeting ?? 'Hello'
    return `${greeting}, ${name}!`
  }
}

function interceptDemo() {
  console.log('========== intercept 演示 ==========\n')
  const root = new Context()

  // 只提供「一个」greeter 实例。
  new Greeter(root)

  // 默认调用：没有注入任何配置。
  console.log('root.greeter.hello:', root.greeter.hello('World'))

  // 派生一个 ctx，为 greeter 注入中文问候语配置。
  const ctxCn = root.intercept('greeter', { greeting: '你好' } as any)
  console.log('ctxCn.greeter.hello:', ctxCn.greeter.hello('世界'))

  // 再派生一层，叠加另一种配置（intercept 沿原型链逐层合并/覆盖）。
  const ctxJp = ctxCn.intercept('greeter', { greeting: 'こんにちは' } as any)
  console.log('ctxJp.greeter.hello:', ctxJp.greeter.hello('世界'))

  // 原 root 完全不受影响（配置只向下透传、不向上污染）。
  console.log('root.greeter.hello（再次）:', root.greeter.hello('World'))
  console.log('\n注意：全程只有一个 greeter 实例，靠 use site 读到不同配置 ✨')
}

isolateDemo()
interceptDemo()
