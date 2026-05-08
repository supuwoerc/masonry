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

`loadBatch()` 的完整实现展示了并发控制与静默失败策略：

```typescript
// src/core/image-loader.ts
async loadBatch(
  urls: Array<{ url: string; index: number; width?: number; height?: number }>,
  onLoaded: (index: number, bitmap: ImageBitmap, width: number, height: number) => void,
): Promise<void> {
  const tasks = urls.map(({ url, index, width, height }) => {
    // 每个任务被 p-limit 包装，确保同时运行的不超过 concurrency 限制
    return this.#limit(async () => {
      try {
        const bitmap = await this.#loadWithRetry(url)
        // width ?? bitmap.width：优先使用预设尺寸（来自 ItemDescriptor），
        // 没有时才用 bitmap 的实际像素尺寸
        onLoaded(index, bitmap, width ?? bitmap.width, height ?? bitmap.height)
      } catch {
        // 加载失败静默跳过，item 保持 loading 状态
        // Worker 会持续为 loading 状态的 item 请求占位符渲染
        // 直到用户滚动离开或页面销毁
      }
    })
  })
  await Promise.all(tasks)
}
```

**设计要点**：

- **静默失败策略**：失败的图片不会中断整个批量加载，也不会抛出错误。Worker 端会持续为 `status === 'loading'` 的项目渲染占位符动画，用户体验上表现为该位置一直显示加载动画。
- **`width ?? bitmap.width` fallback**：如果用户通过 `ItemDescriptor` 提供了原始尺寸，优先使用——这个尺寸在瀑布流布局中用于计算宽高比。如果没有提供，则使用解码后的位图实际尺寸。
- **`Promise.all(tasks)`**：所有任务并行发起，但受 `p-limit` 限制同时执行的数量。这意味着即使有 100 张图片，也只有 6 张同时在网络加载。

### 1.4 并发控制（p-limit）

```typescript
this.#limit = pLimit(config?.concurrency ?? 6)
```

p-limit 维护一个内部队列，同时运行的 Promise 不超过 concurrency 限制。超出的任务排队等待。

**为什么需要并发控制**：
- 浏览器对同一域名的并发连接数有限（通常 6-8）
- 同时加载太多图片会竞争带宽，导致所有图片都慢
- 控制并发可以让前几张图片更快展示

### 1.5 重试与超时的完整实现

```typescript
// src/core/image-loader.ts
async #loadWithRetry(url: string): Promise<ImageBitmap> {
  return retry(() => this.#fetchWithTimeout(url), {
    maxAttempts: this.#maxRetries + 1,  // 首次尝试 + 重试次数
    delayMs: this.#retryDelay,           // 基础延迟 500ms
    backoffFactor: 2,                    // 指数退避因子
    // 关键：如果 loader 已被 dispose()，停止重试
    // 防止组件已销毁后仍有后台重试在执行
    shouldRetry: () => !this.#abortController.signal.aborted,
  })
}

async #fetchWithTimeout(url: string): Promise<ImageBitmap> {
  // withTimeout 包装：超过 timeout 毫秒后自动 reject
  const result = await withTimeout(
    this.#fetcher(url, this.#abortController.signal),
    this.#timeout,
  )
  // 自定义 fetcher 可能直接返回 ImageBitmap（如从缓存获取）
  if (result instanceof ImageBitmap) {
    return result
  }
  // 默认路径：fetcher 返回 Blob，需要解码为 ImageBitmap
  // createImageBitmap 是浏览器内置的异步解码 API
  return await createImageBitmap(result)
}
```

**设计要点**：

- **`shouldRetry: () => !aborted`**：当 `dispose()` 被调用后，AbortController 的 signal 变为 aborted 状态。此时所有等待中的重试会立即停止，避免组件销毁后仍有异步操作在后台运行。
- **`result instanceof ImageBitmap` 检查**：自定义 fetcher 有两种合法返回值——`Blob`（标准流程）或 `ImageBitmap`（从 Service Worker 缓存或其他预解码源获取时）。这个分支让两种场景都能正确工作。
- **`withTimeout` 与 AbortSignal 的区别**：`withTimeout` 是 Promise 级别的超时（超时后 reject），而 `signal` 是网络请求级别的取消（实际中止 TCP 连接）。两者配合使用确保超时既能中止 Promise 链，也能释放底层网络资源。

