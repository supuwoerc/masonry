# 布局策略：Grid 与 Masonry

> 本文档介绍两种布局算法的实现细节、Strategy 模式设计和扩展方式。

## 模块定位

布局策略负责计算每个元素的 x/y/width/height 坐标。它是 Worker 渲染引擎的前置步骤——先布局，后绘制。

## 涉及源文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/core/layout/grid-layout.ts` | 60 | 等高网格布局 |
| `src/core/layout/masonry-layout.ts` | 74 | 瀑布流布局 |
| `src/core/types.ts` (接口部分) | — | LayoutStrategy / LayoutInput / LayoutResult |

---

## 1. Strategy 模式设计

### 1.1 接口定义

```typescript
interface LayoutStrategy {
  calculate: (input: LayoutInput) => LayoutResult
}

interface LayoutInput {
  items: GridItem[]           // 待布局的数据项
  containerWidth: number      // 容器宽度（CSS 像素）
  containerHeight: number     // 容器高度
  style: GridItemStyle        // 网格项样式（width, height, gap, radius）
}

interface LayoutResult {
  items: GridItem[]           // 定位后的数据项（含 x, y, width, height）
  contentWidth: number        // 内容总宽度
  contentHeight: number       // 内容总高度
  columns: number             // 列数
}
```

### 1.2 策略选择

在 Worker 初始化时根据配置选择：

```typescript
const mode = this.#config.core.layout ?? 'grid'
this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()
```

### 1.3 布局触发时机

| 时机 | 原因 |
|------|------|
| Setup 完成 | 首次布局 |
| ImageLoaded | 图片尺寸可能影响瀑布流高度 |
| LoadMoreResponse | 新增数据项 |
| Resize | 容器宽度变化影响列数 |

---

## 2. GridLayout（等高网格）

### 2.1 算法概述

所有元素等宽等高，按行列均匀排列。

### 2.2 核心计算

以下是 `GridLayout.calculate()` 的完整实现：

```typescript
// src/core/layout/grid-layout.ts
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, height: itemHeight, gap = 0 } = style

  // 块尺寸 = 元素宽/高 + 间距，作为网格的基本单元
  const blockWidth = itemWidth + gap
  const blockHeight = itemHeight + gap
  // 列数 = 容器宽度 / 块宽度（向上取整，确保尽量多列）
  const columns = Math.max(1, Math.ceil(containerWidth / blockWidth))

  const positioned: GridItem[] = []

  for (let i = 0; i < items.length; i++) {
    const column = i % columns                 // 列号：取模实现行主序排列
    const row = Math.floor(i / columns)        // 行号：整除得到所在行
    const x = column * blockWidth
    const y = row * blockHeight
    const source = items[i]

    positioned.push({
      id: source?.id ?? nanoid(),              // 保留已有 ID，避免重布局时丢失引用
      image: source?.image ?? null,            // 保留已加载的 bitmap 引用
      status: source?.status ?? 'loading',     // 保留加载状态，防止状态被重置
      x,
      y,
      width: itemWidth,                        // Grid 模式下所有元素等宽等高
      height: itemHeight,
      itemIndex: source?.itemIndex ?? i,       // 保持数据源索引，用于点击回调
    })
  }

  const rows = Math.ceil(items.length / columns)
  return {
    items: positioned,
    contentWidth: columns * blockWidth - gap,  // 总宽减去右侧多余 gap
    contentHeight: rows * blockHeight - gap,   // 总高减去底部多余 gap
    columns,
  }
}
```

**设计要点**：

- **ID 保持** (`source?.id ?? nanoid()`)：重布局（如 Resize、图片加载完成）时复用已有 ID，确保占位符的 Map 缓存能正确命中，避免每次布局都创建新的占位符动画状态。
- **状态保持** (`source?.status ?? 'loading'`)：布局计算是无副作用的纯位置运算，不应改变项目的加载状态。
- **`contentWidth/Height` 减去 gap**：最后一个元素的右侧/底部不需要 gap，`columns * blockWidth - gap` 去掉了末尾的冗余间距。

### 2.3 算法可视化

```
containerWidth = 650, itemWidth = 200, gap = 10
blockWidth = 210
columns = Math.ceil(650 / 210) = 4

  col0     col1     col2     col3
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │  0   │ │  1   │ │  2   │ │  3   │  row0
  └──────┘ └──────┘ └──────┘ └──────┘
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │  4   │ │  5   │ │  6   │ │  7   │  row1
  └──────┘ └──────┘ └──────┘ └──────┘
```

### 2.4 复杂度

- 时间：O(n)，单次遍历
- 空间：O(n)，输出定位数组

### 2.5 列数计算使用 `Math.ceil` 的原因

`Math.ceil(containerWidth / blockWidth)` 确保容器宽度能容纳尽可能多的列。比如容器 650px、块宽 210px → ceil(3.095) = 4 列。最后一列可能部分超出容器，但由于 gap 的存在，实际内容宽度 `4*210-10=830` 超过容器时，会通过水平滚动可见。

