// cordis 核心库的统一出口：把各模块的公共 API 汇总导出。
// 阅读源码时可从这里快速定位每个能力所在的文件。

// Context 上下文类：贯穿全局、承载所有服务的核心对象
export * from './context'
// EventsService 事件总线：on/emit/parallel/serial/bail/waterfall
export * from './events'
// Fiber 纤程：插件的生命周期与副作用（effect）管理单元
export * from './fiber'
// LoggerService 日志服务
export * from './logger'
// RegistryService 注册表：插件的注册与卸载
export * from './registry'
// Service 服务基类：编写可注入服务时继承它
export * from './service'
// 内部工具：Proxy 追踪、symbol 表、错误栈处理等
export * from './utils'
