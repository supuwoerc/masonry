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

Here is the complete implementation of `GridLayout.calculate()`:

```typescript
// src/core/layout/grid-layout.ts
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, height: itemHeight, gap = 0 } = style

  // Block size = element width/height + gap, forming the grid's basic unit
  const blockWidth = itemWidth + gap
  const blockHeight = itemHeight + gap
  // Columns = container width / block width (ceiling to fit as many as possible)
  const columns = Math.max(1, Math.ceil(containerWidth / blockWidth))

  const positioned: GridItem[] = []

  for (let i = 0; i < items.length; i++) {
    const column = i % columns                 // Column index: modulo for row-major order
    const row = Math.floor(i / columns)        // Row index: integer division
    const x = column * blockWidth
    const y = row * blockHeight
    const source = items[i]

    positioned.push({
      id: source?.id ?? nanoid(),              // Preserve existing ID to avoid losing references on re-layout
      image: source?.image ?? null,            // Preserve loaded bitmap reference
      status: source?.status ?? 'loading',     // Preserve loading state, prevent state reset
      x,
      y,
      width: itemWidth,                        // Grid mode: all elements have equal width/height
      height: itemHeight,
      itemIndex: source?.itemIndex ?? i,       // Maintain data source index for click callbacks
    })
  }

  const rows = Math.ceil(items.length / columns)
  return {
    items: positioned,
    contentWidth: columns * blockWidth - gap,  // Total width minus trailing gap on the right
    contentHeight: rows * blockHeight - gap,   // Total height minus trailing gap at the bottom
    columns,
  }
}
```

**Design Notes**:

- **ID preservation** (`source?.id ?? nanoid()`): On re-layout (e.g., resize, image loaded), existing IDs are reused to ensure the placeholder Map cache can correctly match, avoiding creation of new animation states on every layout pass.
- **State preservation** (`source?.status ?? 'loading'`): Layout calculation is a pure positional computation with no side effects — it should never alter an item's loading state.
- **`contentWidth/Height` subtracting gap**: The last element's right/bottom side doesn't need a gap. `columns * blockWidth - gap` removes the redundant trailing spacing.

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

Here is the complete implementation of `MasonryLayout.calculate()`:

```typescript
// src/core/layout/masonry-layout.ts
calculate(input: LayoutInput): LayoutResult {
  const { items, containerWidth, style } = input
  const { width: itemWidth, gap = 0 } = style

  const blockWidth = itemWidth + gap
  // Masonry uses Math.floor: ensures all columns fit entirely within the container, no horizontal overflow
  const columns = Math.max(1, Math.floor(containerWidth / blockWidth))
  // Column heights array: tracks cumulative height of each column to decide where next item goes
  const columnHeights = Array.from<number>({ length: columns }).fill(0)

  // Using map instead of for-loop: each item's positioning depends on current column height state,
  // map's semantics more clearly express the "input → output" mapping relationship
  const positioned: GridItem[] = items.map((item, index) => {
    // Greedy strategy: always place in the shortest column to keep heights balanced
    const shortestCol = columnHeights.indexOf(Math.min(...columnHeights))
    const x = shortestCol * blockWidth
    const y = columnHeights[shortestCol]

    // Calculate actual render height based on image aspect ratio
    const itemHeight = this.#resolveItemHeight(item, itemWidth, style.height)
    // Accumulate column height (item height + gap)
    columnHeights[shortestCol] += itemHeight + gap

    return {
      id: item.id ?? nanoid(),
      image: item.image,
      status: item.status,
      x,
      y,
      width: itemWidth,          // Width is uniform, height varies
      height: itemHeight,
      itemIndex: item.itemIndex ?? index,
    }
  })

  // Math.max(0, ...) defensive programming: when items is empty, columnHeights are all 0,
  // and Math.max(...columnHeights) - gap would yield a negative number
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

**Design Notes**:

- **Greedy shortest-column strategy** (`columnHeights.indexOf(Math.min(...columnHeights))`): O(k) time complexity (k=column count). For typical 3-6 column scenarios, performance is sufficient. A min-heap optimization is possible for extremely large column counts, but in practice column count is determined by container width / item width and rarely exceeds 10.
- **`Math.max(0, ...)` safety wrapper**: Prevents `Math.max(...[]) = -Infinity` for empty arrays, and guards against negative values when subtracting gap.
- **Key difference from GridLayout**: Grid uses simple `i % columns` row-major ordering, while Masonry uses greedy shortest-column placement, meaning Masonry items are not necessarily arranged left-to-right.

### 3.3 Height Resolution Priority

`#resolveItemHeight()` implements a three-tier fallback strategy, ensuring a reasonable height value regardless of data completeness:

