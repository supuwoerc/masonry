# OffscreenCanvas 渲染引擎

> 本文档详细介绍 Worker 端的渲染引擎实现，包括渲染循环、视口裁剪、惯性滚动物理模型、无缝循环模式和命中检测。

## 模块定位

`OffscreenCanvasWorker` 是整个库中代码量最大、逻辑最复杂的模块（701 行）。它运行在 Web Worker 线程中，独享 Canvas 绑制权，负责所有像素级渲染工作。

## 涉及源文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/core/worker/offscreen-canvas.ts` | 701 | 渲染引擎主体 |
| `src/helper/background.ts` | 50 | 背景样式创建 |

---

## 1. 类概览

### 1.1 核心状态

```typescript
class OffscreenCanvasWorker {
  // 双 Canvas 架构
  #canvas!: OffscreenCanvas              // 主画布（用户可见）
  #backgroundCanvas!: OffscreenCanvas    // 背景缓存层

  // 尺寸与 DPR
  #clientWidth = 0
  #clientHeight = 0
  #dpr = 1

  // 布局
  #layoutStrategy!: LayoutStrategy
  #allItems: GridItem[] = []             // 所有数据项
  #gridItems: GridItem[] = []            // 布局后的定位项

  // 滚动物理
  #scrollX = 0
  #scrollY = 0
  #velocityX = 0
  #velocityY = 0
  #isInertiaActive = false

  // 内容尺寸
  #contentWidth = 0
  #contentHeight = 0

  // 动画控制
  #animationRunning = false

  // 分页状态
  #loadMoreState = { loading: false, hasMore: true }
}
```

### 1.2 入口

文件末尾直接实例化：
```typescript
new OffscreenCanvasWorker()  // Worker 启动时立即创建
```

---

## 2. 初始化流程（`#handleSetup`）

### 2.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#handleSetup(payload: SetupPayload) {
  try {
    // 1. 接管 OffscreenCanvas 并设置物理像素尺寸
    this.#canvas = payload.offscreenCanvas
    this.#canvas.width = payload.clientWidth * payload.dpr
    this.#canvas.height = payload.clientHeight * payload.dpr

    // 2. 创建同尺寸的背景缓存 Canvas（用于避免每帧重绘渐变）
    this.#backgroundCanvas = new OffscreenCanvas(this.#canvas.width, this.#canvas.height)

    // 3. 缓存容器尺寸和 DPR
    this.#clientWidth = payload.clientWidth
    this.#clientHeight = payload.clientHeight
    this.#dpr = payload.dpr

    // 4. 获取 2D 上下文
    this.#context = this.#canvas.getContext('2d')!
    this.#backgroundContext = this.#backgroundCanvas.getContext('2d')!

    // 5. 设置 DPR 变换矩阵：后续所有坐标使用 CSS 像素，自动映射到物理像素
    this.#context.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
    this.#context.imageSmoothingEnabled = true
    this.#context.imageSmoothingQuality = 'high'
    this.#backgroundContext.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
    this.#backgroundContext.imageSmoothingEnabled = true
    this.#backgroundContext.imageSmoothingQuality = 'high'

    // 6. 存储配置
    this.#config = payload.config
    // 无 loader 配置意味着没有分页，数据已全部到位
    if (!this.#config.loader) {
      this.#loadMoreState.hasMore = false
    }

    // 7. 选择布局策略
    const mode = this.#config.core.layout ?? 'grid'
    this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()

    // 8. 处理初始 items（两种路径）
    if (this.#config.core.items?.length) {
      // 路径 A：预加载的 ImageBitmap 数组 → 直接创建 loaded 状态的 GridItem
      this.#allItems = this.#config.core.items.map((item, itemIndex) => {
        return {
          id: nanoid(),
          image: item,
          status: 'loaded',
          x: 0,
          y: 0,
          itemIndex,
        }
      })
    } else if (this.#config.core.itemCount) {
      // 路径 B：只有数量和尺寸信息 → 创建 loading 状态的占位 GridItem
      const sizes = this.#config.core.itemSizes ?? []
      this.#allItems = Array.from({ length: this.#config.core.itemCount }, (_, itemIndex) => {
        return {
          id: nanoid(),
          image: null,
          status: 'loading' as const,
          x: 0,
          y: 0,
          width: sizes[itemIndex]?.width,
          height: sizes[itemIndex]?.height,
          itemIndex,
        }
      })
    }

    // 9. 执行首次布局计算
    this.#performLayout()
    this.#runTask()

    // 10. 通知主线程初始化完成
    this.#sendMessage(MessageType.SetupResponse, null)
  } catch (error) {
    this.#sendError(error)
  }
}
```

**设计要点**：

- **双 Canvas 创建**：主画布用于最终渲染输出，背景画布用于缓存渐变/纯色背景。分离后每帧只需 `drawImage` 复制背景，避免重复计算渐变。
- **`imageSmoothingQuality = 'high'`**：图片缩放时使用高质量双线性/双三次插值，确保瀑布流中缩放后的图片不出现锯齿。对于纯色/渐变的占位符则无明显影响。
- **`!this.#config.loader` 设置 `hasMore = false`**：没有 loader 配置意味着不启用无限滚动，所有数据在初始化时一次性提供。`hasMore = false` 直接启用循环模式（如果 scroll.loop 为 true）。
- **两种 items 路径**：路径 A 是"即用型"（ImageBitmap 已准备好，立即可渲染）；路径 B 是"延迟加载型"（先布局占位框架，后续通过 `ImageLoaded` 消息逐个替换）。路径 B 中 `width/height` 来自 `itemSizes`，让瀑布流布局能在图片加载前就计算出准确的位置。

