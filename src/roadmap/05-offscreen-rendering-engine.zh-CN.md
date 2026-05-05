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

收到 `Setup` 消息后执行：

```
1. 设置 Canvas 尺寸: width = clientWidth * dpr, height = clientHeight * dpr
2. 创建背景缓存 Canvas（同尺寸）
3. 获取 2D 上下文
4. 设置 DPR 变换: ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
5. 开启图像平滑: imageSmoothingQuality = 'high'
6. 选择布局策略: 'masonry' → MasonryLayout, 其他 → GridLayout
7. 处理初始 items:
   - ImageBitmap[] → 直接创建 loaded 状态的 GridItem[]
   - itemCount → 创建 loading 状态的 GridItem[]（等待图片加载）
8. 执行首次布局: #performLayout()
9. 发送 SetupResponse
```

### 2.1 DPR 变换原理

```typescript
this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
```

Canvas 物理像素 = CSS 像素 × DPR。通过 `setTransform` 缩放坐标系，后续所有绑制操作使用 CSS 像素单位，自动映射到物理像素，实现高清渲染。

---

## 3. 渲染循环（`#startAnimationLoop`）

### 3.1 循环逻辑

```typescript
#startAnimationLoop() {
  if (this.#animationRunning) return  // 防止重复启动
  this.#animationRunning = true

  const renderFrame = () => {
    // 1. 惯性滚动：更新位置和速度
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }

    // 2. 检查 loading items → 请求占位符
    const loadingItems = this.#gridItems.filter(item => item.status !== 'loaded')
    if (loadingItems changed) {
      this.#sendMessage(MessageType.RenderLoading, ids)
    }

    // 3. 条件退出
    const hasWork = this.#isInertiaActive || loadingItems.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false  // 停止循环
    }
  }

  renderFrame()
}
```

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

每帧的绘制步骤：

```
1. #clear()              → 清除主画布
2. #clearBackground()    → 清除背景层
3. #handleRenderBackground() → 绘制背景（纯色/渐变）到背景层
4. #copyBackground()     → 将背景层复制到主画布
5. ctx.save()
6. ctx.translate(-scrollX, -scrollY) → 应用滚动偏移
7. 绘制网格项:
   - 循环模式 → #renderLoopedItems()
   - 普通模式 → #renderGridItems(#getVisibleItems())
8. ctx.restore()
```

### 4.1 背景分离的性能意义

渐变背景的 `createLinearGradient` + `addColorStop` 每帧都调用是浪费的。背景层缓存后，每帧只需一次 `drawImage` 即可。

### 4.2 坐标变换

```typescript
this.#context.translate(-this.#scrollX, -this.#scrollY)
```

通过反向平移坐标系，所有 item 的绘制坐标保持为「内容坐标」不变，而视口看到的区域随滚动变化。

---

## 5. 视口裁剪（`#getVisibleItems`）

### 5.1 算法

```typescript
#getVisibleItems(items: GridItem[]): GridItem[] {
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferH = this.#clientHeight * buffer
  const bufferW = this.#clientWidth * buffer

  // 可见区域（含缓冲）
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW

  return items.filter((item) => {
    const w = item.width ?? defaultW
    const h = item.height ?? defaultH
    // 矩形相交检测
    return item.x + w > left && item.x < right
        && item.y + h > top && item.y < bottom
  })
}
```

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

### 6.1 物理公式

```
每帧:
  velocity = velocity × friction     (速度衰减)
  position = position + velocity     (位移更新)

停止条件:
  |velocity| < threshold (0.5px)
```

### 6.2 代码实现

```typescript
#tickInertia() {
  const friction = this.#config?.interaction?.scroll?.friction ?? 0.95
  const threshold = 0.5

  this.#velocityX *= friction   // 速度衰减
  this.#velocityY *= friction

  this.#scrollX += this.#velocityX  // 位移更新
  this.#scrollY += this.#velocityY

  this.#clampScroll()  // 边界约束

  if (Math.abs(this.#velocityX) < threshold && Math.abs(this.#velocityY) < threshold) {
    this.#velocityX = 0
    this.#velocityY = 0
    this.#isInertiaActive = false  // 停止
  }

  this.#checkLoadMore()  // 检查是否需要加载更多
}
```

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

### 7.1 普通模式

```typescript
const maxX = Math.max(0, this.#contentWidth - this.#clientWidth)
const maxY = Math.max(0, this.#contentHeight - this.#clientHeight)
this.#scrollX = Math.max(0, Math.min(this.#scrollX, maxX))
this.#scrollY = Math.max(0, Math.min(this.#scrollY, maxY))
```

约束范围：`[0, contentSize - viewportSize]`

### 7.2 循环模式

