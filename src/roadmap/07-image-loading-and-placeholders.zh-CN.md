# 图片加载与占位符动画系统

> 本文档介绍图片加载器的并发控制与重试机制，以及两种占位符动画渲染器的实现原理。

## 模块定位

图片加载和占位符动画共同解决一个核心体验问题：在图片从网络到渲染的时间差内，用户看到什么。

## 涉及源文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/core/image-loader.ts` | 90 | 图片并发加载器 |
| `src/core/placeholder/breathing-placeholder.ts` | 188 | 呼吸渐变动画 |
| `src/core/placeholder/spin-placeholder.ts` | 186 | 旋转加载动画 |
| `src/helper/background.ts` | 50 | 背景样式工具 |

---

## 1. ImageLoader 核心机制

### 1.1 特性概述

| 特性 | 实现方式 | 默认值 |
|------|---------|--------|
| 并发控制 | p-limit | 6 个并发 |
| 重试策略 | @supuwoerc/toolkit retry | 最多 3 次重试 |
| 退避算法 | 指数退避 | delay × 2^attempt |
| 超时控制 | @supuwoerc/toolkit withTimeout | 10000ms |
| 自定义请求 | ImageFetcher 接口 | fetch → blob |
| 取消机制 | AbortController | 全局中止 |

### 1.2 类结构

```typescript
class ImageLoader {
  #limit: ReturnType<typeof pLimit>  // 并发限制器
  #maxRetries: number                // 最大重试次数
  #retryDelay: number                // 基础重试延迟
  #timeout: number                   // 超时时间
  #fetcher: ImageFetcher             // 请求函数
  #abortController = new AbortController()  // 取消控制器
}
```

### 1.3 加载流程

```
loadBatch(urls)
  │
  ├── 对每个 URL 创建 limit-wrapped 任务
  │     │
  │     └── #loadWithRetry(url)
  │           │
  │           └── retry(() => #fetchWithTimeout(url), options)
  │                 │
  │                 └── withTimeout(fetcher(url, signal), timeout)
  │                       │
  │                       ├── 返回 ImageBitmap → 直接使用
  │                       └── 返回 Blob → createImageBitmap(blob)
  │
  └── 每个任务完成 → onLoaded(index, bitmap, width, height)
```

### 1.4 并发控制（p-limit）

```typescript
this.#limit = pLimit(config?.concurrency ?? 6)
```

p-limit 维护一个内部队列，同时运行的 Promise 不超过 concurrency 限制。超出的任务排队等待。

**为什么需要并发控制**：
- 浏览器对同一域名的并发连接数有限（通常 6-8）
- 同时加载太多图片会竞争带宽，导致所有图片都慢
- 控制并发可以让前几张图片更快展示

### 1.5 重试策略

```typescript
async #loadWithRetry(url: string): Promise<ImageBitmap> {
  return retry(() => this.#fetchWithTimeout(url), {
    maxAttempts: this.#maxRetries + 1,  // 首次 + 重试
    delayMs: this.#retryDelay,           // 基础延迟 500ms
    backoffFactor: 2,                    // 指数因子
    shouldRetry: () => !this.#abortController.signal.aborted,
  })
}
```

**指数退避时间线**：
```
第 1 次失败 → 等待 500ms → 重试
第 2 次失败 → 等待 1000ms → 重试
第 3 次失败 → 等待 2000ms → 重试
第 4 次失败 → 放弃
```

### 1.6 超时控制

```typescript
async #fetchWithTimeout(url: string): Promise<ImageBitmap> {
  const result = await withTimeout(
    this.#fetcher(url, this.#abortController.signal),
    this.#timeout,  // 默认 10000ms
  )
  if (result instanceof ImageBitmap) return result
  return await createImageBitmap(result)  // Blob → ImageBitmap
}
```

### 1.7 自定义 Fetcher

```typescript
type ImageFetcher = (url: string, signal: AbortSignal) => Promise<Blob | ImageBitmap>
```

用途：
- 添加认证头（Authorization）
- 使用自定义代理
- 图片预处理
- 从 Service Worker 缓存读取

默认实现：
```typescript
#defaultFetcher: ImageFetcher = async (url, signal) => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
  return await response.blob()
}
```

### 1.8 取消机制