### 2.2 DPR 变换原理

```typescript
this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
```

Canvas 物理像素 = CSS 像素 × DPR。通过 `setTransform` 缩放坐标系，后续所有绑制操作使用 CSS 像素单位，自动映射到物理像素，实现高清渲染。

---

## 3. 渲染循环（`#startAnimationLoop`）

### 3.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#animationRunning = false

#startAnimationLoop() {
  if (this.#animationRunning) {
    return  // 防止重复启动：多个事件可能同时触发（Scroll + ImageLoaded）
  }
  this.#animationRunning = true

  const renderFrame = () => {
    // 1. 惯性滚动：每帧更新速度和位置，然后重绘
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }

    // 2. 检查 loading items → 仅在 ID 集合变化时才发送 RenderLoading
    const loadingItems = this.#gridItems.filter((item) => item.status !== 'loaded')
    const ids = loadingItems.map((item) => item.id)
    if (ids.length > 0) {
      // idsChanged 优化：避免每帧都向主线程发送相同的 ID 列表
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

    // 3. 条件退出：只有当所有工作都完成时才停止循环
    const hasWork = this.#isInertiaActive || ids.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false  // 释放循环，允许下次重新启动
    }
  }

  renderFrame()  // 立即执行首帧，不等待下一个 vsync
}
```

**设计要点**：

- **`idsChanged` 优化**：每帧都 filter + map 后得到 loading IDs，但只有当集合内容真正变化时才发送 `RenderLoading` 消息。在图片加载期间，loading 列表可能连续几十帧保持不变——跳过这些冗余消息避免了主线程重复渲染相同占位符。
- **条件退出而非无限循环**：当惯性停止且没有 loading items 时，循环自动退出（`#animationRunning = false`）。这确保空闲时不会有 rAF 回调持续运行，节省 Worker 线程 CPU。
- **`renderFrame()` 立即调用**：首帧在 `#startAnimationLoop()` 调用时同步执行，而非等待下一个 vsync。这让动画响应更即时——用户滚动后不会有 16ms 的延迟才看到第一帧变化。
- **多入口防重复**：`Scroll`、`Render`、`ImageLoaded` 消息都可能触发 `#startAnimationLoop()`。开头的 `if (this.#animationRunning) return` 保证同一时刻只有一个循环在运行。

### 3.2 启动时机

- `Render` 消息到达时
- `Scroll` 消息到达时（开启惯性）
- `ImageLoaded` 消息到达时

### 3.3 停止条件

**同时满足**：
- 惯性滚动已停止（`#isInertiaActive = false`）
- 没有 loading 状态的 items

---

## 4. 渲染流水线（`#handleRerender`）

