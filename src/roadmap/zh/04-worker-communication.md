# Worker 通信协议与消息机制

> 本文档详细介绍主线程与 Worker 之间的通信协议设计、消息类型、Payload 结构和 Transferable 对象传输机制。

## 模块定位

通信协议是连接主线程与 Worker 的桥梁。它定义了一套类型安全的消息格式，确保两个线程之间的数据交换准确、高效。

## 涉及源文件

| 文件 | 职责 |
|------|------|
| `src/core/worker/protocol.ts` | 协议定义（Message、MessageType、Payload） |
| `src/core/worker/constant.ts` | Worker 常量 |

---

## 1. 消息结构

### 1.1 Message 接口

```typescript
interface Message<T = MessagePayload> {
  id: string          // nanoid 生成的唯一标识
  from?: string       // 来源消息 ID（用于请求-响应配对）
  type: MessageType   // 消息类型枚举
  payload: T          // 泛型负载
  timestamp: number   // 发送时间戳
}
```

### 1.2 设计考量

| 字段 | 作用 |
|------|------|
| `id` | 唯一标识每条消息，便于调试和追踪 |
| `from` | 标记响应对应的请求 ID（目前主要用于错误追踪） |
| `type` | 决定消息如何处理（switch-case 分发） |
| `payload` | 携带具体数据，类型由 `type` 决定 |
| `timestamp` | 记录发送时间，可用于性能分析 |

### 1.3 消息发送实现

主线程和 Worker 各自有一个 `#sendMessage` 方法，核心逻辑相同但调用接口不同：

```typescript
// ─── 主线程端 (src/core/masonry.ts) ───
#sendMessage(type: MessageType, payload: MessagePayload, transfer?: Transferable[]) {
  const message: Message<MessagePayload> = {
    id: nanoid(),           // 每条消息独立 ID
    type,
    payload,
    timestamp: Date.now(),  // 记录发送时刻
  }
  // worker.postMessage 的第二个参数是 Transferable 列表
  // 不传 transfer 时默认空数组（普通结构化克隆）
  this.#worker?.postMessage(message, transfer ?? [])
}

// ─── Worker 端 (src/core/worker/offscreen-canvas.ts) ───
#sendMessage(type: MessageType, payload: RequestPayload | ResponsePayload, from?: string): void {
  const message: Message<RequestPayload | ResponsePayload> = {
    id: nanoid(),
    from,                   // 标记此消息是对哪条请求的响应
    type,
    payload,
    timestamp: Date.now(),
  }
  // Worker 内部使用 globalThis.postMessage 向主线程发送
  // 注意：Worker 端没有 transfer 参数，因为 Worker→Main 方向
  // 当前没有需要转移所有权的对象（ClickResult/LayoutUpdated 都是纯数据）
  globalThis.postMessage(message)
}
```

**设计要点**：

- **主线程端有 `transfer` 参数**：因为 Main→Worker 方向需要传输 OffscreenCanvas 和 ImageBitmap（零拷贝转移所有权）。
- **Worker 端有 `from` 参数**：用于错误消息追溯。当 Worker 处理某条请求时出错，`from` 字段记录了是哪条请求导致的错误，便于主线程定位问题。
- **`nanoid()` 生成 ID**：轻量级唯一 ID 生成器（21 字符，URL 安全），比 `crypto.randomUUID()` 有更好的浏览器兼容性。

---

## 2. 消息类型枚举（15 种）

```typescript
enum MessageType {
  Setup,                // 初始化设置
  SetupResponse,        // 初始化完成响应
  LoadMore,             // 请求加载更多数据
  LoadMoreResponse,     // 加载更多数据响应
  Render,               // 触发渲染
  RenderLoading,        // 请求渲染加载占位符
  RenderLoadingResponse,// 占位符渲染完成响应
  Resize,               // 容器尺寸变化
  RemoveLoading,        // 移除加载占位符
  Error,                // 错误消息
  Scroll,               // 滚动偏移更新
  LayoutUpdated,        // 布局更新通知
  ImageLoaded,          // 图片加载完成
  Click,                // 点击事件
  ClickResult,          // 点击结果响应
}
```

### 2.1 按方向分类

```
Main → Worker（8 种）:
  Setup, Render, Resize, Scroll, ImageLoaded, Click,
  RenderLoadingResponse, LoadMoreResponse

Worker → Main（7 种）:
  SetupResponse, LoadMore, RenderLoading, RemoveLoading,
  LayoutUpdated, ClickResult, Error
```

