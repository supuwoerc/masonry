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

### 2.1 完整实现

```typescript
// src/core/masonry.ts
async #initWorker() {
  try {
    // 使用 import.meta.url 让 Vite 正确解析 Worker 文件路径并打包
    this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
      type: 'module',
    })
    const canvas = this.#config.core.canvas
    // 关键：transferControlToOffscreen 后主线程对该 canvas 的所有绑制操作都会失效
    const offscreenCanvas = canvas.transferControlToOffscreen()

    // 注册消息处理器
    this.#worker.onmessage = this.#handleWorkerMessage.bind(this)
    this.#worker.onerror = (e: Event) => {
      this.onError(new MasonryError(`Worker error: ${(e as ErrorEvent).message || 'unknown'}`))
    }

    // ─── 构建 SetupPayload：只传递可序列化的纯数据 ───
    const payload: SetupPayload = {
      offscreenCanvas,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      config: {
        core: {
          backgroundColor: this.#config.core.backgroundColor,
          style: this.#config.core.style,
          layout: this.#config.core.layout,
          limit: this.#config.core.limit,
          timeout: this.#config.core.timeout,
        },
      },
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
        payload.config.core.itemSizes = descriptors.map((d) => ({
          width: d.width,
          height: d.height,
        }))
        // URL 留在主线程，稍后由 ImageLoader 加载
        this.#pendingUrls = descriptors
      }
    }

    // ─── 配置裁剪：排除不可序列化的函数 ───
    if (this.#config.interaction) {
      payload.config.interaction = {
        scroll: this.#config.interaction?.scroll,
      }
    }
    if (this.#config.loader) {
      payload.config.loader = {
        pageSize: this.#config.loader.pageSize,
      }
    }

    // OffscreenCanvas 作为 Transferable 零拷贝传输
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

- **`type: 'module'`**：让 Worker 使用 ESM 语法，配合 Vite 的构建管线。Vite 会自动将 Worker 代码单独打包为独立 chunk。
- **`transferControlToOffscreen()` 不可逆**：调用后主线程永远无法再对该 canvas 进行绑制操作。这是浏览器的硬性限制，确保只有一个线程拥有绑制权。
- **try/catch 降级**：如果 Worker 初始化失败（CSP 策略阻止、Blob URL 不可用等），不会导致整个实例崩溃，而是通过 `onError` 通知用户并标记 `#useWorker = false`。
- **配置裁剪**：`onClick`、`loadMore`、`onReady` 等函数引用不可序列化（无法通过 `postMessage` 传输），必须在主线程保留。Worker 只需要纯数据配置。

---

## 3. 消息路由（`#handleWorkerMessage`）

### 3.1 完整实现

```typescript
// src/core/masonry.ts
#handleWorkerMessage(event: MessageEvent<Message>) {
  const { type, payload } = event.data
  switch (type) {
    case MessageType.SetupResponse:
      // 初始化完成：通知用户 → 触发首帧渲染 → 启动图片加载
      this.onReady?.(this)
      this.#sendMessage(MessageType.Render, null)
      this.#loadImages()
      break
    case MessageType.LoadMore:
      // Worker 请求加载更多数据 → 入队异步任务
      this.#handleLoadMoreTask()
      this.#runTask()
      break
    case MessageType.RenderLoading:
      // Worker 请求渲染占位符 → 入队占位符渲染任务
      this.#handleRenderLoading(payload as Array<string>)
      this.#runTask()
      break
    case MessageType.RemoveLoading:
      // 某个 item 加载完成 → 释放其占位符资源
      this.#placeholderRenderer.remove(payload as string)
      break
    case MessageType.LayoutUpdated:
      // 布局变化 → 通知上层应用（如需更新容器尺寸）
      this.#config.interaction?.onLayoutUpdate?.(payload as LayoutUpdatedPayload)
      break
    case MessageType.ClickResult:
      // Worker 返回命中检测结果 → 触发 onClick 回调
      this.#handleClickResult(payload as ClickResultPayload)
      break
    case MessageType.Error:
      // Worker 内部错误 → 传递给 onError
      this.onError(payload)
      break
  }
}
```