### 4.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#handleRerender() {
  if (this.#context) {
    try {
      // 步骤 1: 清除主画布全部内容
      this.#clear()
      // 步骤 2: 清除背景缓存层
      this.#clearBackground()
      // 步骤 3: 在背景层绘制纯色/渐变背景
      this.#handleRenderBackground()
      // 步骤 4: 将背景层一次性复制到主画布（比每帧重绘渐变快）
      this.#copyBackground()
      // 步骤 5: 保存当前变换状态
      this.#context.save()
      // 步骤 6: 应用滚动偏移（反向平移 = 模拟视口移动）
      this.#context.translate(-this.#scrollX, -this.#scrollY)
      // 步骤 7: 根据模式选择渲染策略
      if (this.#isLoopActive) {
        this.#renderLoopedItems(this.#gridItems)
      } else {
        this.#renderGridItems(this.#getVisibleItems(this.#gridItems))
      }
      // 步骤 8: 恢复变换状态（移除滚动偏移，为下一帧准备）
      this.#context.restore()
    } catch (error) {
      this.#sendError(error)
    }
  }
}

#clear() {
  this.#context.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
}

#clearBackground() {
  this.#backgroundContext.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
}

#handleRenderBackground() {
  const bgStyle = createBackgroundStyle(
    this.#backgroundContext,
    this.#clientWidth,
    this.#clientHeight,
    this.#config.core.backgroundColor || '#fff',
  )
  this.#backgroundContext.save()
  this.#backgroundContext.fillStyle = bgStyle
  this.#backgroundContext.fillRect(0, 0, this.#clientWidth, this.#clientHeight)
  this.#backgroundContext.restore()
}

#copyBackground() {
  this.#context.drawImage(this.#backgroundCanvas, 0, 0, this.#clientWidth, this.#clientHeight)
}
```

**设计要点**：

- **背景分离的性能意义**：渐变背景每帧需要 `createLinearGradient` + 多次 `addColorStop`，成本不低。缓存到独立 Canvas 后，每帧只需一次 `drawImage` 即可，开销从 O(stops 数量) 降为 O(1)。
- **`translate(-scrollX, -scrollY)` 坐标变换**：通过反向平移坐标系，所有 item 的绘制坐标保持为「内容坐标」不变（即布局计算出的 x/y），而视口看到的区域随滚动偏移变化。这比逐个修改每个 item 的绘制坐标高效得多。
- **`save()/restore()` 配对**：确保滚动偏移的 `translate` 不会泄漏到下一帧。如果省略 restore，下一帧的 translate 会叠加在上一帧基础上，导致偏移量指数增长。
- **普通模式 vs 循环模式**：普通模式先做视口裁剪（`#getVisibleItems`）再渲染可见项；循环模式直接按视口范围计算格子坐标并 modulo 映射，不需要预过滤。

### 4.2 坐标变换

```typescript
this.#context.translate(-this.#scrollX, -this.#scrollY)
```

通过反向平移坐标系，所有 item 的绘制坐标保持为「内容坐标」不变，而视口看到的区域随滚动变化。

---

## 5. 视口裁剪（`#getVisibleItems`）

### 5.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#getVisibleItems(items: GridItem[]): GridItem[] {
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferH = this.#clientHeight * buffer
  const bufferW = this.#clientWidth * buffer

  // 可见区域（含缓冲）：向四个方向各扩展 buffer 倍视口尺寸
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW

  const defaultW = this.#config?.core.style?.width ?? 0
  const defaultH = this.#config?.core.style?.height ?? 0

  return items.filter((item) => {
    const w = item.width ?? defaultW
    const h = item.height ?? defaultH
    // AABB 矩形相交检测：item 的右边界 > 可见区左边界 且 左边界 < 右边界...
    return item.x + w > left && item.x < right && item.y + h > top && item.y < bottom
  })
}
```

**设计要点**：

- **AABB 相交检测**：两个矩形不相交的条件是其中一个完全在另一个的某一边之外。取反即得相交条件：`item.x + w > left && item.x < right && item.y + h > top && item.y < bottom`。
- **`item.width ?? defaultW`**：瀑布流模式下每个 item 有独立尺寸，网格模式下所有 item 使用统一的 `style.width/height`。`??` 操作符兼顾两种情况。

### 5.2 缓冲区（Buffer）

`buffer = 1.0` 表示上下左右各扩展 1 个视口尺寸：

```
         ┌─── buffer zone ───┐
         │                   │
    ┌────┼───────────────────┼────┐
    │    │   Viewport        │    │
    │    │                   │    │
    └────┼───────────────────┼────┘
         │                   │
         └───────────────────┘