### 2.2 请求-响应配对

| 请求 (Request) | 响应 (Response) | 方向 |
|---------------|----------------|------|
| Setup | SetupResponse | Main→Worker→Main |
| Click | ClickResult | Main→Worker→Main |
| RenderLoading | RenderLoadingResponse | Worker→Main→Worker |
| LoadMore | LoadMoreResponse | Worker→Main→Worker |

### 2.3 Worker 端消息分发实现

Worker 接收到消息后通过 `#handleMessage` 的 switch-case 分发到对应处理函数：

```typescript
// src/core/worker/offscreen-canvas.ts
#setupMessageHandler(): void {
  globalThis.onmessage = (event: MessageEvent<Message>) => {
    try {
      this.#handleMessage(event.data)
    } catch (error) {
      // 顶层错误边界：任何未捕获的异常都不会导致 Worker 崩溃
      // 而是通过 Error 消息通知主线程
      this.#sendError(error)
    }
  }
}

#handleMessage(message: Message) {
  const { type, payload } = message
  switch (type) {
    case MessageType.Setup:
      this.#handleSetup(payload as SetupPayload)
      break
    case MessageType.Render:
      // Render 触发三个动作：启动动画循环 + 首帧渲染 + 检查是否需要加载更多
      this.#startAnimationLoop()
      this.#handleRerender()
      this.#checkLoadMore()
      break
    case MessageType.Resize:
      this.#handleResize(payload as ResizePayload)
      break
    case MessageType.Scroll:
      this.#handleScroll(payload as ScrollPayload)
      break
    case MessageType.RenderLoadingResponse:
      this.#handleRenderLoading(payload as RenderLoadingResponsePayload)
      break
    case MessageType.LoadMoreResponse:
      this.#handleLoadMoreResponse(payload as LoadMoreResponsePayload)
      break
    case MessageType.ImageLoaded:
      this.#handleImageLoaded(payload as ImageLoadedPayload)
      break
    case MessageType.Click:
      this.#handleClick(payload as ClickPayload)
      break
    default:
      // 穷尽性保护：收到未知消息类型时立即报错
      // 确保协议变更时不会静默忽略新增的消息类型
      throw new MasonryError(`unknown message type: ${type}`)
  }
}
```

**设计要点**：

- **顶层 try/catch 错误边界**：Worker 线程中的未捕获异常不像主线程那样有全局错误处理。如果没有这个边界，一个处理函数中的异常会导致整个 Worker 的 `onmessage` 失效，后续消息都无法处理。
- **`default` 抛出错误**：在协议演进过程中，如果主线程发送了 Worker 尚不支持的新消息类型，立即报错比静默忽略更容易发现版本不匹配问题。
- **`Render` 消息触发三个动作**：这是初始化完成后的"启动"信号，一次性完成渲染循环启动、首帧绘制和首次 loadMore 检查。

---

## 3. Payload 类型设计

### 3.1 负载联合类型

```typescript
// 主线程 → Worker 的请求负载
type RequestPayload =
  | SetupPayload | ResizePayload | ScrollPayload
  | ImageLoadedPayload | ClickPayload | Array<string> | string

// Worker → 主线程的响应负载
type ResponsePayload =
  | RenderLoadingResponsePayload | LayoutUpdatedPayload
  | ClickResultPayload | LoadMoreResponsePayload | Error | null
```

### 3.2 各 Payload 详解

#### SetupPayload（初始化）

```typescript
interface SetupPayload {
  offscreenCanvas: OffscreenCanvas  // 离屏画布 [Transferable]
  clientWidth: number                // 容器 CSS 宽度
  clientHeight: number               // 容器 CSS 高度
  config: WorkerConfiguration        // Worker 配置
  dpr: number                        // 设备像素比
}
```

#### ScrollPayload（滚动增量）

```typescript
interface ScrollPayload {
  deltaX: number  // 水平滚动增量（px）
  deltaY: number  // 垂直滚动增量（px）
}
```

#### ImageLoadedPayload（图片加载完成）

```typescript
interface ImageLoadedPayload {
  index: number       // 图片在数据源中的索引
  bitmap: ImageBitmap // 加载完成的位图 [Transferable]
  width: number       // 原始宽度
  height: number      // 原始高度
}
```

