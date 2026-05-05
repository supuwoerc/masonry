# Layout Strategies: Grid & Masonry

> This document covers the implementation details of both layout algorithms, the Strategy pattern design, and how to extend with new layouts.

## Module Position

Layout strategies are responsible for calculating x/y/width/height coordinates for each element. They are a prerequisite step for the Worker rendering engine — layout first, then draw.

## Source Files

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/core/layout/grid-layout.ts` | 60 | Equal-height grid layout |
| `src/core/layout/masonry-layout.ts` | 74 | Masonry (waterfall) layout |
| `src/core/types.ts` (interfaces) | — | LayoutStrategy / LayoutInput / LayoutResult |

---

## 1. Strategy Pattern Design

### 1.1 Interface Definition

```typescript
interface LayoutStrategy {
  calculate: (input: LayoutInput) => LayoutResult
}

interface LayoutInput {
  items: GridItem[]           // Items to lay out
  containerWidth: number      // Container width (CSS pixels)
  containerHeight: number     // Container height
  style: GridItemStyle        // Item style (width, height, gap, radius)
}

interface LayoutResult {
  items: GridItem[]           // Positioned items (with x, y, width, height)
  contentWidth: number        // Total content width
  contentHeight: number       // Total content height
  columns: number             // Number of columns
}
```

### 1.2 Strategy Selection

Selected during Worker initialization based on configuration:

```typescript
const mode = this.#config.core.layout ?? 'grid'
this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()
```

### 1.3 Layout Trigger Points

| Trigger | Reason |
|---------|--------|
| Setup complete | Initial layout |
| ImageLoaded | Image dimensions may affect masonry heights |
| LoadMoreResponse | New data items added |
| Resize | Container width change affects column count |

---

## 2. GridLayout (Equal-Height Grid)

### 2.1 Algorithm Overview

All elements have equal width and height, arranged in a uniform row-column grid.

### 2.2 Core Calculation

```typescript
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, height: itemHeight, gap = 0 } = style

  // Block size = element + gap
  const blockWidth = itemWidth + gap
  const blockHeight = itemHeight + gap

  // Columns = container width / block width (ceiling)
  const columns = Math.max(1, Math.ceil(containerWidth / blockWidth))

  // Position each element
  for (let i = 0; i < items.length; i++) {
    const column = i % columns        // Column number
    const row = Math.floor(i / columns) // Row number
    const x = column * blockWidth
    const y = row * blockHeight
  }

  // Content dimensions
  const rows = Math.ceil(items.length / columns)
  contentWidth = columns * blockWidth - gap    // Subtract trailing gap
  contentHeight = rows * blockHeight - gap     // Subtract trailing gap
}
```

### 2.3 Algorithm Visualization

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

### 2.4 Complexity

- Time: O(n), single pass
- Space: O(n), output positioned array

### 2.5 Why `Math.ceil` for Column Count

`Math.ceil(containerWidth / blockWidth)` ensures the container fits as many columns as possible. For example, container 650px, block width 210px → ceil(3.095) = 4 columns. The last column may partially exceed the container, but since actual content width `4*210-10=830` exceeds the container, it becomes accessible via horizontal scrolling.

---

## 3. MasonryLayout (Waterfall)

### 3.1 Algorithm Overview

Places each element into the currently shortest column, achieving a variable-height waterfall arrangement.

### 3.2 Core Calculation

```typescript
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, gap = 0 } = style

  const blockWidth = itemWidth + gap
  // Columns use Math.floor (masonry doesn't allow container overflow)
  const columns = Math.max(1, Math.floor(containerWidth / blockWidth))

  // Column heights array (tracks current height of each column)
  const columnHeights = Array.from<number>({ length: columns }).fill(0)

  for (const item of items) {
    // Find shortest column
    const shortestCol = columnHeights.indexOf(Math.min(...columnHeights))

    // Element position
    const x = shortestCol * blockWidth
    const y = columnHeights[shortestCol]

    // Calculate element height
    const itemHeight = this.#resolveItemHeight(item, itemWidth, style.height)

    // Update column height
    columnHeights[shortestCol] += itemHeight + gap
  }

  contentHeight = Math.max(...columnHeights) - gap
  contentWidth = columns * blockWidth - gap
}
```

### 3.3 Height Resolution Priority

```typescript
#resolveItemHeight(item: GridItem, targetWidth: number, fallbackHeight: number): number {
  // 1. Primary: item's own width/height (from ItemDescriptor)
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return Math.round(targetWidth * (item.height / item.width))
  }

  // 2. Secondary: loaded ImageBitmap dimensions
  if (item.image && item.image.width > 0 && item.image.height > 0) {
    return Math.round(targetWidth * (item.image.height / item.image.width))
  }

  // 3. Fallback: configured default height
  return fallbackHeight
}
```

**Aspect ratio calculation**: `targetWidth * (originalHeight / originalWidth)`, scales to target width while maintaining original aspect ratio.

### 3.4 Algorithm Visualization

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
                 │  item3   │  ← placed in shortest col (col1, height 210)
                 │  h=150   │
                 └──────────┘
  ┌──────────┐
  │  item4   │  ← placed in col0 (290) vs col1 (370) vs col2 (360)
  │  h=220   │
  └──────────┘
```

### 3.5 Complexity

- Time: O(n × k), n=items, k=columns (finding shortest each time)
- Space: O(n + k)

### 3.6 Why `Math.floor` for Column Count

Unlike Grid, masonry uses `Math.floor`:
- Masonry doesn't support horizontal scrolling
- Must ensure all columns fit entirely within container
- `Math.floor(650 / 210) = 3` → 3 columns occupy `3*210-10 = 620px`, less than container

---

## 4. Grid vs Masonry Comparison

| Feature | GridLayout | MasonryLayout |
|---------|-----------|---------------|
| Item height | Fixed | Calculated from aspect ratio |
| Column calculation | `Math.ceil` | `Math.floor` |
| Placement strategy | Row-major (left-to-right, top-to-bottom) | Shortest column first |
| Horizontal scroll | May be needed | Not needed |
| Best for | Uniform thumbnail grids | Pinterest-style image feeds |
| Time complexity | O(n) | O(n×k) |
| Image dimensions | Not required | Better with aspect ratios |

---

## 5. Layout Result Usage

After `performLayout()` returns:

```typescript
#performLayout() {
  const result = this.#layoutStrategy.calculate(input)
  this.#gridItems = result.items          // Update positioned array
  this.#contentWidth = result.contentWidth // Update content dimensions
  this.#contentHeight = result.contentHeight
  this.#clampScroll()                     // Re-constrain scroll range
  this.#sendMessage(MessageType.LayoutUpdated, { ... }) // Notify main thread
}
```

Layout results are directly used for:
- Viewport culling (x/y determines if within viewport)
- Element drawing (drawImage uses x/y/width/height)
- Hit detection (checking if click coordinates fall within an element's rectangle)
- Scroll boundary calculation (contentWidth/Height determines max scroll range)

---

## 6. Extending with New Layouts

Implementation steps:

1. Create new file `src/core/layout/my-layout.ts`
2. Implement `LayoutStrategy` interface
3. Add strategy selection branch in `OffscreenCanvasWorker.#handleSetup`
4. Add new mode to `LayoutMode` type

```typescript
// Example: Brick layout
export class BrickLayout implements LayoutStrategy {
  calculate(input: LayoutInput): LayoutResult {
    // Custom layout algorithm
    return { items: positioned, contentWidth, contentHeight, columns }
  }
}
```
