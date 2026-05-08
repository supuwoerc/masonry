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

`#initWorker()` 中展示了 OffscreenCanvas 转移和 items 标准化的核心逻辑：

```typescript
// src/core/masonry.ts
async #initWorker() {
  try {
    this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
      type: 'module',
    })
    const canvas = this.#config.core.canvas
    // 关键：transferControlToOffscreen 后主线程对该 canvas 的所有渲染操作都会失效
    const offscreenCanvas = canvas.transferControlToOffscreen()

    // ─── 构建 SetupPayload：只传递可序列化的纯数据 ───
    const payload: SetupPayload = {
      offscreenCanvas,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      config: { core: { backgroundColor, style, layout, limit, timeout } },
      dpr: window.devicePixelRatio || 1,
    }

    // ─── Items 标准化：三种输入格式的不同处理路径 ───
    const items = this.#config.core.items
    if (items?.length) {
      if (items[0] instanceof ImageBitmap) {
        // 路径 1：已预加载的 ImageBitmap → 直接传给 Worker
        payload.config.core.items = items as ImageBitmap[]
      } else {
        // 路径 2：URL 字符串或 ItemDescriptor → 只传数量和尺寸
        const descriptors = this.#normalizeItems(items as string[] | ItemDescriptor[])
        payload.config.core.itemCount = descriptors.length
        payload.config.core.itemSizes = descriptors.map((d) => ({ width: d.width, height: d.height }))
        // URL 留在主线程，稍后由 ImageLoader 加载
        this.#pendingUrls = descriptors
      }
    }

    // OffscreenCanvas 作为 Transferable 零拷贝传输（传输后主线程引用失效）
    this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas])
  } catch (error) {
    // Worker 创建失败时降级处理
    this.#useWorker = false
    this.#worker = null
    this.onError(error)
  }
}
```

**设计要点**：

- **Items 双路径**：`ImageBitmap` 可以直接通过 `Transferable` 传输到 Worker（零拷贝），而 URL 字符串不可序列化为 Worker 所需的渲染数据——必须留在主线程异步加载后逐张发送。
- **配置裁剪**：`onClick`、`loadMore`、`onReady` 等函数引用不可序列化，只传纯数据配置到 Worker。
- **try/catch 降级**：Worker 初始化可能因 CSP 策略、不支持等原因失败。降级后标记 `#useWorker = false`，通过 `onError` 通知用户。

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
// src/core/masonry.ts
#queue = new Queue<(() => void) | (() => Promise<void>)>()

async #runTask() {
  if (!this.#isRunning) {
    try {
      this.#isRunning = true
      while (this.#queue.size > 0) {
        const task = this.#queue.dequeue()
        await task?.()
      }
    } finally {
      // try/finally 确保异常安全：即使某个任务抛出错误，
      // #isRunning 也会被重置为 false，不会永久阻塞后续任务入队执行
      this.#isRunning = false
    }
  }
}
```

**设计要点**：

- **`try/finally` 异常安全**：如果 `await task?.()` 抛出异常（如 loadMore 网络超时），没有 finally 的话 `#isRunning` 会永远为 `true`，后续所有入队的任务都不会被执行——队列被永久"卡死"。`finally` 确保无论成功还是失败，锁都会被释放。
- **防重入设计**：`if (!this.#isRunning)` 确保同一时刻只有一个消费循环在运行。多次调用 `#runTask()` 不会启动多个并发消费者——新入队的任务会被当前运行中的 while 循环自动消费。
- **有序执行保证**：`while (this.#queue.size > 0)` 逐个出队执行，配合 `await` 确保每个异步任务完成后再执行下一个。

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

#### 完整实现（`#startAnimationLoop`）