```

**为什么需要缓冲**：快速滚动时，如果只渲染精确视口内的元素，用户会看到边缘的空白。缓冲区预渲染视口外的元素，确保滚动流畅。

### 5.3 性能意义

- 10000 个元素，视口可能只显示 20-50 个
- 带 buffer 可能渲染 60-150 个
- 比全量渲染 10000 个快 100 倍以上

---

## 6. 惯性滚动物理模型

### 6.1 滚动事件处理

```typescript
// src/core/worker/offscreen-canvas.ts
#handleScroll(payload: ScrollPayload) {
  const scroll = this.#config?.interaction?.scroll
  // 读取方向禁用配置
  const disableH = scroll?.disabled?.horizontal ?? false
  const disableV = scroll?.disabled?.vertical ?? false
  // 禁用方向的增量归零
  const dx = disableH ? 0 : payload.deltaX
  const dy = disableV ? 0 : payload.deltaY

  // 立即应用滚动增量
  this.#scrollX += dx
  this.#scrollY += dy
  this.#clampScroll()

  // 如果启用惯性，记录速度并启动动画循环
  const inertia = scroll?.inertia ?? true
  if (inertia) {
    this.#velocityX = dx
    this.#velocityY = dy
    this.#isInertiaActive = true
    this.#startAnimationLoop()
  }

  // 不管是否有惯性，都立即重绘一帧（响应用户输入的即时反馈）
  this.#handleRerender()
  this.#checkLoadMore()
}
```

**设计要点**：

- **即时 + 惯性分离**：`scrollX/Y += dx/dy` 提供即时反馈（用户手指在屏幕上拖动时），`velocityX/Y = dx/dy` 将最后一帧的增量作为惯性初速度。松手后惯性接管，逐帧衰减。
- **方向禁用**：禁用某方向后增量归零，但仍调用 `clampScroll()` 和 `handleRerender()`，确保另一个方向的滚动正常工作。
- **`inertia` 默认启用**：大多数现代 UI 用户期望有惯性滚动。设为 `false` 时，松手后内容立即停止，适合需要精确定位的场景。

### 6.2 物理公式

```
每帧:
  velocity = velocity × friction     (速度衰减)
  position = position + velocity     (位移更新)

停止条件:
  |velocity| < threshold (0.5px)
```

### 6.3 完整 tickInertia 实现

```typescript
// src/core/worker/offscreen-canvas.ts
#tickInertia() {
  const friction = this.#config?.interaction?.scroll?.friction ?? 0.95
  const threshold = 0.5

  this.#velocityX *= friction   // 速度衰减
  this.#velocityY *= friction

  this.#scrollX += this.#velocityX  // 位移更新
  this.#scrollY += this.#velocityY

  this.#clampScroll()  // 边界约束

  // 速度低于阈值时完全停止，避免无限趋近零
  if (Math.abs(this.#velocityX) < threshold && Math.abs(this.#velocityY) < threshold) {
    this.#velocityX = 0
    this.#velocityY = 0
    this.#isInertiaActive = false  // 标记惯性结束 → 动画循环可退出
  }

  this.#checkLoadMore()  // 每帧检查：惯性滚动可能到达加载阈值
}
```

**设计要点**：

- **`threshold = 0.5`**：亚像素速度（< 0.5px/frame）对用户不可感知，继续衰减只是浪费 CPU。直接截断为 0 并停止惯性。
- **`#checkLoadMore()` 在惯性中调用**：用户快速滑动后松手，惯性可能在几十帧后才到达内容底部。每帧检查确保 loadMore 在惯性滚动期间也能触发，而不是必须等惯性停止后再检查。

### 6.3 摩擦系数的影响

| friction | 效果 | 适用场景 |
|----------|------|---------|
| 0.99 | 滑动很远 | 大型画廊 |
| 0.95 | 适中（默认） | 通用 |
| 0.90 | 快速停止 | 精确定位 |
| 0.80 | 几乎无惯性 | 类似 DOM 滚动 |

### 6.4 衰减曲线

以 friction=0.95、初始速度=100 为例：
```
帧  0: v=100.0  →  位移: 100.0
帧  5: v=77.4   →  累计: 487.6
帧 10: v=59.9   →  累计: 801.3
帧 20: v=35.8   →  累计: 1242.5
帧 40: v=12.9   →  累计: 1735.3
帧 60: v=4.6    →  累计: 1907.4
帧 88: v=0.5    →  停止
```

---

## 7. 滚动边界约束（`#clampScroll`）

