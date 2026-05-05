# 主线程编排与事件协调

> 本文档介绍 `Masonry` 主类的生命周期、Worker 初始化、消息路由、滚动/点击事件处理和容器自适应机制。

## 模块定位

`Masonry` 类是整个库的核心编排器。它运行在主线程，负责协调所有子系统：Worker 通信、图片加载、占位符渲染、事件监听、容器 resize 响应。

## 涉及源文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/core/masonry.ts` | 520 | 主编排器 |
| `src/core/image-loader.ts` | 90 | 图片加载 |
| `src/core/constant.ts` | 26 | 默认配置 |

---

## 1. 生命周期

### 1.1 构造流程

```
new Masonry(config)
  │
  ├── isCanvasSupported() → 不支持则抛错
  ├── Validator.validate(config) → 不通过则抛错
  ├── #config = config
  └── #init()
        ├── #initPlaceholderRenderer() → 设置占位符渲染器
        ├── #initEvents() → 绑定 onReady / onError
        ├── #initObserver() → ResizeObserver + DPR 监听
        ├── #initScrollListeners() → wheel / pointer 事件
        └── #initWorker() → 创建 Worker + 传输 OffscreenCanvas
```

### 1.2 销毁流程

```typescript
destroy() {
  worker.terminate()        // 终止 Worker
  imageLoader.dispose()     // 取消所有加载
  scrollAbort.abort()       // 注销所有事件监听
  resizeObserver.disconnect() // 断开 Observer
  dprMediaQuery = null      // 释放 matchMedia
  placeholderRenderer.dispose() // 清理占位符资源
}
```

---

## 2. Worker 初始化（`#initWorker`）

### 2.1 创建 Worker

```typescript
this.#worker = new Worker(
  new URL('./worker/offscreen-canvas.ts', import.meta.url),
  { type: 'module' }
)
```

使用 `import.meta.url` 让 Vite 正确解析 Worker 文件路径并打包。

### 2.2 转移 OffscreenCanvas

```typescript
const offscreenCanvas = canvas.transferControlToOffscreen()
```

**关键点**：`transferControlToOffscreen()` 调用后，主线程对该 canvas 的所有绑制操作都会失效。控制权完全转移到 Worker。

### 2.3 构造 SetupPayload

发送给 Worker 的初始化消息包含：

| 字段 | 内容 |
|------|------|
| `offscreenCanvas` | 离屏画布（Transferable） |
| `clientWidth/Height` | 容器 CSS 尺寸 |
| `dpr` | 设备像素比 |
| `config.core` | 背景色、样式、布局模式 |
| `config.interaction` | 滚动配置 |
| `config.loader` | pageSize |

### 2.4 Items 标准化

根据输入类型分流处理：

```
items[0] instanceof ImageBitmap → 直接传入 Worker (payload.config.core.items)
items 是 string[] / ItemDescriptor[] → 转为 {itemCount, itemSizes} + #pendingUrls
```

后者在 Worker 端创建 loading 占位符，主线程异步加载图片后逐张通知 Worker。

---

## 3. 消息路由（`#handleWorkerMessage`）

Worker 发送的消息通过 `onmessage` 到达主线程，按 `type` 分发：

| MessageType | 处理逻辑 |
|-------------|---------|
| `SetupResponse` | 触发 onReady → 发送 Render → 启动图片加载 |
| `LoadMore` | 入队分页加载任务 |
| `RenderLoading` | 入队占位符渲染任务 |
| `RemoveLoading` | 调用 placeholderRenderer.remove(id) |
| `LayoutUpdated` | 回调 onLayoutUpdate |
| `ClickResult` | 回调 onClick |
| `Error` | 回调 onError |

### 3.1 占位符渲染任务（`#handleRenderLoading`）

```
Worker 检测到 loading items → 发送 RenderLoading(ids)
→ Main: 对每个 id 调用 placeholderRenderer.render(width, height, id)
→ 生成 ImageBitmap → 发送 RenderLoadingResponse({bitmap, id}, [bitmap])
→ Worker: 将 bitmap 绘制到对应格子
```

### 3.2 分页加载任务（`#handleLoadMoreTask`）

```
Worker 检测到接近边界 → 发送 LoadMore
→ Main: 调用 loader.loadMore(page, pageSize)
→ 获取新数据 → 加载为 ImageBitmap[]
→ 发送 LoadMoreResponse({page, hasMore, data})
→ Worker: 追加 items → performLayout → rerender
```

---

## 4. 消息发送（`#sendMessage`）

统一的消息发送方法：