**指数退避时间线**：
```
第 1 次失败 → 等待 500ms → 重试
第 2 次失败 → 等待 1000ms → 重试
第 3 次失败 → 等待 2000ms → 重试
第 4 次失败 → 放弃
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

### 3.2 渲染一帧的完整实现

```typescript
// src/core/placeholder/breathing-placeholder.ts
async render(width: number, height: number, id: string): Promise<ImageBitmap> {
  const now = performance.now()
  // DPR 上限为 2：3x 屏幕上占位符的视觉差异极小，
  // 但像素面积是 2x 的 2.25 倍（3²/2²），收益递减
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cssWidth = width
  const cssHeight = height
  const physWidth = Math.round(width * dpr)
  const physHeight = Math.round(height * dpr)

  let state = this.#cache.get(id)

  if (!state) {
    // 首次渲染：创建独立的 canvas（每个占位符一个）
    const canvas = document.createElement('canvas')
    canvas.width = physWidth
    canvas.height = physHeight
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)  // 一次性设置 DPR 缩放

    state = {
      canvas,
      dpr,
      startTime: now,     // 记录此占位符的动画开始时间
      bitmap: await createImageBitmap(canvas),
    }
    this.#cache.set(id, state)
  }

  const ctx = state.canvas.getContext('2d')!
  // 每帧重置变换矩阵，防止多次调用导致缩放累积
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)

  // 清除上一帧内容
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  ctx.save()
  // 圆角裁剪（如果配置了 radius）
  if (this.#options.radius > 0) {
    ctx.beginPath()
    ctx.roundRect(0, 0, cssWidth, cssHeight, this.#options.radius)
    ctx.clip()
  }

  // 绘制底色（支持纯色字符串或渐变对象）
  const bgStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, this.#options.backgroundColor)
  ctx.fillStyle = bgStyle
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 计算呼吸动画进度并叠加高光
  const elapsed = now - state.startTime
  const progress = (elapsed % this.#options.duration) / this.#options.duration
  // alpha 正弦计算：0.3 + 0.3 * sin(progress * 2π) → 范围 [0, 0.6]
  const alpha = 0.3 + 0.3 * Math.sin(progress * Math.PI * 2)
  // 正则替换高光色的 alpha 通道：'rgba(255,255,255,0.6)' → 'rgba(255,255,255,{alpha})'
  ctx.fillStyle = this.#options.highlightColor.replace(/[\d.]+\)$/, `${alpha})`)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  ctx.restore()

  // 释放上一帧的 ImageBitmap，防止内存泄漏
  state.bitmap.close()
  // 从当前 canvas 内容创建新的 ImageBitmap
  state.bitmap = await createImageBitmap(state.canvas)

  return state.bitmap
}
```

**设计要点**：

- **DPR 上限为 2** (`Math.min(2, dpr)`)：占位符是纯色/渐变的简单图形，3x 分辨率不会带来可感知的清晰度提升，但会使 canvas 像素面积增加 125%（从 4x 到 9x），增加 `createImageBitmap` 的解码开销。
- **`ctx.setTransform` 重置**：每帧调用而非 `ctx.scale` 累加。如果用 `scale`，多帧后会导致缩放值指数增长。`setTransform` 直接设置绝对变换矩阵，确保每帧从正确的 DPR 状态开始。
- **`state.bitmap.close()` 在创建新 bitmap 前调用**：`createImageBitmap` 会创建新的 GPU/内存资源引用。如果不关闭旧的，每帧动画会积累一个未释放的 ImageBitmap，60fps 下每秒泄漏 60 个。
- **正则替换 alpha**：`highlightColor.replace(/[\d.]+\)$/, ...)`  匹配 rgba 字符串末尾的数字+右括号（即 alpha 值），只修改透明度而保持颜色通道不变。这比每帧解析 RGBA 重新组合更简洁。

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

### 4.2 绘制逻辑的完整实现

```typescript
// src/core/placeholder/spin-placeholder.ts
async render(width: number, height: number, id: string): Promise<ImageBitmap> {
  const now = performance.now()
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const { cssWidth, cssHeight, physWidth, physHeight } = this.#calculateCanvasSize(width, height, dpr)

  let state = this.#cache.get(id)

  if (!state) {
    const canvas = document.createElement('canvas')
    canvas.width = physWidth
    canvas.height = physHeight
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    state = { canvas, dpr, startTime: now, bitmap: await createImageBitmap(canvas) }
    this.#cache.set(id, state)
  }

  const ctx = state.canvas.getContext('2d')!
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)
  // 关闭抗锯齿：小尺寸圆点在抗锯齿开启时边缘模糊，关闭后更清晰
  ctx.imageSmoothingEnabled = false

  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 绘制背景
  const bgStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, this.#options.backgroundColor || '#f2f2f2')
  ctx.fillStyle = bgStyle
  ctx.fillRect(0, 0, Math.ceil(cssWidth), Math.ceil(cssHeight))

  // 计算旋转角度：1200ms 完成一圈（360°）
  const elapsed = now - state.startTime
  const angle = ((elapsed / 1200) * 360) % 360
  this.#drawLoader(ctx, cssWidth, cssHeight, angle)

  state.bitmap.close()
  state.bitmap = await createImageBitmap(state.canvas)
  return state.bitmap
}