### 7.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#clampScroll() {
  if (this.#isLoopActive) {
    // 循环模式：不做边界限制，允许无限滚动
    this.#wrapScroll()
  } else {
    // 普通模式：约束在 [0, contentSize - viewportSize] 范围内
    const maxX = Math.max(0, this.#contentWidth - this.#clientWidth)
    const maxY = Math.max(0, this.#contentHeight - this.#clientHeight)
    this.#scrollX = Math.max(0, Math.min(this.#scrollX, maxX))
    this.#scrollY = Math.max(0, Math.min(this.#scrollY, maxY))
  }
}

get #isLoopActive(): boolean {
  const loopEnabled = this.#config?.interaction?.scroll?.loop ?? true
  // 循环启用的前提：1. 配置中 loop 为 true  2. 所有数据已加载完毕
  return loopEnabled && !this.#loadMoreState.hasMore
}

#wrapScroll() {
  const disableH = this.#config?.interaction?.scroll?.disabled?.horizontal ?? false
  const disableV = this.#config?.interaction?.scroll?.disabled?.vertical ?? false
  // 禁用方向直接归零，启用方向不做限制（允许任意值）
  if (disableH) {
    this.#scrollX = 0
  }
  if (disableV) {
    this.#scrollY = 0
  }
}
```

**设计要点**：

- **`Math.max(0, contentWidth - clientWidth)`**：当内容宽度小于视口宽度时，`maxX = 0`，滚动被锁定（没有可滚动的空间）。这避免了内容少于一屏时出现不必要的滚动。
- **循环模式不做 clamp**：循环模式下滚动位置可以无限增长或减小，`#renderLoopedItems` 通过 modulo 将任意位置映射回有限的内容区域。`#wrapScroll` 只处理禁用方向的归零。
- **`!this.#loadMoreState.hasMore` 条件**：只有在所有数据加载完毕后才启用循环。如果还有更多数据待加载，循环模式会导致用户看到重复内容，违背无限滚动的预期。

---

## 8. 无缝循环模式（`#renderLoopedItems`）

### 8.1 原理

在循环模式下，content 被视为无限重复的网格。通过 modulo 运算将任意位置映射回有限的数据集：

```
视口位置 → 网格坐标 (col, row) → 线性索引 → itemIndex = linearIndex % totalItems
```

### 8.2 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#renderLoopedItems(items: GridItem[]): void {
  if (!this.#context || !this.#config?.core.style || items.length === 0) {
    return
  }
  const { width: itemW, height: itemH, gap = 0, radius = 0 } = this.#config.core.style
  const blockW = itemW + gap     // 单个格子占据的总宽度（含间距）
  const blockH = itemH + gap     // 单个格子占据的总高度（含间距）
  // 根据视口宽度计算列数
  const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))

  // 使用 buffer 扩展渲染范围，确保快速滚动时无空白
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferW = this.#clientWidth * buffer
  const bufferH = this.#clientHeight * buffer
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH

  // 计算视口覆盖的格子范围（可能包含负数索引）
  const colStart = Math.floor(left / blockW)
  const colEnd = Math.ceil(right / blockW) - 1
  const rowStart = Math.floor(top / blockH)
  const rowEnd = Math.ceil(bottom / blockH) - 1

  const totalItems = items.length

  // 遍历所有可见格子
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      // 列号 modulo：处理负数列号（向左滚动时）
      const wrappedCol = ((col % columns) + columns) % columns
      // 列溢出转行偏移：col 超出 columns 时增加行号
      const extraRows = Math.floor(col / columns)
      // 线性化索引：将 2D 坐标转为 1D
      const linearIndex = (row + extraRows) * columns + wrappedCol
      // 最终 modulo：映射到实际数据项
      const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
      const item = items[itemIndex]
      if (!item?.image) {
        continue  // 跳过尚未加载的项
      }

      // 使用格子坐标（非 item 坐标）作为绘制位置
      const drawX = col * blockW
      const drawY = row * blockH

      // 绘制（含可选圆角）
      if (radius > 0) {
        this.#context.save()
        this.#context.beginPath()
        this.#context.roundRect(drawX, drawY, itemW, itemH, radius)
        this.#context.clip()
        this.#context.drawImage(item.image, drawX, drawY, itemW, itemH)
        this.#context.restore()
      } else {
        this.#context.drawImage(item.image, drawX, drawY, itemW, itemH)
      }
    }
  }
}
```

**设计要点**：

- **格子坐标 vs item 坐标**：普通模式使用 `item.x/y`（布局计算出的绝对位置），循环模式使用 `col * blockW / row * blockH`（格子自身的位置）。因为循环模式下同一个 item 可能同时出现在多个位置。
- **`columns` 基于视口计算**：`Math.ceil(clientWidth / blockW)` 确保一行能填满视口宽度。这个值在 resize 时会变化，自动适应不同容器宽度。
- **`!item?.image` 跳过**：循环模式只在所有数据加载完毕后启用，但 `items` 数组中理论上不应有 `image = null` 的项。此检查是防御性编程。

### 8.3 双 modulo 的含义

- `((col % columns) + columns) % columns`：处理负数列号（向左滚动时 col 为负）
- `((linearIndex % totalItems) + totalItems) % totalItems`：处理负数线性索引

JavaScript 的 `%` 运算对负数保留符号，需要额外 `+ N) % N` 确保结果为正。

### 8.4 水平溢出处理

当 col 超出列数时，`extraRows = Math.floor(col / columns)` 将多余的列映射为行偏移，实现水平方向的自然衔接。

---

## 9. 命中检测（`#handleClick`）