**设计要点**：

- **`SetupResponse` 是启动信号**：它触发三个动作——通知用户就绪、发送 Render 启动渲染循环、启动异步图片加载。这三个动作的顺序很重要：先通知用户可以交互，再启动渲染（此时可能显示占位符），最后开始加载真实图片。
- **`LoadMore` 和 `RenderLoading` 入队执行**：这两类任务涉及异步操作（网络请求、占位符渲染），通过队列确保串行执行，避免并发问题。
- **`RemoveLoading` 直接执行**：释放占位符资源是同步操作且无副作用，不需要排队。

### 3.2 占位符渲染任务（`#handleRenderLoading`）

```typescript
// src/core/masonry.ts
#handleRenderLoading(ids: Array<string>) {
  if (ids.length > 0) {
    this.#queue.enqueue(async () => {
      try {
        const { width, height } = this.#config.core.style
        // 并行渲染所有 loading 占位符
        const tasks = ids.map(async (id) => {
          const bitmap = await this.#placeholderRenderer.render(width, height, id)
          // 验证 bitmap 有效后才发送（防止空位图导致 Worker 绘制异常）
          if (bitmap.width > 0 && bitmap.height > 0) {
            this.#sendMessage(MessageType.RenderLoadingResponse, { bitmap, id }, [bitmap])
          }
        })
        await Promise.all(tasks)
      } catch (error) {
        this.onError(error)
      }
    })
  }
}
```

**设计要点**：

- **`Promise.all(tasks)` 并行渲染**：多个占位符可以同时渲染（各自有独立的 Canvas），不需要串行等待。
- **`bitmap.width > 0 && bitmap.height > 0` 校验**：`createImageBitmap` 可能在边缘情况下（canvas 尺寸为 0）返回空位图。发送空位图到 Worker 会导致 `drawImage` 异常。
- **bitmap 作为 Transferable 传输**：`[bitmap]` 让 ImageBitmap 零拷贝转移到 Worker，主线程的 bitmap 引用随即失效（宽高变为 0）。

### 3.3 分页加载任务（`#handleLoadMoreTask`）

```typescript
// src/core/masonry.ts
#handleLoadMoreTask() {
  this.#queue.enqueue(async () => {
    // 三重防护：无 loader / 正在加载 / 已无更多数据
    if (!this.#config?.loader || this.#pagination.loading || !this.#pagination.hasMore) {
      return
    }
    try {
      this.#pagination.loading = true  // 防重入锁
      const { loadMore, pageSize } = this.#config.loader
      // 调用用户提供的 loadMore 函数
      const list = await loadMore(this.#pagination.page, pageSize)

      const message: LoadMoreResponsePayload = {
        page: this.#pagination.page,
        hasMore: list.length >= pageSize,  // 启发式判断：返回量 < pageSize → 无更多数据
        data: [],
      }

      if (list && list.length > 0) {
        this.#pagination.page++
        if (list[0] instanceof ImageBitmap) {
          // 路径 A：loadMore 直接返回 ImageBitmap（预加载场景）
          message.data = list as ImageBitmap[]
        } else {
          // 路径 B：返回 URL/ItemDescriptor → 需要先加载为 ImageBitmap
          const descriptors = this.#normalizeItems(list as string[] | ItemDescriptor[])
          const loader = this.#imageLoader ?? new ImageLoader(this.#config.imageLoad)
          const bitmaps: ImageBitmap[] = []
          await loader.loadBatch(
            descriptors.map((d, i) => ({
              url: d.url,
              index: i,
              width: d.width,
              height: d.height,
            })),
            (_index, bitmap) => {
              bitmaps.push(bitmap)
            },
          )
          message.data = bitmaps
        }
      }

      if (list.length < pageSize) {
        this.#pagination.hasMore = false
        message.hasMore = false
      }
      this.#sendMessage(MessageType.LoadMoreResponse, message)
    } catch (error) {
      this.onError(new MasonryError(`Failed to load more items: ${error}`))
    } finally {
      this.#pagination.loading = false  // 无论成功失败都释放锁
    }
  })
}
```