#drawLoader(ctx: CanvasRenderingContext2D, width: number, height: number, angle: number) {
  // Math.round 防止亚像素渲染导致圆点模糊
  const centerX = Math.round(width / 2)
  const centerY = Math.round(height / 2)
  const dotSize = 4      // 每个点的半径
  const loaderRadius = 8 // 4 个点到中心的距离

  ctx.save()
  ctx.translate(centerX, centerY)
  // 角度转弧度：整体旋转所有点
  ctx.rotate((angle * Math.PI) / 180)

  // 4 个点分布在正方形四角（±loaderRadius, ±loaderRadius）
  const positions = [
    { x: -loaderRadius, y: -loaderRadius },
    { x: loaderRadius, y: -loaderRadius },
    { x: loaderRadius, y: loaderRadius },
    { x: -loaderRadius, y: loaderRadius },
  ]

  positions.forEach((pos, index) => {
    const x = Math.round(pos.x)  // 对齐像素网格，避免亚像素模糊
    const y = Math.round(pos.y)

    ctx.beginPath()
    // HSL 亮度递减：75% → 65% → 55% → 45%，形成"追尾"的视觉效果
    ctx.fillStyle = `hsl(225, 100%, ${75 - index * 10}%)`
    ctx.arc(x, y, dotSize, 0, Math.PI * 2)
    ctx.fill()
  })

  ctx.restore()
}
```

**设计要点**：

- **`imageSmoothingEnabled = false`**：对于 4px 半径的小圆点，抗锯齿会让边缘变得模糊不清。关闭后圆点边缘更锐利，尤其在低 DPR 屏幕上效果明显。
- **`Math.round()` 对齐像素网格**：Canvas 在非整数坐标绘制时会触发亚像素渲染（为了模拟"介于两个像素之间"的位置），导致图形变模糊。Round 到整数确保每个点精确对齐像素。
- **1200ms 周期选择**：比 1000ms 稍慢，视觉上更"从容"。如果用 1000ms，旋转速度偏快会给人焦虑感；1500ms 又显得迟钝。
- **HSL 亮度递减 (`75 - index * 10`)**：利用人眼对亮度差异的敏感性，即使 4 个点静态排列也能看出"方向感"。旋转时形成经典的"追尾"加载动画效果。

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

### 5.2 完整实现

```typescript
// src/helper/background.ts
export function createBackgroundStyle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: string | GradientBackground,
): CanvasFillStrokeStyles['fillStyle'] {
  // 纯色快速路径：字符串直接作为 fillStyle 使用
  if (isString(bg)) {
    return bg
  }

  // 渐变路径：根据 type 字段分发
  let gradient: CanvasGradient
  if (bg.type === 'linear') {
    // 线性渐变：start/end 默认为从左到右（[0,0] → [width,0]）
    const [x0, y0] = bg.linear?.start || [0, 0]
    const [x1, y1] = bg.linear?.end || [width, 0]
    gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  } else {
    // 径向渐变：默认中心点为画布中心
    const [x0, y0] = bg.radial?.start || [width / 2, height / 2]
    const [x1, y1] = bg.radial?.end || [x0, y0]
    gradient = ctx.createRadialGradient(
      x0,
      y0,
      bg.radial?.r0 || 0,                         // 内圆半径默认 0（从中心点开始）
      x1,
      y1,
      bg.radial?.r1 || Math.max(width, height),   // 外圆半径默认覆盖整个画布
    )
  }

  // 添加色标：stops 数组定义渐变的颜色分布
  bg.stops.forEach((stop) => {
    gradient.addColorStop(stop.offset, stop.color)
  })

  return gradient
}
```

**设计要点**：

- **纯色与渐变的统一返回类型**：`CanvasFillStrokeStyles['fillStyle']` 既可以是字符串（颜色值）也可以是 `CanvasGradient`，这正好对应函数的两个分支。调用方无需关心返回的具体类型，直接赋值给 `ctx.fillStyle` 即可。
- **默认值策略**：线性渐变默认水平方向（从左到右），径向渐变默认从中心扩散到覆盖整个画布（`Math.max(width, height)` 确保最大维度也能覆盖）。这让用户只需提供 `stops` 就能得到合理的默认渐变效果。
- **`r0 || 0` 与 `r1 || Math.max(...)`**：内圆半径为 0 意味着渐变从一个点开始，外圆半径取画布最大边长确保渐变扩散到所有角落（如果只取 `width` 或 `height`，矩形画布的短边方向会提前到达边界）。
- **上下文类型兼容**：参数类型同时接受 `CanvasRenderingContext2D` 和 `OffscreenCanvasRenderingContext2D`，因为此函数同时被主线程占位符渲染器和 Worker 端画布背景使用。

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

### 6.3 完整实现

```typescript
// src/helper/stats-monitor.ts