#### LoadMoreResponsePayload（分页数据响应）

```typescript
interface LoadMoreResponsePayload {
  page: number            // 当前页码
  hasMore: boolean        // 是否还有更多数据
  data: Array<ImageBitmap> // 加载的图片位图数组
}
```

#### ResizePayload（容器尺寸变化）

```typescript
interface ResizePayload {
  clientWidth: number   // 新的 CSS 宽度
  clientHeight: number  // 新的 CSS 高度
  dpr: number          // 新的设备像素比
}
```

#### RenderLoadingResponsePayload（占位符位图）

```typescript
interface RenderLoadingResponsePayload {
  id: string          // 占位符 ID
  bitmap: ImageBitmap // 渲染好的位图 [Transferable]
}
```

#### ClickPayload / ClickResultPayload（点击交互）

```typescript
interface ClickPayload {
  x: number  // 点击的 CSS X 坐标（相对于 canvas）
  y: number  // 点击的 CSS Y 坐标
}

type ClickResultPayload = {
  item: GridItem  // 命中的网格项
  index: number   // 数据源索引
  row: number     // 行号
  column: number  // 列号
} | null          // 未命中返回 null
```

#### LayoutUpdatedPayload（布局更新通知）

```typescript
interface LayoutUpdatedPayload {
  contentWidth: number   // 内容总宽度
  contentHeight: number  // 内容总高度
}
```

---

## 4. GridItem 数据结构

```typescript
interface GridItem {
  id: string              // nanoid 唯一标识
  image: ImageBitmap | null // 图片数据（loading 时为 null）
  status: 'loading' | 'loaded' // 加载状态
  x: number               // 布局 X 坐标
  y: number               // 布局 Y 坐标
  width?: number          // 渲染宽度（瀑布流时可变）
  height?: number         // 渲染高度
  itemIndex: number       // 在数据源中的索引
}
```

`GridItem` 是 Worker 内部管理元素的核心数据结构，由布局策略填充 x/y/width/height。

---

## 5. Transferable 对象传输

### 5.1 什么是 Transferable

`postMessage` 的第二个参数可指定 Transferable 对象列表。传输后：
- **零拷贝**：数据所有权转移，不经过序列化/反序列化
- **原引用失效**：发送方不再能访问该对象
- 性能优势：大型 ImageBitmap 传输接近零开销

### 5.2 本库使用的 Transferable

| 对象类型 | 传输时机 | 方向 |
|---------|---------|------|
| OffscreenCanvas | 初始化时（一次） | Main → Worker |
| ImageBitmap | 图片加载完成 | Main → Worker |
| ImageBitmap | 占位符渲染完成 | Main → Worker |

### 5.3 代码示例

```typescript
// 传输 OffscreenCanvas（初始化）
this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas])

// 传输 ImageBitmap（图片加载完成）
this.#sendMessage(MessageType.ImageLoaded, payload, [bitmap])

// 传输 ImageBitmap（占位符）
this.#sendMessage(MessageType.RenderLoadingResponse, { bitmap, id }, [bitmap])
```

### 5.4 注意事项

- OffscreenCanvas 传输是**不可逆**的，主线程永远无法重新获得控制权
- ImageBitmap 传输后，发送方的引用变为宽高为 0 的空对象
- 传输列表中的对象必须是 payload 中引用的对象

---

## 6. Worker 配置剥离

### 6.1 配置裁剪类型定义

Worker 不需要也不能使用某些主线程专属对象：

```typescript
interface WorkerConfiguration extends Omit<
  MasonryConfiguration,
  'core' | 'interaction' | 'loader' | 'placeholderRenderer' | 'events' | 'imageLoad'
> {
  core: Omit<Core, 'canvas' | 'items'> & {
    items?: ImageBitmap[]
    itemCount?: number
    itemSizes?: Array<{ width?: number; height?: number }>
  }
  interaction?: Omit<Interaction, 'onClick'>
  loader?: Omit<LoadMoreConfig, 'loadMore'>
}
```

### 6.2 Setup 负载组装的完整实现

以下是主线程构建 SetupPayload 的完整代码，展示了配置裁剪和数据标准化的具体逻辑：