循环模式下不做 clamp，允许无限滚动：
```typescript
get #isLoopActive(): boolean {
  const loopEnabled = this.#config?.interaction?.scroll?.loop ?? true
  return loopEnabled && !this.#loadMoreState.hasMore
}
```

循环启用条件：`loop=true`（默认）且所有数据已加载完毕（`hasMore=false`）。

---

## 8. 无缝循环模式（`#renderLoopedItems`）

### 8.1 原理

在循环模式下，content 被视为无限重复的网格。通过 modulo 运算将任意位置映射回有限的数据集：

```
视口位置 → 网格坐标 (col, row) → 线性索引 → itemIndex = linearIndex % totalItems
```

### 8.2 核心算法

```typescript
#renderLoopedItems(items: GridItem[]): void {
  // 1. 计算视口覆盖的网格范围
  const colStart = Math.floor(left / blockW)
  const colEnd = Math.ceil(right / blockW) - 1
  const rowStart = Math.floor(top / blockH)
  const rowEnd = Math.ceil(bottom / blockH) - 1

  // 2. 遍历所有可见格子
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      // 3. Modulo 映射
      const wrappedCol = ((col % columns) + columns) % columns
      const extraRows = Math.floor(col / columns)
      const linearIndex = (row + extraRows) * columns + wrappedCol
      const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems

      // 4. 计算绘制位置
      const drawX = col * blockW
      const drawY = row * blockH

      // 5. 绘制
      ctx.drawImage(items[itemIndex].image, drawX, drawY, itemW, itemH)
    }
  }
}
```

### 8.3 双 modulo 的含义

- `((col % columns) + columns) % columns`：处理负数列号（向左滚动时 col 为负）
- `((linearIndex % totalItems) + totalItems) % totalItems`：处理负数线性索引

JavaScript 的 `%` 运算对负数保留符号，需要额外 `+ N) % N` 确保结果为正。

### 8.4 水平溢出处理

当 col 超出列数时，`extraRows = Math.floor(col / columns)` 将多余的列映射为行偏移，实现水平方向的自然衔接。

---

## 9. 命中检测（`#handleClick`）

### 9.1 坐标转换

```typescript
const contentX = x + this.#scrollX  // CSS坐标 → 内容坐标
const contentY = y + this.#scrollY
```

### 9.2 循环模式命中

```typescript
// 计算点击落在哪个格子
const col = Math.floor(contentX / blockW)
const row = Math.floor(contentY / blockH)

// 检查是否点在格子内（排除 gap 区域）
const cellX = contentX - col * blockW
const cellY = contentY - row * blockH
if (cellX > defaultW || cellY > defaultH) return null  // 点在 gap 上

// modulo 映射到实际 item
const linearIndex = row * columns + col
const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
```

### 9.3 普通模式命中

逆序遍历所有 gridItems，检测矩形包含：

```typescript
#findHitItem(x, y, defaultW, defaultH): GridItem | null {
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

逆序遍历确保后渲染的元素（视觉上在上层）优先被命中。

---

## 10. LoadMore 触发（`#checkLoadMore`）

### 10.1 触发条件

```typescript
#checkLoadMore() {
  if (!loader || loading || !hasMore) return

  const remainingY = contentHeight - clientHeight - scrollY
  const remainingX = contentWidth - clientWidth - scrollX
  const thresholdY = threshold ?? clientHeight
  const thresholdX = threshold ?? clientWidth

  if (remainingY <= thresholdY || remainingX <= thresholdX) {
    this.#loadMoreState.loading = true
    this.#sendMessage(MessageType.LoadMore, null)
  }
}
```

### 10.2 阈值含义

默认阈值 = 视口高度/宽度，即距离底部/右侧还有一个视口距离时就触发加载，确保用户不会看到空白。

---

## 11. Resize 响应

```typescript
#handleResize(payload: ResizePayload) {
  // 只在尺寸或 DPR 实际变化时处理
  if (w || h || d) {
    canvas.width = clientWidth * dpr
    canvas.height = clientHeight * dpr
    backgroundCanvas.width = clientWidth * dpr
    backgroundCanvas.height = clientHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 重新布局 + 重新渲染
    this.#performLayout()
    this.#handleRerender()
    this.#checkLoadMore()
  }
}
```

---

## 12. 图片绘制

### 12.1 无圆角

```typescript
for (const item of items) {
  if (item.image) {
    ctx.drawImage(item.image, item.x, item.y, w, h)
  }
}
```

### 12.2 有圆角

```typescript
for (const item of items) {
  if (item.image) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(item.x, item.y, w, h, radius)
    ctx.clip()  // 裁剪区域
    ctx.drawImage(item.image, item.x, item.y, w, h)
    ctx.restore()
  }
}
```

`roundRect + clip` 实现圆角效果，每个元素独立 save/restore 以隔离裁剪状态。