---

## 3. MasonryLayout（瀑布流）

### 3.1 算法概述

将每个元素放入当前最短的列中，实现不等高瀑布流排列。

### 3.2 核心计算

以下是 `MasonryLayout.calculate()` 的完整实现：

```typescript
// src/core/layout/masonry-layout.ts
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, gap = 0 } = style

  const blockWidth = itemWidth + gap
  // 瀑布流使用 Math.floor：确保所有列都完全在容器内，不产生水平溢出
  const columns = Math.max(1, Math.floor(containerWidth / blockWidth))
  // 列高度数组：追踪每列的累计高度，用于决定下一个元素放入哪列
  const columnHeights = Array.from<number>({ length: columns }).fill(0)

  // 使用 map 而非 for 循环：每个元素的定位依赖当前列高度状态，
  // map 的语义更清晰地表达"输入 → 输出"的映射关系
  const positioned: GridItem[] = items.map((item, index) => {
    // 贪心策略：每次放入最短列，使各列高度尽量均匀
    const shortestCol = columnHeights.indexOf(Math.min(...columnHeights))
    const x = shortestCol * blockWidth
    const y = columnHeights[shortestCol]

    // 根据图片宽高比计算实际渲染高度
    const itemHeight = this.#resolveItemHeight(item, itemWidth, style.height)
    // 累加列高度（元素高度 + gap）
    columnHeights[shortestCol] += itemHeight + gap

    return {
      id: item.id ?? nanoid(),
      image: item.image,
      status: item.status,
      x,
      y,
      width: itemWidth,          // 宽度统一，高度各异
      height: itemHeight,
      itemIndex: item.itemIndex ?? index,
    }
  })

  // Math.max(0, ...) 防御性编程：当 items 为空时 columnHeights 全为 0，
  // Math.max(...columnHeights) - gap 会得到负数
  const contentHeight = Math.max(0, Math.max(...columnHeights) - gap)
  const contentWidth = Math.max(0, columns * blockWidth - gap)

  return {
    items: positioned,
    contentWidth,
    contentHeight,
    columns,
  }
}
```

**设计要点**：

- **贪心最短列策略** (`columnHeights.indexOf(Math.min(...columnHeights))`)：时间复杂度 O(k)（k=列数），对于典型的 3-6 列场景性能足够。如果列数极大可以用最小堆优化，但在实际使用中列数由容器宽度/元素宽度决定，通常不超过 10。
- **`Math.max(0, ...)` 安全包装**：避免空数组场景下 `Math.max(...[]) = -Infinity`，以及减去 gap 后可能得到负值的问题。
- **与 GridLayout 的关键差异**：Grid 使用简单的 `i % columns` 行主序，Masonry 使用最短列贪心，因此 Masonry 的元素排列顺序不一定是从左到右的。

### 3.3 高度解析优先级

`#resolveItemHeight()` 实现了三级 fallback 策略，确保无论数据完整性如何都能给出合理的高度值：

```typescript
// src/core/layout/masonry-layout.ts
#resolveItemHeight(item: GridItem, targetWidth: number, fallbackHeight: number): number {
  // 优先级 1：使用 ItemDescriptor 中预声明的宽高（数据源提供的元数据）
  // 条件：宽和高都必须 > 0，防止除零错误
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return Math.round(targetWidth * (item.height / item.width))
  }

  // 优先级 2：使用已加载的 ImageBitmap 的实际像素尺寸
  // 这在图片加载完成但未提供元数据的场景下生效
  if (item.image && item.image.width > 0 && item.image.height > 0) {
    return Math.round(targetWidth * (item.image.height / item.image.width))
  }

  // 优先级 3：使用配置中的默认高度（style.height）
  // 这是图片尚未加载、也无预设尺寸时的兜底值
  return fallbackHeight
}
```

**设计要点**：

- **`Math.round()` 取整**：避免亚像素布局导致的累积误差。如果不取整，多行元素的列高度会出现浮点数累积偏移，导致视觉错位。
- **为什么同时检查 `width > 0` 和 `height > 0`**：防止 `0/width` 或 `height/0` 产生 NaN 或 Infinity，这些值传入后续布局计算会导致整个布局崩溃。
- **三级 fallback 的意义**：
  - 第 1 级：最快（无需等待图片加载），用于"已知尺寸的图片列表"场景
  - 第 2 级：图片加载完成后触发重布局时生效
  - 第 3 级：兜底值保证初始布局不会出错（元素会先以默认高度显示，加载完后重新计算）

### 3.4 算法可视化

```
containerWidth = 650, itemWidth = 200, gap = 10
blockWidth = 210
columns = Math.floor(650 / 210) = 3

  col0           col1           col2
  ┌──────────┐   ┌──────────┐   ┌──────────┐
  │  item0   │   │  item1   │   │  item2   │
  │  h=280   │   │  h=200   │   │  h=350   │
  └──────────┘   └──────────┘   └──────────┘
                 ┌──────────┐
                 │  item3   │  ← 放入最短列(col1, 高度210)
                 │  h=150   │
                 └──────────┘
  ┌──────────┐
  │  item4   │  ← 放入col0(高度290) vs col1(370) vs col2(360)
  │  h=220   │
  └──────────┘
```