```typescript
#sendMessage(type: MessageType, payload: MessagePayload, transfer?: Transferable[]) {
  const message: Message = {
    id: nanoid(),           // 唯一 ID
    type,                   // 消息类型
    payload,                // 负载数据
    timestamp: Date.now(),  // 时间戳
  }
  this.#worker?.postMessage(message, transfer ?? [])
}
```

`transfer` 数组用于指定 Transferable 对象（OffscreenCanvas、ImageBitmap），传输后原引用失效。

---

## 5. 滚动事件处理

### 5.1 事件监听注册

```typescript
canvas.addEventListener('wheel', handler, { passive: false, signal })
canvas.addEventListener('pointerdown', handler, { signal })
canvas.addEventListener('pointermove', handler, { signal })
canvas.addEventListener('pointerup', handler, { signal })
canvas.addEventListener('pointercancel', handler, { signal })
```

所有监听器通过 `AbortController.signal` 统一管理，`destroy()` 时一次性注销。

### 5.2 Wheel 事件

```typescript
#handleWheel(e: WheelEvent) {
  e.preventDefault()  // 阻止页面滚动
  // 根据 disabled 配置过滤方向
  const deltaX = scroll?.disabled?.horizontal ? 0 : e.deltaX
  const deltaY = scroll?.disabled?.vertical ? 0 : e.deltaY
  // 有增量则发送消息
  if (deltaX !== 0 || deltaY !== 0) {
    this.#sendMessage(MessageType.Scroll, { deltaX, deltaY })
  }
}
```

### 5.3 Pointer 事件（触控/拖拽）

三阶段处理：

1. **pointerdown**：记录起始位置，捕获指针
2. **pointermove**：计算增量，发送 Scroll 消息
3. **pointerup**：判断是拖拽还是点击（位移 < 5px 为点击）

```typescript
// 点击判定：起始位置与结束位置的距离 < 5px
const dx = Math.abs(e.clientX - this.#pointerState.startX)
const dy = Math.abs(e.clientY - this.#pointerState.startY)
if (dx < 5 && dy < 5 && this.#config.interaction?.onClick) {
  // 视为点击 → 发送 Click 消息给 Worker 做命中检测
}
```

### 5.4 点击处理流程

```
pointerup (位移<5px) → 计算 canvas 相对坐标 → sendMessage(Click, {x, y})
→ Worker: handleClick → 命中检测 → sendMessage(ClickResult, {item, index, row, column})
→ Main: handleClickResult → 调用 onClick 回调
```

---

## 6. 容器自适应

### 6.1 ResizeObserver

```typescript
#resizeObserver = new ResizeObserver(() => this.#resize())
```

监听 canvas 元素的尺寸变化。

### 6.2 DPR 监听

使用 `matchMedia` 递归监听设备像素比变化：

```typescript
#initDprListener() {
  const updateDpr = () => {
    this.#resize()
    this.#dprMediaQuery?.removeEventListener('change', updateDpr)
    this.#initDprListener() // 递归重建，因为 DPR 值变了
  }
  this.#dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  this.#dprMediaQuery.addEventListener('change', updateDpr)
}
```

**为什么递归重建**：`matchMedia` 绑定的是特定 DPR 值（如 `2dppx`），当 DPR 变化后需要监听新的值。

### 6.3 Resize 防抖

```typescript
#resize = debounce(100 / 6, () => {
  this.#sendMessage(MessageType.Resize, {
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
    dpr: window.devicePixelRatio || 1,
  })
})
```

约 16.7ms 防抖，对齐一帧的时间，避免连续 resize 产生大量消息。

---

## 7. 异步任务队列

### 7.1 为什么需要队列

Worker 可能在短时间内连续发送 `LoadMore` 和 `RenderLoading` 消息。如果不排队：
- 两个 loadMore 可能同时执行，导致重复请求
- renderLoading 和 loadMore 交错执行可能导致状态不一致

### 7.2 实现

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

任务入队后调用 `#runTask()`，如果已经在运行则新任务自动排队等待。

---

## 8. 图片加载流程

### 8.1 触发时机

在 `SetupResponse` 消息处理后立即启动：

```typescript
case MessageType.SetupResponse:
  this.onReady?.(this)
  this.#sendMessage(MessageType.Render, null)
  this.#loadImages()  // ← 启动异步图片加载
```

### 8.2 加载与通知

```typescript
#loadImages() {
  this.#imageLoader = new ImageLoader(this.#config.imageLoad)
  this.#imageLoader.loadBatch(batch, (index, bitmap, width, height) => {
    const payload: ImageLoadedPayload = { index, bitmap, width, height }
    this.#sendMessage(MessageType.ImageLoaded, payload, [bitmap])
  })
}
```

每张图片加载完成后立即通知 Worker，Worker 更新对应 item 并重新渲染。
