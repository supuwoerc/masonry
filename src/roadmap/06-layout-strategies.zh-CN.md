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

```typescript
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, height: itemHeight, gap = 0 } = style

  // 块尺寸 = 元素 + 间距
  const blockWidth = itemWidth + gap
  const blockHeight = itemHeight + gap

  // 列数 = 容器宽度 / 块宽度（向上取整）
  const columns = Math.max(1, Math.ceil(containerWidth / blockWidth))

  // 每个元素的位置
  for (let i = 0; i < items.length; i++) {
    const column = i % columns        // 列号
    const row = Math.floor(i / columns) // 行号
    const x = column * blockWidth
    const y = row * blockHeight
  }

  // 内容尺寸
  const rows = Math.ceil(items.length / columns)
  contentWidth = columns * blockWidth - gap    // 减去最后一列多余的 gap
  contentHeight = rows * blockHeight - gap     // 减去最后一行多余的 gap
}
```

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

```typescript
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, gap = 0 } = style

  const blockWidth = itemWidth + gap
  // 列数使用 Math.floor（瀑布流不允许超出容器）
  const columns = Math.max(1, Math.floor(containerWidth / blockWidth))

  // 列高度数组（记录每列当前高度）
  const columnHeights = Array.from<number>({ length: columns }).fill(0)

  for (const item of items) {
    // 找到最短列
    const shortestCol = columnHeights.indexOf(Math.min(...columnHeights))

    // 元素位置
    const x = shortestCol * blockWidth
    const y = columnHeights[shortestCol]

    // 计算元素高度
    const itemHeight = this.#resolveItemHeight(item, itemWidth, style.height)

    // 更新列高度
    columnHeights[shortestCol] += itemHeight + gap
  }

  contentHeight = Math.max(...columnHeights) - gap
  contentWidth = columns * blockWidth - gap
}
```

### 3.3 高度解析优先级

```typescript
#resolveItemHeight(item: GridItem, targetWidth: number, fallbackHeight: number): number {
  // 1. 优先：item 自身携带的宽高（来自 ItemDescriptor）
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return Math.round(targetWidth * (item.height / item.width))
  }

  // 2. 次优：已加载的 ImageBitmap 尺寸
  if (item.image && item.image.width > 0 && item.image.height > 0) {
    return Math.round(targetWidth * (item.image.height / item.image.width))
  }

  // 3. 回退：配置的默认高度
  return fallbackHeight
}
```

**宽高比计算**：`targetWidth * (originalHeight / originalWidth)`，保持原始宽高比缩放到目标宽度。

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

`performLayout()` 返回后：

```typescript
#performLayout() {
  const result = this.#layoutStrategy.calculate(input)
  this.#gridItems = result.items          // 更新定位数组
  this.#contentWidth = result.contentWidth // 更新内容尺寸
  this.#contentHeight = result.contentHeight
  this.#clampScroll()                     // 重新约束滚动范围
  this.#sendMessage(MessageType.LayoutUpdated, { ... }) // 通知主线程
}
```

布局结果直接用于：
- 视口裁剪（通过 x/y 判断是否在视口内）
- 元素绘制（drawImage 使用 x/y/width/height）
- 命中检测（检查点击坐标是否在某元素矩形内）
- 滚动边界计算（contentWidth/Height 决定最大滚动范围）

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