### 9.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#handleClick(payload: ClickPayload) {
  const { x, y } = payload
  // CSS 坐标 → 内容坐标（加上滚动偏移）
  const contentX = x + this.#scrollX
  const contentY = y + this.#scrollY
  const defaultW = this.#config?.core.style?.width ?? 0
  const defaultH = this.#config?.core.style?.height ?? 0
  const gap = this.#config?.core.style?.gap ?? 0
  const blockW = defaultW + gap
  const blockH = defaultH + gap
  const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))

  if (this.#isLoopActive) {
    // ─── 循环模式：通过格子坐标数学计算命中 ───
    const col = Math.floor(contentX / blockW)
    const row = Math.floor(contentY / blockH)
    // 检查点击是否在格子的有效区域内（排除 gap 区域）
    const cellX = contentX - col * blockW
    const cellY = contentY - row * blockH
    if (cellX > defaultW || cellY > defaultH) {
      // 点击落在 gap 上，视为未命中
      this.#sendMessage(MessageType.ClickResult, null)
      return
    }
    // modulo 映射到实际 item
    const linearIndex = row * columns + col
    const totalItems = this.#gridItems.length
    const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
    const item = this.#gridItems[itemIndex]
    if (item?.image) {
      this.#sendMessage(MessageType.ClickResult, {
        item,
        index: item.itemIndex,
        row,
        column: col,
      })
    } else {
      this.#sendMessage(MessageType.ClickResult, null)
    }
  } else {
    // ─── 普通模式：遍历查找命中项 ───
    const hitItem = this.#findHitItem(contentX, contentY, defaultW, defaultH)
    if (hitItem) {
      const row = Math.floor(hitItem.itemIndex / columns)
      const column = hitItem.itemIndex % columns
      this.#sendMessage(MessageType.ClickResult, {
        item: hitItem,
        index: hitItem.itemIndex,
        row,
        column,
      })
    } else {
      this.#sendMessage(MessageType.ClickResult, null)
    }
  }
}

#findHitItem(x: number, y: number, defaultW: number, defaultH: number): GridItem | null {
  // 逆序遍历：后渲染的元素视觉上在上层，优先被命中
  for (let i = this.#gridItems.length - 1; i >= 0; i--) {
    const item = this.#gridItems[i]
    const w = item.width ?? defaultW
    const h = item.height ?? defaultH
    if (x >= item.x && x < item.x + w && y >= item.y && y < item.y + h) {
      return item
    }
  }
  return null
}
```

**设计要点**：

- **两种命中检测策略**：循环模式下 item 的"位置"是动态计算的（同一 item 在多个格子中出现），不能遍历查找。转而用数学方法直接计算点击落在哪个格子，再 modulo 映射到 item。普通模式下 item 有唯一的布局坐标，逆序遍历即可。
- **Gap 排除检测**：`cellX > defaultW || cellY > defaultH` 判断点击是否落在两个 item 之间的间距区域。间距不属于任何 item，应返回 null。
- **逆序遍历**（`i = length - 1; i >= 0; i--`）：数组末尾的元素最后渲染，在视觉上层叠在前面。逆序遍历确保用户点击到重叠区域时，命中最上层的元素（与视觉一致）。
- **`row` 和 `column` 的计算**：普通模式下通过 `itemIndex / columns` 和 `itemIndex % columns` 从线性索引反推行列号。这让回调中的 `row/column` 信息对调用方有意义（如高亮整行/整列）。

---

## 10. LoadMore 触发（`#checkLoadMore`）