```typescript
// src/core/worker/offscreen-canvas.ts
#animationRunning = false

#startAnimationLoop() {
  if (this.#animationRunning) {
    return  // 防止重复启动：同一时刻只有一个 rAF 循环在运行
  }
  this.#animationRunning = true
  const renderFrame = () => {
    // 步骤 1：处理惯性滚动（每帧衰减速度 + 重新渲染）
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }
    // 步骤 2：检查是否仍有 loading 状态的项目
    const loadingItems = this.#gridItems.filter((item) => item.status !== 'loaded')
    const ids = loadingItems.map((item) => item.id)
    if (ids.length > 0) {
      // idsChanged 优化：只有 loading 项目集合变化时才发送消息
      // 避免每帧重复发送相同的 RenderLoading 请求
      const idsChanged =
        ids.length !== this.#lastLoadingIds.size ||
        ids.some((id) => !this.#lastLoadingIds.has(id))
      if (idsChanged) {
        this.#lastLoadingIds = new Set(ids)
        this.#sendMessage(MessageType.RenderLoading, ids)
      }
    } else {
      this.#lastLoadingIds.clear()
    }
    // 步骤 3：条件退出——没有惯性也没有 loading 项时，停止循环
    const hasWork = this.#isInertiaActive || ids.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false
    }
  }
  renderFrame()  // 立即执行第一帧，不等下一个 vsync
}
```

**设计要点**：

- **`idsChanged` 优化**：占位符渲染是跨线程异步流程（Worker → Main → render → Main → Worker）。如果每帧都发送 `RenderLoading` 消息，会在消息通道中积压大量冗余请求。`idsChanged` 通过 Set 比较确保只在 loading 集合实际变化时才发消息。
- **条件退出避免空转**：`hasWork` 为 false 时直接设置 `#animationRunning = false` 停止循环。这意味着一旦所有图片加载完且无惯性滚动，rAF 循环彻底停止——零 CPU 消耗。后续滚动或新数据到来时会重新调用 `#startAnimationLoop()` 启动。
- **`renderFrame()` 立即调用**：不是 `requestAnimationFrame(renderFrame)` 而是直接 `renderFrame()`。这确保第一帧立即执行，不需要等待下一个 vsync 信号（约 16.7ms 延迟）。

### 3.4 背景层分离（双 Canvas）

Worker 使用两个 Canvas：`#canvas`（主画布）+ `#backgroundCanvas`（背景缓存）

```typescript
// src/core/worker/offscreen-canvas.ts:66-67
#backgroundCanvas!: OffscreenCanvas
#canvas!: OffscreenCanvas
```

**原因**：背景（渐变）每帧不变，分离后避免每帧重新计算渐变 stops → 直接 `drawImage` 拷贝缓存。

#### 渲染管线完整流程（`#handleRerender`）

```typescript
// src/core/worker/offscreen-canvas.ts
#handleRerender() {
  if (this.#context) {
    try {
      // 步骤 1：清除主画布当前帧内容
      this.#clear()
      // 步骤 2：清除背景画布（为重绘做准备）
      this.#clearBackground()
      // 步骤 3：在背景画布上绘制渐变/纯色背景
      this.#handleRenderBackground()
      // 步骤 4：将背景画布内容拷贝到主画布（drawImage 整块复制）
      this.#copyBackground()
      // 步骤 5：保存当前变换矩阵状态
      this.#context.save()
      // 步骤 6：应用滚动偏移（translate 替代逐 item 坐标计算）
      this.#context.translate(-this.#scrollX, -this.#scrollY)
      // 步骤 7：根据模式选择渲染策略
      if (this.#isLoopActive) {
        this.#renderLoopedItems(this.#gridItems)    // 无缝循环：modulo 映射
      } else {
        this.#renderGridItems(this.#getVisibleItems(this.#gridItems))  // 普通模式：视口裁剪
      }
      // 步骤 8：恢复变换矩阵
      this.#context.restore()
    } catch (error) {
      this.#sendError(error)
    }
  }
}
```

**设计要点**：

- **`save()/restore()` 配对**：`translate` 改变了坐标系原点，`restore()` 恢复确保下一帧的背景绘制不受滚动偏移影响。如果忘记 `restore()`，背景会随滚动移动。
- **`translate(-scrollX, -scrollY)` 替代逐 item 偏移**：Canvas 提供矩阵变换 API，一次 `translate` 比 N 个 item 各减去 scrollX/scrollY 更高效——只设置一次 GPU 状态。
- **背景分离的收益**：渐变背景的 `createLinearGradient` + `addColorStop` 调用在像素量大时开销可观。分离到 `#backgroundCanvas` 后，只有 resize/DPR 变化时才重新生成渐变；每帧只需 `drawImage` 一次整块复制（GPU 优化路径）。
- **try/catch 错误边界**：`#sendError` 将异常传回主线程的 `onError` 回调，不让渲染异常导致 Worker 崩溃。

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