```typescript
// src/core/layout/masonry-layout.ts
#resolveItemHeight(item: GridItem, targetWidth: number, fallbackHeight: number): number {
  // Priority 1: Use pre-declared width/height from ItemDescriptor (metadata from data source)
  // Condition: both width and height must be > 0 to prevent division by zero
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return Math.round(targetWidth * (item.height / item.width))
  }

  // Priority 2: Use actual pixel dimensions from the loaded ImageBitmap
  // Effective when image has loaded but no metadata was provided
  if (item.image && item.image.width > 0 && item.image.height > 0) {
    return Math.round(targetWidth * (item.image.height / item.image.width))
  }

  // Priority 3: Use the configured default height (style.height)
  // Fallback when image hasn't loaded yet and no preset dimensions exist
  return fallbackHeight
}
```

**Design Notes**:

- **`Math.round()` for rounding**: Prevents sub-pixel layout drift from accumulating. Without rounding, floating-point column heights would create visual misalignment across rows.
- **Why check both `width > 0` and `height > 0`**: Prevents `0/width` or `height/0` producing NaN or Infinity, which would corrupt all downstream layout calculations.
- **Significance of the three-tier fallback**:
  - Tier 1: Fastest (no need to wait for image loading), for "known-dimensions image list" scenarios
  - Tier 2: Takes effect when re-layout is triggered after image loading completes
  - Tier 3: Fallback value ensures initial layout doesn't fail (items display at default height first, then recalculate after loading)

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

### 5.1 Complete `#performLayout()` Implementation

Layout calculation is triggered by `#performLayout()` in the Worker thread — it bridges the layout strategy and the rendering engine:

```typescript
// src/core/worker/offscreen-canvas.ts
#performLayout() {
  // Guard: skip if config isn't ready (Setup message may not have arrived yet)
  if (!this.#config?.core.style) {
    return
  }

  // Assemble layout input
  const input = {
    items: this.#allItems,             // All data items (both loaded and loading)
    containerWidth: this.#clientWidth,  // Current container CSS width
    containerHeight: this.#clientHeight,
    style: this.#config.core.style,    // Grid item style configuration
  }

  // Invoke strategy pattern: execute layout based on the strategy selected at initialization
  const result = this.#layoutStrategy.calculate(input)

  // Update rendering engine state
  this.#gridItems = result.items            // Replace with positioned items array
  this.#contentWidth = result.contentWidth  // Update total content dimensions
  this.#contentHeight = result.contentHeight

  // Re-constrain scroll position: content may have shrunk after layout change,
  // current scroll position might exceed the new maximum range
  this.#clampScroll()

  // Notify main thread that layout has updated (for onLayoutUpdate callback)
  this.#sendMessage(MessageType.LayoutUpdated, {
    contentWidth: result.contentWidth,
    contentHeight: result.contentHeight,
  })
}
```

**Design Notes**:

- **`#clampScroll()` timing**: Must be called immediately after contentWidth/Height update. Scenario: user has scrolled to the bottom, then container shrinks causing contentHeight to decrease — without clamping, scrollY would exceed the maximum, causing blank space in the next render frame.
- **`LayoutUpdated` is always sent**: Even if layout result is identical to the previous one, the main thread may depend on this message for UI synchronization (e.g., scrollbar updates). The cost of sending an unchanged message is far lower than maintaining comparison logic.
- **Downstream consumers of layout results**:
  - Viewport culling `#getVisibleItems()`: uses x/y to determine if within visible area
  - Element drawing `#renderGridItems()`: uses x/y/width/height for `drawImage` calls
  - Hit detection `#handleClick()`: checks if click coordinates fall within an item's rectangle
  - Scroll bounds `#clampScroll()`: contentWidth/Height determines maximum scroll range

### 5.2 Layout and Loop Mode Interaction

Note that when seamless loop mode is active (`scroll.loop = true` and `hasMore = false`), `#renderLoopedItems()` does not use the x/y coordinates from layout results. Instead, it recalculates drawing positions using modulo arithmetic. However, it still relies on the layout result's `items` array for image references and status.

This also explains why loop mode only supports Grid layout — Masonry layout's variable heights make seamless modulo-based tiling mathematically infeasible (columns with different heights cannot be simply aligned via blockH modulo).

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