### 10.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#checkLoadMore() {
  // 三个前置条件任一不满足则跳过
  if (!this.#config?.loader || this.#loadMoreState.loading || !this.#loadMoreState.hasMore) {
    return
  }
  const threshold = this.#config.interaction?.scroll?.threshold
  // 计算到边界的剩余距离
  const remainingY = this.#contentHeight - this.#clientHeight - this.#scrollY
  const remainingX = this.#contentWidth - this.#clientWidth - this.#scrollX
  // 默认阈值 = 一个视口的距离
  const thresholdY = threshold ?? this.#clientHeight
  const thresholdX = threshold ?? this.#clientWidth
  // 任一方向接近边界时触发
  if (remainingY <= thresholdY || remainingX <= thresholdX) {
    this.#loadMoreState.loading = true   // 防重入锁
    this.#sendMessage(MessageType.LoadMore, null)
  }
}
```

**设计要点**：

- **`loading` 防重入锁**：一旦发送 LoadMore 消息，立即置为 true。主线程处理完返回 `LoadMoreResponse` 后才重置。这防止了惯性滚动期间每帧都触发 loadMore。
- **`!hasMore` 提前退出**：当上次加载返回 `hasMore: false`，后续不再检查，永久停止分页。
- **双方向检查（Y 和 X）**：同时支持垂直和水平方向的无限滚动。横向画廊场景中 `remainingX` 先到达阈值，纵向瀑布流中 `remainingY` 先到达。
- **默认阈值 = 视口尺寸**：在距离底部还有一个视口高度时就开始加载。用户以正常速度滚动时，新数据在看到空白之前就已经准备好了。

---

## 11. Resize 响应

### 11.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
async #handleResize(payload: ResizePayload) {
  if (!this.#context) {
    return
  }
  try {
    const { clientHeight, clientWidth, dpr } = payload
    // 三个维度独立检测变化
    const w = clientWidth !== this.#clientWidth
    const h = clientHeight !== this.#clientHeight
    const d = dpr !== this.#dpr

    // 只在实际变化时执行（避免冗余 resize 事件导致的重复工作）
    if (w || h || d) {
      this.#clear()
      // 重新设置物理像素尺寸
      this.#canvas.width = payload.clientWidth * payload.dpr
      this.#canvas.height = payload.clientHeight * payload.dpr
      this.#backgroundCanvas.width = clientWidth * dpr
      this.#backgroundCanvas.height = clientHeight * dpr

      // 更新缓存的尺寸状态
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
      this.#dpr = dpr

      // 重新设置 DPR 变换（canvas 尺寸变化会重置所有 context 状态）
      this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.#context.imageSmoothingEnabled = true
      this.#context.imageSmoothingQuality = 'high'
      this.#backgroundContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.#backgroundContext.imageSmoothingEnabled = true
      this.#backgroundContext.imageSmoothingQuality = 'high'

      // 容器尺寸变了，列数可能变化 → 需要重新布局
      this.#performLayout()
      this.#handleRerender()
      this.#checkLoadMore()  // resize 后可能暴露更多空间，检查是否需要加载
    }
  } catch (error) {
    this.#sendError(error)
  }
}
```

**设计要点**：

- **三条件独立检测**：宽度、高度、DPR 变化是独立事件。窗口可能只改变宽度（拖拽边缘），或只改变 DPR（拖到不同密度屏幕），分别检测避免遗漏。
- **设置 `canvas.width/height` 会重置 context 状态**：这是 Canvas API 的已知行为——修改画布尺寸后，之前设置的 `setTransform`、`imageSmoothingQuality` 等全部重置为默认值。所以必须在修改尺寸后重新设置。
- **`#checkLoadMore()` 在 resize 后调用**：容器变大可能导致 `remainingY` 减小（可见区域变大，到底部的距离变短），需要及时触发加载。

---

## 12. 数据更新处理

### 12.1 LoadMoreResponse 处理

```typescript
// src/core/worker/offscreen-canvas.ts
#handleLoadMoreResponse(payload: LoadMoreResponsePayload) {
  this.#loadMoreState.loading = false   // 释放防重入锁
  if (!payload.hasMore) {
    this.#loadMoreState.hasMore = false  // 永久停止分页
  }
  if (payload.data.length > 0) {
    // 将新加载的 ImageBitmap 转为 GridItem 并追加到数据列表
    const newItems = payload.data.map((bitmap, i) => ({
      id: nanoid(),
      image: bitmap,
      status: 'loaded' as const,
      x: 0,
      y: 0,
      itemIndex: this.#allItems.length + i,  // 索引接续已有数据
    }))
    this.#allItems.push(...newItems)
    this.#performLayout()      // 新数据加入后重新计算布局
    this.#handleRerender()     // 立即绘制新内容
  }
  this.#checkLoadMore()  // 检查新数据是否足以填满视口，不够则再次触发
}
```