### 3.5 复杂度

- 时间：O(n × k)，n=元素数，k=列数（每次找最短列）
- 空间：O(n + k)

### 3.6 列数计算使用 `Math.floor` 的原因

与 Grid 不同，瀑布流使用 `Math.floor`：
- 瀑布流不支持水平滚动
- 必须确保所有列都完全在容器内
- `Math.floor(650 / 210) = 3` → 3列占 `3*210-10 = 620px`，小于容器

---

## 4. Grid vs Masonry 对比

| 特性 | GridLayout | MasonryLayout |
|------|-----------|---------------|
| 元素高度 | 固定 | 根据宽高比计算 |
| 列数计算 | `Math.ceil` | `Math.floor` |
| 放置策略 | 行主序（左到右、上到下） | 最短列优先 |
| 水平滚动 | 可能需要 | 不需要 |
| 适合场景 | 统一尺寸的缩略图网格 | Pinterest 风格的图片流 |
| 时间复杂度 | O(n) | O(n×k) |
| 图片尺寸要求 | 不需要 | 提供宽高比效果更好 |

---

## 5. 布局结果的使用

### 5.1 `#performLayout()` 完整实现

布局计算在 Worker 线程中由 `#performLayout()` 触发，它是布局策略与渲染引擎之间的桥梁：

```typescript
// src/core/worker/offscreen-canvas.ts
#performLayout() {
  // 防御：配置未就绪时跳过（Setup 消息可能尚未到达）
  if (!this.#config?.core.style) {
    return
  }

  // 组装布局输入
  const input = {
    items: this.#allItems,             // 所有数据项（含已加载和加载中的）
    containerWidth: this.#clientWidth,  // 当前容器的 CSS 宽度
    containerHeight: this.#clientHeight,
    style: this.#config.core.style,    // 网格项样式配置
  }

  // 调用策略模式：根据初始化时选择的策略执行布局
  const result = this.#layoutStrategy.calculate(input)

  // 更新渲染引擎状态
  this.#gridItems = result.items            // 替换定位后的项目数组
  this.#contentWidth = result.contentWidth  // 更新内容总尺寸
  this.#contentHeight = result.contentHeight

  // 重新约束滚动位置：布局变化后内容可能缩小，
  // 当前滚动位置可能超出新的最大范围
  this.#clampScroll()

  // 通知主线程布局已更新（用于 onLayoutUpdate 回调）
  this.#sendMessage(MessageType.LayoutUpdated, {
    contentWidth: result.contentWidth,
    contentHeight: result.contentHeight,
  })
}
```

**设计要点**：

- **`#clampScroll()` 调用时机**：必须在 contentWidth/Height 更新后立即调用。场景：用户已滚动到底部，此时容器缩小导致 contentHeight 减小，如果不 clamp，scrollY 会超出最大值，下一帧渲染会出现空白。
- **`LayoutUpdated` 始终发送**：即使布局结果与上次相同，主线程可能依赖此消息做 UI 同步（如滚动条更新）。发送空消息的成本远低于维护"是否变化"的对比逻辑。
- **布局结果的下游消费者**：
  - 视口裁剪 `#getVisibleItems()`：通过 x/y 判断是否在可视区域内
  - 元素绘制 `#renderGridItems()`：使用 x/y/width/height 调用 `drawImage`
  - 命中检测 `#handleClick()`：检查点击坐标是否落在某元素矩形内
  - 滚动边界 `#clampScroll()`：contentWidth/Height 决定最大滚动范围

### 5.2 布局与循环模式的交互

需要注意的是，当启用无缝循环模式（`scroll.loop = true` 且 `hasMore = false`）时，`#renderLoopedItems()` 不使用布局结果中的 x/y 坐标，而是基于 modulo 运算重新计算绘制位置。但它仍然依赖布局结果中的 `items` 数组来获取图片引用和状态。

这也解释了为什么循环模式仅支持 Grid 布局——Masonry 布局的不等高特性使得基于 modulo 的无缝拼接在数学上不可行（高度不同的列无法简单通过 blockH 取模对齐）。

---

## 6. 扩展新布局

实现步骤：

1. 创建新文件 `src/core/layout/my-layout.ts`
2. 实现 `LayoutStrategy` 接口
3. 在 `OffscreenCanvasWorker.#handleSetup` 中添加策略选择分支
4. 在 `LayoutMode` 类型中添加新模式

```typescript
// 示例：砖石布局
export class BrickLayout implements LayoutStrategy {
  calculate(input: LayoutInput): LayoutResult {
    // 自定义布局算法
    return { items: positioned, contentWidth, contentHeight, columns }
  }
}
```
