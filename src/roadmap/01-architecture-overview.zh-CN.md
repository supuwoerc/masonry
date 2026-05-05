# 整体架构与设计模式

> 本文档从全局视角介绍 `@supuwoerc/masonry` 的架构设计、线程模型、设计模式和关键技术决策。

## 模块定位

这是项目的顶层架构文档，帮助你理解整个库为什么这样设计、各部分如何协作。

---

## 1. 双线程模型

### 1.1 为什么需要双线程

传统 DOM/Canvas 方案的瓶颈：
- 布局计算（尤其瀑布流 O(n) 遍历）阻塞主线程
- Canvas 绑制大量图片时，`drawImage` 调用密集导致帧率下降
- 滚动事件处理与渲染竞争同一线程

本库的解决方案是将**渲染密集型**工作全部移至 Worker 线程：

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│         主线程 (Main)        │    │       Worker 线程            │
│                             │    │                             │
│ • 事件监听 (scroll/click)   │    │ • 布局计算                   │
│ • 图片资源加载              │    │ • Canvas 渲染                │
│ • 占位符动画生成            │    │ • 惯性滚动物理模拟           │
│ • ResizeObserver            │    │ • 视口裁剪                   │
│ • 消息路由与分发            │    │ • 命中检测 (click)           │
│ • 生命周期管理              │    │ • 无缝循环计算               │
└─────────────────────────────┘    └─────────────────────────────┘
```

### 1.2 线程间通信

通过 `postMessage` + `Transferable` 对象实现：
- **OffscreenCanvas**：初始化时一次性转移（不可逆）
- **ImageBitmap**：每次图片加载完成时零拷贝传输
- **普通消息**：JSON 序列化的 `Message<T>` 结构

### 1.3 为什么选择 OffscreenCanvas

| 方案 | 优势 | 劣势 |
|------|------|------|
| DOM 操作 | 简单直观 | 重排重绘代价高，万级元素不可行 |
| 主线程 Canvas | 无 DOM 开销 | 渲染仍阻塞主线程 |
| **OffscreenCanvas** | **渲染完全不阻塞主线程** | 需要 Worker 通信开销 |

关键代码：
```typescript
// src/core/masonry.ts:160
const offscreenCanvas = canvas.transferControlToOffscreen()
```

---

## 2. 设计模式

### 2.1 Builder 模式

**文件**: `src/core/builder.ts`

提供链式 API 降低配置复杂度：

```typescript
const masonry = new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 } })
  .withInteraction({ onClick: (e) => console.log(e) })
  .withLoader({ pageSize: 20, loadMore: fetchImages })
  .build()
```

**设计意图**：
- 分离配置关注点（core / interaction / loader / placeholder / events）
- 每个 `with*` 方法提供合理默认值
- `build()` 时统一验证，失败则抛出 `MasonryError`

### 2.2 Strategy 模式

**文件**: `src/core/layout/grid-layout.ts`, `src/core/layout/masonry-layout.ts`

统一接口 `LayoutStrategy`：

```typescript
interface LayoutStrategy {
  calculate: (input: LayoutInput) => LayoutResult
}
```

Worker 根据配置选择策略：
```typescript
// src/core/worker/offscreen-canvas.ts:191
this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()
```

**扩展新布局**：只需实现 `LayoutStrategy` 接口，在 Worker 中注册即可。

### 2.3 Observer 模式

项目使用多种观察者/事件机制：

| 观察者 | 用途 | 文件 |
|--------|------|------|
| `ResizeObserver` | 监听 canvas 容器尺寸变化 | `src/core/masonry.ts:82` |
| `matchMedia` | 监听 DPR 变化（浏览器缩放） | `src/core/masonry.ts:296-306` |
| `Worker.onmessage` | 接收 Worker 消息 | `src/core/masonry.ts:161` |
| `globalThis.onmessage` | Worker 内接收主线程消息 | `src/core/worker/offscreen-canvas.ts:105` |
| `AbortController` | 统一管理事件注销 | `src/core/masonry.ts:100` |

### 2.4 Queue 模式（串行任务队列）

**文件**: `src/core/masonry.ts:94`, `src/core/worker/offscreen-canvas.ts:83`

异步任务（loadMore、renderLoading）可能并发到达，通过队列保证有序执行：

```typescript
#queue = new Queue<(() => void) | (() => Promise<void>)>()

async #runTask() {
  if (!this.#isRunning) {
    this.#isRunning = true
    while (this.#queue.size > 0) {
      const task = this.#queue.dequeue()
      await task?.()
    }
    this.#isRunning = false
  }
}
```

**设计意图**：防止并发的 loadMore 和 renderLoading 回调交错执行导致状态不一致。

---

## 3. 关键技术决策

### 3.1 为什么用 ImageBitmap 而非 Image 元素

| Image 元素 | ImageBitmap |
|-----------|-------------|
| 绑定到主线程 DOM | 纯数据对象，无 DOM 依赖 |
| 不可跨线程传输 | 支持 Transferable 零拷贝传输 |
| 每次 drawImage 需解码 | 已预解码，绘制性能更好 |

```typescript
// src/core/image-loader.ts:80
return await createImageBitmap(result) // blob → 预解码位图
```

### 3.2 为什么 Worker 格式选择 IIFE

在 `vite.config.ts` 中配置 `worker.format: 'iife'`：
- IIFE 格式兼容性最好，不依赖 ES Module 加载
- 打包为单文件，避免 Worker 内的模块解析问题
- 部署时无需额外配置 MIME 类型

### 3.3 为什么渲染循环使用 requestAnimationFrame

```typescript
// src/core/worker/offscreen-canvas.ts:507
const renderFrame = () => {
  if (this.#isInertiaActive) { ... }
  if (hasWork) {
    requestAnimationFrame(renderFrame)
  } else {
    this.#animationRunning = false
  }
}
```

- 与显示器刷新率同步（通常 60Hz）
- 页面不可见时自动暂停，节省资源
- 条件退出：无惯性且无 loading 时停止循环，避免空转

### 3.4 背景层分离（双 Canvas）

Worker 使用两个 Canvas：`#canvas`（主画布）+ `#backgroundCanvas`（背景缓存）

```typescript
// src/core/worker/offscreen-canvas.ts:66-67
#backgroundCanvas!: OffscreenCanvas
#canvas!: OffscreenCanvas
```

**原因**：背景（渐变）每帧不变，分离后避免每帧重新计算渐变 stops → 直接 `drawImage` 拷贝缓存。

---

## 4. 模块依赖关系

```
index.ts
  └── core/builder.ts
        └── core/masonry.ts (主编排器)
              ├── core/image-loader.ts
              ├── core/placeholder/*
              ├── helper/validator.ts + core/rules.ts
              └── core/worker/offscreen-canvas.ts (Worker 入口)
                    ├── core/layout/grid-layout.ts
                    ├── core/layout/masonry-layout.ts
                    ├── core/worker/protocol.ts
                    └── helper/background.ts
```

---

## 5. 性能设计总结

| 策略 | 效果 |
|------|------|
| Worker 离屏渲染 | 主线程零渲染阻塞 |
| ImageBitmap Transferable | 零拷贝图片传输 |
| 视口裁剪 | 万级元素只渲染几十个 |
| 背景层缓存 | 避免每帧重新计算渐变 |
| 惯性停止阈值 | 速度 < 0.5px 时停止动画循环 |
| 条件 rAF | 无工作时不空转 |
| debounce resize | 防止高频 resize 消息 |
| p-limit 并发控制 | 避免同时发起过多网络请求 |