```typescript
// src/core/masonry.ts - #initWorker() 中的 payload 组装
const payload: SetupPayload = {
  offscreenCanvas,
  clientWidth: canvas.clientWidth,
  clientHeight: canvas.clientHeight,
  config: {
    core: {
      // 只传递纯数据字段，排除 canvas（DOM）和 items（可能含 URL 字符串）
      backgroundColor: this.#config.core.backgroundColor,
      style: this.#config.core.style,
      layout: this.#config.core.layout,
      limit: this.#config.core.limit,
      timeout: this.#config.core.timeout,
    },
  },
  dpr: window.devicePixelRatio || 1,
}

// ─── items 标准化：三种输入格式的不同处理路径 ───
const items = this.#config.core.items
if (items?.length) {
  if (items[0] instanceof ImageBitmap) {
    // 路径 1：已预加载的 ImageBitmap 数组
    // 直接传给 Worker，Worker 收到后可立即渲染
    payload.config.core.items = items as ImageBitmap[]
  } else {
    // 路径 2：URL 字符串 或 ItemDescriptor 对象
    // URL 不能传给 Worker（fetch 需在主线程执行，因为可能需要 cookie/auth）
    // 所以只传数量和尺寸信息，让 Worker 先用占位符显示
    const descriptors = this.#normalizeItems(items as string[] | ItemDescriptor[])
    payload.config.core.itemCount = descriptors.length       // Worker 据此创建占位项
    payload.config.core.itemSizes = descriptors.map((d) => ({
      width: d.width,
      height: d.height,
    }))
    // URL 留在主线程，稍后由 ImageLoader 加载
    this.#pendingUrls = descriptors
  }
}

// ─── 交互配置裁剪：排除不可序列化的 onClick 函数 ───
if (this.#config.interaction) {
  payload.config.interaction = {
    scroll: this.#config.interaction?.scroll,  // scroll 是纯数据对象
  }
}

// ─── 加载配置裁剪：排除不可序列化的 loadMore 函数 ───
if (this.#config.loader) {
  payload.config.loader = {
    pageSize: this.#config.loader.pageSize,    // 只传数值
  }
}

// 发送消息，OffscreenCanvas 作为 Transferable 对象零拷贝传输
this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas])
```

**设计要点**：

- **为什么 URL 不传给 Worker**：图片加载（fetch）通常需要 cookie、auth header、CORS 配置等，这些能力在主线程更容易管理。Worker 只负责渲染已解码的 ImageBitmap。
- **`itemCount + itemSizes` 的设计**：Worker 需要知道"有多少个元素"来预创建占位 GridItem 并执行布局计算。尺寸信息（如果有）让瀑布流布局能在图片加载前就给出准确的高度。
- **`#pendingUrls` 的作用**：保存待加载的 URL 列表，在收到 `SetupResponse` 后由 `#loadImages()` 启动异步加载。

---

## 7. 通信时序图

```
Main Thread                              Worker Thread
    │                                        │
    │──── Setup [OffscreenCanvas] ──────────→│
    │                                        │ handleSetup()
    │                                        │ performLayout()
    │←──── SetupResponse ───────────────────│
    │                                        │
    │──── Render ───────────────────────────→│
    │                                        │ startAnimationLoop()
    │                                        │ 检测 loading items
    │←──── RenderLoading [ids] ─────────────│
    │ render placeholders                    │
    │──── RenderLoadingResponse [bitmap] ───→│
    │                                        │ 绘制占位符
    │                                        │
    │──── ImageLoaded [bitmap] ─────────────→│
    │                                        │ handleImageLoaded()
    │                                        │ performLayout()
    │←──── RemoveLoading [id] ──────────────│
    │←──── LayoutUpdated ───────────────────│
    │                                        │
    │──── Scroll {deltaX, deltaY} ─────────→│
    │                                        │ handleScroll()
    │                                        │ tickInertia()
    │                                        │ checkLoadMore()
    │←──── LoadMore ────────────────────────│
    │ loadMore()                             │
    │──── LoadMoreResponse [bitmaps] ───────→│
    │                                        │ handleLoadMoreResponse()
    │                                        │
    │──── Click {x, y} ────────────────────→│
    │                                        │ handleClick()
    │←──── ClickResult {item, row, col} ────│
    │                                        │
    │──── Resize {w, h, dpr} ──────────────→│
    │                                        │ handleResize()
    │←──── LayoutUpdated ───────────────────│
```