// 面板类型到 stats.js 内部索引的映射
const panelMap = {
  fps: 0,
  ms: 1,
  mb: 2,
  custom: 3,
} as const

export class StatsMonitor {
  #stats: Stats
  #enabled = true
  #animationId: number | null = null

  constructor(
    showPanel: 'fps' | 'ms' | 'mb' | 'custom' = 'fps',
    dom = document.body,
    start = true,   // 默认创建即启动，减少样板代码
  ) {
    this.#stats = new Stats()
    this.#stats.showPanel(panelMap[showPanel])
    dom.appendChild(this.#stats.dom)  // 将面板 DOM 挂载到指定容器
    if (start) {
      this.start()
    }
  }

  start() {
    // 防止重复启动：只有当 animationId 为 null 时才启动
    if (!this.#animationId) {
      this.#stats.begin()
      this.loop()
    }
  }

  stop() {
    if (this.#animationId) {
      cancelAnimationFrame(this.#animationId)  // 取消下一帧回调
      this.#animationId = null                  // 重置状态，允许再次 start()
      this.#stats.end()                         // 结束当前帧计时
    }
  }

  enable() {
    this.#enabled = true
    this.#stats.dom.style.display = 'block'
  }

  disable(): void {
    this.#enabled = false
    this.#stats.dom.style.display = 'none'
  }

  toggle(): void {
    this.#enabled = !this.#enabled
    this.#stats.dom.style.display = this.#enabled ? 'block' : 'none'
  }

  customizeStyle(style: Partial<CSSStyleDeclaration>): void {
    Object.assign(this.#stats.dom.style, style)
  }

  // 递归 rAF 循环：每帧调用 stats.update() 更新面板数据
  private loop(): void {
    this.#stats.update()
    // 箭头函数保证 this 指向正确
    this.#animationId = requestAnimationFrame(() => this.loop())
  }
}
```

**设计要点**：

- **递归 `requestAnimationFrame` 模式**：`loop()` 方法在每帧末尾通过 `requestAnimationFrame(() => this.loop())` 注册下一帧回调。与 `setInterval` 相比，rAF 自动对齐显示器刷新率，且在页面不可见时自动暂停，避免不必要的资源消耗。
- **`#animationId` 双重作用**：既是 `cancelAnimationFrame` 的句柄，也是运行状态标志。`null` 表示未运行，非 `null` 表示正在运行。`start()` 检查此值防止重复启动，`stop()` 重置此值允许再次启动。
- **`start = true` 默认参数**：性能监控器的典型使用场景是创建后立即开始监控。默认 `true` 让用户省去调用 `start()` 的步骤。传 `false` 则为"懒启动"模式，适合需要手动控制时机的场景。
- **`enable()/disable()` 与 `start()/stop()` 的区别**：前者只控制 DOM 可见性（面板继续采集数据但不显示），后者完全停止 rAF 循环。这让用户在不需要看面板时节省渲染开销，而不丢失性能数据的连续性。

### 6.4 API

| 方法 | 说明 |
|------|------|
| `start()` | 开始监控循环（防重复启动） |
| `stop()` | 停止监控（取消 rAF + 重置状态） |
| `enable()` / `disable()` | 显示/隐藏面板（不停止数据采集） |
| `toggle()` | 切换显示状态 |
| `customizeStyle(style)` | 自定义面板 DOM 样式 |

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