```typescript
dispose() {
  this.#abortController.abort()  // 中止所有进行中的 fetch
  this.#limit.clearQueue()       // 清空等待队列
}
```

`abort()` 会触发所有使用该 signal 的 fetch 立即拒绝，而 `clearQueue()` 防止排队中的任务继续执行。

---

## 2. PlaceholderRenderer 接口

### 2.1 接口设计

```typescript
interface PlaceholderRenderer {
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  dispose: () => void
  remove: (id: string) => void
}
```

| 方法 | 调用时机 | 职责 |
|------|---------|------|
| `render` | Worker 检测到 loading items | 生成一帧动画位图 |
| `remove` | 图片加载完成 | 清理单个占位符资源 |
| `dispose` | Masonry.destroy() | 清理所有资源 |

### 2.2 动画协作流程

```
Worker: 动画循环检测 loading items
  → 发送 RenderLoading(ids)

Main: 对每个 id 调用 renderer.render(w, h, id)
  → 获得一帧 ImageBitmap
  → 通过 Transferable 发送回 Worker

Worker: 将 bitmap 绘制到对应格子位置

下一帧: Worker 再次发送 RenderLoading(ids)
  → Main 再次 render（新的一帧）
  → 循环直到图片加载完成

图片加载完成:
  → Worker: item.status = 'loaded', 发送 RemoveLoading(id)
  → Main: renderer.remove(id) 释放资源
```

---

## 3. BreathingPlaceholderRenderer（呼吸渐变）

### 3.1 动画原理

利用正弦函数产生周期性的明暗变化：

```
alpha = 0.3 + 0.3 × sin(progress × 2π)
```

- `progress = (elapsed % duration) / duration`：归一化到 [0, 1] 的周期进度
- 当 `sin = 1` 时：alpha = 0.6（最亮）
- 当 `sin = -1` 时：alpha = 0（最暗）
- 当 `sin = 0` 时：alpha = 0.3（中间）

### 3.2 渲染一帧

```typescript
async render(width: number, height: number, id: string): Promise<ImageBitmap> {
  // 1. DPR 适配
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const physWidth = Math.round(width * dpr)
  const physHeight = Math.round(height * dpr)

  // 2. 获取或创建缓存状态
  let state = this.#cache.get(id)
  if (!state) {
    const canvas = document.createElement('canvas')
    canvas.width = physWidth
    canvas.height = physHeight
    state = { canvas, dpr, startTime: now, bitmap: ... }
    this.#cache.set(id, state)
  }

  // 3. 清除画布
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 4. 圆角裁剪（如果配置了 radius）
  if (radius > 0) {
    ctx.roundRect(0, 0, cssWidth, cssHeight, radius)
    ctx.clip()
  }

  // 5. 绘制底色（支持纯色/渐变）
  ctx.fillStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, backgroundColor)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 6. 叠加呼吸高光
  const elapsed = now - state.startTime
  const progress = (elapsed % duration) / duration
  const alpha = 0.3 + 0.3 * Math.sin(progress * Math.PI * 2)
  ctx.fillStyle = highlightColor.replace(/[\d.]+\)$/, `${alpha})`)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 7. 生成 ImageBitmap
  state.bitmap.close()  // 释放上一帧
  state.bitmap = await createImageBitmap(state.canvas)
  return state.bitmap
}
```

### 3.3 配置项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `backgroundColor` | `'#e0e0e0'` | 底色（支持 GradientBackground） |
| `highlightColor` | `'rgba(255, 255, 255, 0.6)'` | 呼吸高光色 |
| `duration` | `1500` | 单周期时长（ms） |
| `radius` | `0` | 圆角（px） |

### 3.4 缓存策略

每个占位符（id）独立缓存：

```typescript
interface AnimationState {
  startTime: number       // 动画起始时间
  bitmap: ImageBitmap     // 当前帧位图
  canvas: HTMLCanvasElement // 离屏绘制画布
  dpr: number             // 设备像素比
}
```

**为什么需要缓存**：
- Canvas 创建开销大，复用避免 GC 压力
- startTime 保证每个占位符独立的动画进度
- bitmap 复用避免频繁创建/销毁

---

## 4. SpinPlaceholderRenderer（旋转加载）

### 4.1 动画原理

