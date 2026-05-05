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

**排除的字段**：
- `canvas`: DOM 元素，不可跨线程
- `placeholderRenderer`: 包含 DOM 操作（createElement）
- `events.onReady/onError`: 主线程回调函数
- `loader.loadMore`: 异步函数，不可序列化
- `interaction.onClick`: 需要访问原始 DOM 事件

**保留的字段**：
- `backgroundColor`, `style`, `layout` — 纯数据配置
- `scroll` 配置 — 纯数据（friction, buffer, disabled 等）
- `loader.pageSize` — 数值

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