**设计要点**：

- **`list.length >= pageSize` 启发式判断**：如果返回的数据量等于请求量（pageSize），则认为还有更多数据；少于 pageSize 则认为已到末尾。这是分页接口的通用约定。
- **`try/finally` 确保锁释放**：`this.#pagination.loading = false` 放在 finally 中，即使 loadMore 函数抛错也能释放防重入锁，避免后续加载永久阻塞。
- **双路径处理**：loadMore 可以返回 ImageBitmap[]（服务端预渲染场景）或字符串/描述符（常规 URL 加载场景）。后者需要额外的异步加载步骤。

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
// src/core/masonry.ts
#initScrollListeners() {
  const canvas = this.#config.core.canvas
  const signal = this.#scrollAbort.signal

  // passive: false 允许 preventDefault()（阻止页面滚动）
  canvas.addEventListener('wheel', this.#handleWheel.bind(this), { passive: false, signal })
  canvas.addEventListener('pointerdown', this.#handlePointerDown.bind(this), { signal })
  canvas.addEventListener('pointermove', this.#handlePointerMove.bind(this), { signal })
  canvas.addEventListener('pointerup', this.#handlePointerUp.bind(this), { signal })
  canvas.addEventListener('pointercancel', this.#handlePointerUp.bind(this), { signal })
}
```

**设计要点**：所有监听器通过 `AbortController.signal` 统一管理，`destroy()` 时调用 `this.#scrollAbort.abort()` 一次性注销全部事件，避免逐个 `removeEventListener` 且不需要保存 handler 引用。

### 5.2 Wheel 事件

```typescript
// src/core/masonry.ts
#handleWheel(e: WheelEvent) {
  e.preventDefault()  // 阻止页面滚动（需要 passive: false）
  const scroll = this.#config.interaction?.scroll
  const deltaX = scroll?.disabled?.horizontal ? 0 : e.deltaX
  const deltaY = scroll?.disabled?.vertical ? 0 : e.deltaY
  if (deltaX !== 0 || deltaY !== 0) {
    const payload: ScrollPayload = { deltaX, deltaY }
    this.#sendMessage(MessageType.Scroll, payload)
  }
}
```

### 5.3 Pointer 事件（触控/拖拽）完整实现

```typescript
// src/core/masonry.ts
#handlePointerDown(e: PointerEvent) {
  this.#pointerState.down = true
  this.#pointerState.startX = e.clientX   // 记录起始位置（用于判定点击）
  this.#pointerState.startY = e.clientY
  this.#pointerState.lastX = e.clientX    // 记录上一帧位置（用于计算增量）
  this.#pointerState.lastY = e.clientY
  // setPointerCapture：确保即使指针移出 canvas 范围也能接收 move/up 事件
  ;(e.target as HTMLElement)?.setPointerCapture?.(e.pointerId)
}

#handlePointerMove(e: PointerEvent) {
  if (!this.#pointerState.down) {
    return  // 未按下时忽略移动
  }
  const scroll = this.#config.interaction?.scroll
  // 注意：方向与 wheel 相反。拖拽向右 = 内容向左 = 正 deltaX
  const dx = scroll?.disabled?.horizontal ? 0 : this.#pointerState.lastX - e.clientX
  const dy = scroll?.disabled?.vertical ? 0 : this.#pointerState.lastY - e.clientY
  this.#pointerState.lastX = e.clientX
  this.#pointerState.lastY = e.clientY
  if (dx !== 0 || dy !== 0) {
    const payload: ScrollPayload = { deltaX: dx, deltaY: dy }
    this.#sendMessage(MessageType.Scroll, payload)
  }
}

#handlePointerUp(e: PointerEvent) {
  if (!this.#pointerState.down) {
    return
  }
  this.#pointerState.down = false
  // 判定是拖拽还是点击：起始位置与结束位置的距离 < 5px 视为点击
  const dx = Math.abs(e.clientX - this.#pointerState.startX)
  const dy = Math.abs(e.clientY - this.#pointerState.startY)
  if (dx < 5 && dy < 5 && this.#config.interaction?.onClick) {
    // 转换为 canvas 相对坐标
    const rect = this.#config.core.canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    this.#pendingClickEvent = e  // 保存原始事件，后续回调中传递给用户
    const payload: ClickPayload = { x, y }
    this.#sendMessage(MessageType.Click, payload)
  }
}
```

**设计要点**：

- **`setPointerCapture`**：捕获指针后，即使用户拖出 canvas 区域，依然能接收 move 和 up 事件。这对于快速拖拽特别重要——手指移动速度快时很容易超出 canvas 边界。
- **5px 阈值判定**：移动设备上手指触控的抖动通常在 2-3px。5px 阈值能可靠区分"手指轻触"（点击）和"手指滑动"（拖拽），避免误触。
- **`lastX - e.clientX` 方向反转**：拖拽的物理直觉是"把内容推向某方向"，所以手指向右移动时内容向左滚动（正 deltaX）。这与 wheel 事件的语义保持一致。
- **`#pendingClickEvent` 暂存**：点击处理是异步的（发消息到 Worker → Worker 命中检测 → 返回结果），需要保存原始 PointerEvent 以在最终回调中传给用户。

---

## 6. 容器自适应

### 6.1 ResizeObserver

```typescript
#resizeObserver = new ResizeObserver(() => this.#resize())
```

监听 canvas 元素的尺寸变化。

### 6.2 DPR 监听完整实现

```typescript
// src/core/masonry.ts
#initDprListener() {
  if (typeof window.matchMedia !== 'function') {
    return  // 不支持 matchMedia 的环境（SSR / 某些测试环境）
  }
  const updateDpr = () => {
    this.#resize()
    // 移除旧监听器：因为它绑定的 DPR 值已过时
    this.#dprMediaQuery?.removeEventListener('change', updateDpr)
    // 递归重建：用新的 DPR 值创建新的 matchMedia 查询
    this.#initDprListener()
  }
  // matchMedia 监听特定 DPR 值的变化：当 DPR 不再是这个值时触发 change
  this.#dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  this.#dprMediaQuery.addEventListener('change', updateDpr)
}
```

**设计要点**：

- **为什么递归重建**：`matchMedia('(resolution: 2dppx)')` 只在 DPR 从 2 变为其他值时触发一次 change。变化后新的 DPR 可能是 1.5、3 等任何值，需要创建新的查询来监听下一次变化。这种"递归重注册"是 `matchMedia` 监听连续值变化的标准模式。
- **使用场景**：用户拖动浏览器窗口到不同密度的显示器时（macOS 外接显示器）、使用浏览器缩放（Ctrl+/Ctrl-）时都会触发 DPR 变化。

### 6.3 Resize 防抖完整实现

```typescript
// src/core/masonry.ts
#resize = debounce(100 / 6, () => {
  const payload: ResizePayload = {
    clientWidth: this.#config.core.canvas.clientWidth,
    clientHeight: this.#config.core.canvas.clientHeight,
    dpr: window.devicePixelRatio || 1,
  }
  this.#sendMessage(MessageType.Resize, payload)
})
```

**设计要点**：

- **`100 / 6 ≈ 16.7ms` 防抖间隔**：对齐一帧的时间（60fps）。拖拽窗口 resize 时可能每帧都触发 ResizeObserver，防抖确保同一帧内的多次 resize 只发送一条消息。
- **DPR 包含在 payload 中**：resize 事件不仅可能来自窗口大小变化，还可能来自 DPR 变化（`#initDprListener` 也调用 `#resize()`）。payload 统一包含 DPR，让 Worker 端用统一逻辑处理。

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