4 个圆点绕中心点旋转：

```
angle = (elapsed / 1200 × 360) % 360
```

- 1200ms 完成一圈
- 4 个点均匀分布在正方形四角
- 每个点颜色渐变（HSL 亮度递减）

### 4.2 绘制逻辑

```typescript
#drawLoader(ctx, width, height, angle) {
  const centerX = width / 2
  const centerY = height / 2

  ctx.translate(centerX, centerY)
  ctx.rotate((angle * Math.PI) / 180)

  const positions = [
    { x: -8, y: -8 },  // 左上
    { x: 8, y: -8 },   // 右上
    { x: 8, y: 8 },    // 右下
    { x: -8, y: 8 },   // 左下
  ]

  positions.forEach((pos, index) => {
    ctx.fillStyle = `hsl(225, 100%, ${75 - index * 10}%)`
    ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2)
    ctx.fill()
  })
}
```

### 4.3 颜色方案

4 个点从亮到暗：
- 点 0：`hsl(225, 100%, 75%)` — 最亮的蓝
- 点 1：`hsl(225, 100%, 65%)`
- 点 2：`hsl(225, 100%, 55%)`
- 点 3：`hsl(225, 100%, 45%)` — 最深的蓝

旋转时视觉效果类似「追尾」动画。

### 4.4 与 Breathing 的对比

| 特性 | Breathing | Spin |
|------|-----------|------|
| 动画类型 | 明暗渐变 | 旋转运动 |
| 视觉复杂度 | 简约 | 稍复杂 |
| 绘制开销 | 低（2次 fillRect） | 中（4次 arc） |
| 配置项 | 4个 | 1个 |
| 适合场景 | 大面积占位 | 小卡片占位 |

---

## 5. 背景样式工具（`helper/background.ts`）

### 5.1 功能

为占位符和 Worker 主画布提供统一的背景样式生成：

```typescript
function createBackgroundStyle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: string | GradientBackground,
): CanvasFillStrokeStyles['fillStyle']
```

### 5.2 支持的类型

**纯色**：
```typescript
if (isString(bg)) return bg  // 直接返回颜色字符串
```

**线性渐变**：
```typescript
const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
bg.stops.forEach(stop => gradient.addColorStop(stop.offset, stop.color))
```

**径向渐变**：
```typescript
const gradient = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1)
bg.stops.forEach(stop => gradient.addColorStop(stop.offset, stop.color))
```

---

## 6. StatsMonitor（性能监控）

### 6.1 功能

封装 `stats.js` 库，提供运行时性能面板：

```typescript
const monitor = new StatsMonitor('fps', document.body)
```

### 6.2 面板类型

| 类型 | 显示内容 |
|------|---------|
| `fps` | 帧率（推荐） |
| `ms` | 每帧耗时 |
| `mb` | 内存使用 |
| `custom` | 自定义面板 |

### 6.3 API

| 方法 | 说明 |
|------|------|
| `start()` | 开始监控循环 |
| `stop()` | 停止监控 |
| `enable()` / `disable()` | 显示/隐藏面板 |
| `toggle()` | 切换显示 |
| `customizeStyle(style)` | 自定义面板样式 |

---

## 7. 资源管理与生命周期

### 7.1 内存关注点

| 资源 | 创建时机 | 释放时机 |
|------|---------|---------|
| HTMLCanvasElement（占位符） | `render` 首次调用 | `remove(id)` 或 `dispose()` |
| ImageBitmap（占位符帧） | 每帧 `createImageBitmap` | 下一帧 `bitmap.close()` |
| ImageBitmap（图片） | `createImageBitmap(blob)` | Worker 持有，页面卸载释放 |
| AbortController | ImageLoader 创建 | `dispose()` |

### 7.2 释放策略

```typescript
// PlaceholderRenderer.remove(id) — 单个释放
const state = this.#cache.get(id)
state.canvas.width = 0   // 释放 canvas 内存
state.canvas.height = 0
state.bitmap.close()      // 释放 ImageBitmap
this.#cache.delete(id)

// PlaceholderRenderer.dispose() — 全量释放
this.#cache.forEach(state => { ... })
this.#cache.clear()
```

`canvas.width = 0` 是释放 Canvas 内存的标准做法，强制释放后备缓冲区。