### 12.2 ImageLoaded 处理

```typescript
// src/core/worker/offscreen-canvas.ts
#handleImageLoaded(payload: ImageLoadedPayload) {
  const item = this.#allItems[payload.index]
  if (!item) {
    return  // 防御：索引越界（不应发生）
  }
  const wasLoading = item.status === 'loading'
  // 就地更新 item 状态
  item.image = payload.bitmap
  item.status = 'loaded'
  item.width = payload.width
  item.height = payload.height
  if (wasLoading) {
    // 通知主线程释放此 ID 的占位符资源
    this.#sendMessage(MessageType.RemoveLoading, item.id)
  }
  // 尺寸可能变化 → 重新布局（瀑布流中新图片的实际高度影响布局）
  this.#performLayout()
  this.#handleRerender()
  this.#startAnimationLoop()  // 确保动画循环运行（处理其他仍在 loading 的项）
}
```

**设计要点**：

- **`itemIndex: this.#allItems.length + i`**：新 item 的索引从现有数据的末尾开始编号，确保索引全局唯一且递增。
- **`#checkLoadMore()` 在 loadMore 响应后再次调用**：一页数据可能不足以填满扩展后的视口（比如 pageSize=10 但视口能显示 15 个）。再次检查确保不会出现空白。
- **`wasLoading` 检查**：只有从 loading → loaded 的转变才需要发送 `RemoveLoading`。如果 item 因为 loadMore 已经是 loaded 状态（边缘情况），不应发送多余的消息。
- **`#startAnimationLoop()`**：图片加载完成后重启动画循环，因为可能还有其他 loading 项需要继续渲染占位符动画。

---

## 13. 图片绘制

### 13.1 完整实现

```typescript
// src/core/worker/offscreen-canvas.ts
#renderGridItems(gridItems: GridItem[]): void {
  if (!this.#context || !this.#config?.core.style || gridItems.length === 0) {
    return
  }
  const { width: defaultWidth, height: defaultHeight, radius = 0 } = this.#config.core.style
  // 根据是否有圆角分发到不同绘制路径（避免无圆角时每帧执行 save/clip/restore）
  if (radius > 0) {
    this.#renderWithRadius(gridItems, defaultWidth, defaultHeight, radius)
  } else {
    this.#renderWithoutRadius(gridItems, defaultWidth, defaultHeight)
  }
}

#renderWithoutRadius(items: GridItem[], defaultWidth: number, defaultHeight: number): void {
  for (const item of items) {
    if (item.image) {
      const w = item.width ?? defaultWidth
      const h = item.height ?? defaultHeight
      this.#context?.drawImage(item.image, item.x, item.y, w, h)
    }
  }
}

#renderWithRadius(
  items: GridItem[],
  defaultWidth: number,
  defaultHeight: number,
  radius: number,
): void {
  for (const item of items) {
    if (item.image) {
      const w = item.width ?? defaultWidth
      const h = item.height ?? defaultHeight
      this.#context?.save()
      this.#context?.beginPath()
      this.#context?.roundRect(item.x, item.y, w, h, radius)
      this.#context?.clip()      // 裁剪区域限制绘制范围
      this.#context?.drawImage(item.image, item.x, item.y, w, h)
      this.#context?.restore()   // 恢复裁剪状态，不影响下一个 item
    }
  }
}
```

**设计要点**：

- **圆角/无圆角分离为两个方法**：`save()/beginPath()/roundRect()/clip()/restore()` 在无圆角时完全不需要。分离后无圆角路径只有一行 `drawImage`，减少了 5 次 Context API 调用/项。对于 100 个可见项，节省 500 次调用。
- **`item.width ?? defaultWidth`**：瀑布流模式下 item 有独立的宽高（由图片原始比例决定），网格模式下使用统一的 `style.width/height`。`??` 操作符优雅地兼容两种场景。
- **`roundRect + clip` 实现圆角**：每个元素独立 `save/restore` 隔离裁剪状态。如果不 restore，裁剪区域会叠加（取交集），后续 item 的绘制区域会越来越小。
