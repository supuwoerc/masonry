# OffscreenCanvas Rendering Engine

> This document details the Worker-side rendering engine implementation, including the render loop, viewport culling, inertia scrolling physics model, seamless loop mode, and hit detection.

## Module Position

`OffscreenCanvasWorker` is the largest and most complex module in the entire library (701 lines). Running in a Web Worker thread with exclusive Canvas rendering rights, it handles all pixel-level rendering work.

## Source Files

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/core/worker/offscreen-canvas.ts` | 701 | Rendering engine core |
| `src/helper/background.ts` | 50 | Background style creation |

---

## 1. Class Overview

### 1.1 Core State

```typescript
class OffscreenCanvasWorker {
  // Dual Canvas architecture
  #canvas!: OffscreenCanvas              // Main canvas (user-visible)
  #backgroundCanvas!: OffscreenCanvas    // Background cache layer

  // Dimensions & DPR
  #clientWidth = 0
  #clientHeight = 0
  #dpr = 1

  // Layout
  #layoutStrategy!: LayoutStrategy
  #allItems: GridItem[] = []             // All data items
  #gridItems: GridItem[] = []            // Positioned items after layout

  // Scroll physics
  #scrollX = 0
  #scrollY = 0
  #velocityX = 0
  #velocityY = 0
  #isInertiaActive = false

  // Content dimensions
  #contentWidth = 0
  #contentHeight = 0

  // Animation control
  #animationRunning = false

  // Pagination state
  #loadMoreState = { loading: false, hasMore: true }
}
```

### 1.2 Entry Point

Instantiated directly at file end:
```typescript
new OffscreenCanvasWorker()  // Created immediately when Worker starts
```

---

## 2. Initialization Flow (`#handleSetup`)

### 2.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#handleSetup(payload: SetupPayload) {
  try {
    // 1. Take ownership of OffscreenCanvas and set physical pixel dimensions
    this.#canvas = payload.offscreenCanvas
    this.#canvas.width = payload.clientWidth * payload.dpr
    this.#canvas.height = payload.clientHeight * payload.dpr

    // 2. Create same-size background cache canvas (avoids redrawing gradients every frame)
    this.#backgroundCanvas = new OffscreenCanvas(this.#canvas.width, this.#canvas.height)

    // 3. Cache container dimensions and DPR
    this.#clientWidth = payload.clientWidth
    this.#clientHeight = payload.clientHeight
    this.#dpr = payload.dpr

    // 4. Get 2D contexts
    this.#context = this.#canvas.getContext('2d')!
    this.#backgroundContext = this.#backgroundCanvas.getContext('2d')!

    // 5. Set DPR transform matrix: all coordinates use CSS pixels, auto-mapped to physical pixels
    this.#context.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
    this.#context.imageSmoothingEnabled = true
    this.#context.imageSmoothingQuality = 'high'
    this.#backgroundContext.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
    this.#backgroundContext.imageSmoothingEnabled = true
    this.#backgroundContext.imageSmoothingQuality = 'high'

    // 6. Store configuration
    this.#config = payload.config
    // No loader config means no pagination — all data is provided at init
    if (!this.#config.loader) {
      this.#loadMoreState.hasMore = false
    }

    // 7. Select layout strategy
    const mode = this.#config.core.layout ?? 'grid'
    this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()

    // 8. Process initial items (two paths)
    if (this.#config.core.items?.length) {
      // Path A: Pre-loaded ImageBitmap array → create GridItems with loaded status
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
      // Path B: Only count and size info → create placeholder GridItems with loading status
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

    // 9. Perform initial layout calculation
    this.#performLayout()
    this.#runTask()

    // 10. Notify main thread that initialization is complete
    this.#sendMessage(MessageType.SetupResponse, null)
  } catch (error) {
    this.#sendError(error)
  }
}
```

**Design Notes**:

- **Dual Canvas creation**: Main canvas for final render output, background canvas for caching gradient/solid backgrounds. After separation, each frame only needs `drawImage` to copy the background, avoiding repeated gradient computation.
- **`imageSmoothingQuality = 'high'`**: Uses high-quality bilinear/bicubic interpolation when scaling images, ensuring scaled images in masonry layout don't show aliasing artifacts. Has no noticeable effect on solid/gradient placeholders.
- **`!this.#config.loader` sets `hasMore = false`**: No loader config means infinite scrolling is disabled — all data is provided at initialization. `hasMore = false` immediately enables loop mode (if `scroll.loop` is true).
- **Two items paths**: Path A is "ready-to-use" (ImageBitmaps already prepared, can render immediately); Path B is "deferred loading" (layout placeholder framework first, replace individually later via `ImageLoaded` messages). In Path B, `width/height` from `itemSizes` lets masonry layout calculate accurate positions before images load.

### 2.2 DPR Transform Principle

```typescript
this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
```

Canvas physical pixels = CSS pixels × DPR. By scaling the coordinate system via `setTransform`, all subsequent drawing operations use CSS pixel units that automatically map to physical pixels, achieving HiDPI rendering.

---

## 3. Render Loop (`#startAnimationLoop`)

### 3.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#animationRunning = false

#startAnimationLoop() {
  if (this.#animationRunning) {
    return  // Prevent duplicate starts: multiple events may trigger simultaneously (Scroll + ImageLoaded)
  }
  this.#animationRunning = true

  const renderFrame = () => {
    // 1. Inertia scrolling: update velocity and position each frame, then redraw
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }

    // 2. Check loading items → only send RenderLoading when the ID set changes
    const loadingItems = this.#gridItems.filter((item) => item.status !== 'loaded')
    const ids = loadingItems.map((item) => item.id)
    if (ids.length > 0) {
      // idsChanged optimization: avoid sending the same ID list to main thread every frame
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

    // 3. Conditional exit: only stop when all work is complete
    const hasWork = this.#isInertiaActive || ids.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false  // Release loop, allow next restart
    }
  }

  renderFrame()  // Execute first frame immediately, don't wait for next vsync
}
```

**Design Notes**:

- **`idsChanged` optimization**: Each frame filters + maps to get loading IDs, but only sends `RenderLoading` message when the set content actually changes. During image loading, the loading list may remain unchanged for dozens of frames — skipping these redundant messages avoids the main thread repeatedly rendering identical placeholders.
- **Conditional exit instead of infinite loop**: When inertia stops and no loading items exist, the loop auto-exits (`#animationRunning = false`). This ensures no rAF callbacks keep running when idle, saving Worker thread CPU.
- **`renderFrame()` called immediately**: The first frame executes synchronously when `#startAnimationLoop()` is called, rather than waiting for the next vsync. This makes animation response more immediate — users don't see a 16ms delay before the first frame change after scrolling.
- **Multi-entry deduplication**: `Scroll`, `Render`, and `ImageLoaded` messages can all trigger `#startAnimationLoop()`. The guard `if (this.#animationRunning) return` ensures only one loop runs at any time.

### 3.2 Start Triggers

- `Render` message arrives
- `Scroll` message arrives (enables inertia)
- `ImageLoaded` message arrives

### 3.3 Stop Conditions

**Both must be true**:
- Inertia scrolling has stopped (`#isInertiaActive = false`)
- No items in loading state

---

## 4. Render Pipeline (`#handleRerender`)

### 4.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#handleRerender() {
  if (this.#context) {
    try {
      // Step 1: Clear all content from main canvas
      this.#clear()
      // Step 2: Clear background cache layer
      this.#clearBackground()
      // Step 3: Draw solid/gradient background on background layer
      this.#handleRenderBackground()
      // Step 4: Copy background layer to main canvas in one operation (faster than redrawing gradient)
      this.#copyBackground()
      // Step 5: Save current transform state
      this.#context.save()
      // Step 6: Apply scroll offset (inverse translation = simulates viewport movement)
      this.#context.translate(-this.#scrollX, -this.#scrollY)
      // Step 7: Choose render strategy based on mode
      if (this.#isLoopActive) {
        this.#renderLoopedItems(this.#gridItems)
      } else {
        this.#renderGridItems(this.#getVisibleItems(this.#gridItems))
      }
      // Step 8: Restore transform state (removes scroll offset for next frame)
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

**Design Notes**:

- **Performance benefit of background separation**: Gradient backgrounds require `createLinearGradient` + multiple `addColorStop` calls each frame, which is not cheap. Caching to a separate Canvas reduces per-frame cost from O(number of stops) to O(1) — a single `drawImage`.
- **`translate(-scrollX, -scrollY)` coordinate transform**: By inverse-translating the coordinate system, all item draw coordinates remain in "content space" (i.e., the x/y from layout calculation), while the visible viewport area shifts with scroll offset. This is far more efficient than modifying each item's draw coordinates individually.
- **`save()/restore()` pairing**: Ensures the scroll offset `translate` doesn't leak to the next frame. Without restore, the next frame's translate would stack on the previous one, causing offset to grow exponentially.
- **Normal mode vs loop mode**: Normal mode applies viewport culling (`#getVisibleItems`) first then renders visible items; loop mode calculates cell coordinates directly from the viewport range and uses modulo mapping, no pre-filtering needed.

### 4.2 Coordinate Transform

```typescript
this.#context.translate(-this.#scrollX, -this.#scrollY)
```

By inverse-translating the coordinate system, all item drawing coordinates remain in "content space" while the viewport moves with scrolling.

---

## 5. Viewport Culling (`#getVisibleItems`)

### 5.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#getVisibleItems(items: GridItem[]): GridItem[] {
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferH = this.#clientHeight * buffer
  const bufferW = this.#clientWidth * buffer

  // Visible area (with buffer): extends buffer × viewport size in all four directions
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW

  const defaultW = this.#config?.core.style?.width ?? 0
  const defaultH = this.#config?.core.style?.height ?? 0

  return items.filter((item) => {
    const w = item.width ?? defaultW
    const h = item.height ?? defaultH
    // AABB intersection test: item's right edge > visible left AND left edge < visible right...
    return item.x + w > left && item.x < right && item.y + h > top && item.y < bottom
  })
}
```

**Design Notes**:

- **AABB intersection test**: Two rectangles do NOT intersect if one is entirely outside any edge of the other. Negating gives the intersection condition: `item.x + w > left && item.x < right && item.y + h > top && item.y < bottom`.
- **`item.width ?? defaultW`**: In masonry mode each item has individual dimensions; in grid mode all items use uniform `style.width/height`. The `??` operator handles both cases elegantly.

### 5.2 Buffer Zone

`buffer = 1.0` means extending 1 viewport size in each direction:

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

**Why buffer**: During fast scrolling, rendering only exact viewport items would show blank edges. Buffer pre-renders off-viewport items, ensuring smooth scrolling.

### 5.3 Performance Impact

- 10,000 items: viewport might show only 20-50
- With buffer: might render 60-150
- 100x+ faster than rendering all 10,000

---

## 6. Inertia Scrolling Physics Model

### 6.1 Scroll Event Handling

```typescript
// src/core/worker/offscreen-canvas.ts
#handleScroll(payload: ScrollPayload) {
  const scroll = this.#config?.interaction?.scroll
  // Read direction disable config
  const disableH = scroll?.disabled?.horizontal ?? false
  const disableV = scroll?.disabled?.vertical ?? false
  // Zero out delta for disabled directions
  const dx = disableH ? 0 : payload.deltaX
  const dy = disableV ? 0 : payload.deltaY

  // Apply scroll delta immediately
  this.#scrollX += dx
  this.#scrollY += dy
  this.#clampScroll()

  // If inertia enabled, record velocity and start animation loop
  const inertia = scroll?.inertia ?? true
  if (inertia) {
    this.#velocityX = dx
    this.#velocityY = dy
    this.#isInertiaActive = true
    this.#startAnimationLoop()
  }

  // Always redraw immediately regardless of inertia (instant feedback to user input)
  this.#handleRerender()
  this.#checkLoadMore()
}
```

**Design Notes**:

- **Immediate + inertia separation**: `scrollX/Y += dx/dy` provides instant feedback (while user's finger is on screen), `velocityX/Y = dx/dy` uses the last frame's delta as inertia initial velocity. After release, inertia takes over and decays per frame.
- **Direction disable**: After disabling a direction, delta is zeroed, but `clampScroll()` and `handleRerender()` are still called to ensure the other direction scrolls normally.
- **`inertia` enabled by default**: Most modern UI users expect inertial scrolling. Setting to `false` makes content stop immediately on release, suitable for precision positioning scenarios.

### 6.2 Physics Formula

```
Per frame:
  velocity = velocity × friction     (velocity decay)
  position = position + velocity     (displacement update)

Stop condition:
  |velocity| < threshold (0.5px)
```

### 6.3 Complete tickInertia Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#tickInertia() {
  const friction = this.#config?.interaction?.scroll?.friction ?? 0.95
  const threshold = 0.5

  this.#velocityX *= friction   // Velocity decay
  this.#velocityY *= friction

  this.#scrollX += this.#velocityX  // Displacement update
  this.#scrollY += this.#velocityY

  this.#clampScroll()  // Boundary constraint

  // When velocity drops below threshold, stop completely to avoid infinite approach to zero
  if (Math.abs(this.#velocityX) < threshold && Math.abs(this.#velocityY) < threshold) {
    this.#velocityX = 0
    this.#velocityY = 0
    this.#isInertiaActive = false  // Mark inertia ended → animation loop can exit
  }

  this.#checkLoadMore()  // Check each frame: inertia may reach load threshold
}
```

**Design Notes**:

- **`threshold = 0.5`**: Sub-pixel velocity (< 0.5px/frame) is imperceptible to users; continuing to decay just wastes CPU. Truncating to 0 and stopping inertia immediately.
- **`#checkLoadMore()` called during inertia**: After a fast swipe, inertia may take dozens of frames to reach the content bottom. Checking each frame ensures loadMore can trigger during inertial scrolling, rather than waiting until inertia fully stops.

### 6.3 Friction Coefficient Effects

| friction | Effect | Use Case |
|----------|--------|----------|
| 0.99 | Slides very far | Large galleries |
| 0.95 | Moderate (default) | General use |
| 0.90 | Quick stop | Precise positioning |
| 0.80 | Almost no inertia | DOM-like scrolling |

### 6.4 Decay Curve

Example with friction=0.95, initial velocity=100:
```
Frame  0: v=100.0  →  displacement: 100.0
Frame  5: v=77.4   →  cumulative: 487.6
Frame 10: v=59.9   →  cumulative: 801.3
Frame 20: v=35.8   →  cumulative: 1242.5
Frame 40: v=12.9   →  cumulative: 1735.3
Frame 60: v=4.6    →  cumulative: 1907.4
Frame 88: v=0.5    →  stops
```

---

## 7. Scroll Boundary Clamping (`#clampScroll`)

### 7.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#clampScroll() {
  if (this.#isLoopActive) {
    // Loop mode: no boundary limit, allows infinite scrolling
    this.#wrapScroll()
  } else {
    // Normal mode: constrain to [0, contentSize - viewportSize] range
    const maxX = Math.max(0, this.#contentWidth - this.#clientWidth)
    const maxY = Math.max(0, this.#contentHeight - this.#clientHeight)
    this.#scrollX = Math.max(0, Math.min(this.#scrollX, maxX))
    this.#scrollY = Math.max(0, Math.min(this.#scrollY, maxY))
  }
}

get #isLoopActive(): boolean {
  const loopEnabled = this.#config?.interaction?.scroll?.loop ?? true
  // Loop activation requires: 1. loop is true in config  2. all data fully loaded
  return loopEnabled && !this.#loadMoreState.hasMore
}

#wrapScroll() {
  const disableH = this.#config?.interaction?.scroll?.disabled?.horizontal ?? false
  const disableV = this.#config?.interaction?.scroll?.disabled?.vertical ?? false
  // Disabled directions zeroed out, enabled directions unrestricted (allow any value)
  if (disableH) {
    this.#scrollX = 0
  }
  if (disableV) {
    this.#scrollY = 0
  }
}
```

**Design Notes**:

- **`Math.max(0, contentWidth - clientWidth)`**: When content width is less than viewport width, `maxX = 0`, locking scroll (no scrollable space). This prevents unnecessary scrolling when content fits within one screen.
- **Loop mode doesn't clamp**: In loop mode, scroll position can grow or shrink infinitely; `#renderLoopedItems` maps any position back to finite content via modulo. `#wrapScroll` only handles zeroing disabled directions.
- **`!this.#loadMoreState.hasMore` condition**: Loop is only enabled after all data is loaded. If more data is pending, loop mode would show repeated content, violating infinite scroll expectations.

---

## 8. Seamless Loop Mode (`#renderLoopedItems`)

### 8.1 Principle

In loop mode, content is treated as an infinitely repeating grid. Modulo operations map any position back to the finite dataset:

```
Viewport position → Grid coordinates (col, row) → Linear index → itemIndex = linearIndex % totalItems
```

### 8.2 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#renderLoopedItems(items: GridItem[]): void {
  if (!this.#context || !this.#config?.core.style || items.length === 0) {
    return
  }
  const { width: itemW, height: itemH, gap = 0, radius = 0 } = this.#config.core.style
  const blockW = itemW + gap     // Total width occupied by one cell (including gap)
  const blockH = itemH + gap     // Total height occupied by one cell (including gap)
  // Calculate columns based on viewport width
  const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))

  // Use buffer to extend render range, ensuring no blank areas during fast scrolling
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferW = this.#clientWidth * buffer
  const bufferH = this.#clientHeight * buffer
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH

  // Calculate grid cell range covered by viewport (may include negative indices)
  const colStart = Math.floor(left / blockW)
  const colEnd = Math.ceil(right / blockW) - 1
  const rowStart = Math.floor(top / blockH)
  const rowEnd = Math.ceil(bottom / blockH) - 1

  const totalItems = items.length

  // Iterate all visible cells
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      // Column modulo: handles negative column numbers (when scrolling left)
      const wrappedCol = ((col % columns) + columns) % columns
      // Column overflow to row offset: adds row when col exceeds columns
      const extraRows = Math.floor(col / columns)
      // Linearize index: convert 2D coordinates to 1D
      const linearIndex = (row + extraRows) * columns + wrappedCol
      // Final modulo: map to actual data item
      const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
      const item = items[itemIndex]
      if (!item?.image) {
        continue  // Skip items not yet loaded
      }

      // Use cell coordinates (not item coordinates) as draw position
      const drawX = col * blockW
      const drawY = row * blockH

      // Draw (with optional border radius)
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

**Design Notes**:

- **Cell coordinates vs item coordinates**: Normal mode uses `item.x/y` (absolute positions from layout calculation); loop mode uses `col * blockW / row * blockH` (the cell's own position). This is because in loop mode, the same item may appear at multiple positions simultaneously.
- **`columns` calculated from viewport**: `Math.ceil(clientWidth / blockW)` ensures one row fills the viewport width. This value changes on resize, automatically adapting to different container widths.
- **`!item?.image` skip**: Loop mode only activates after all data is loaded, so `items` array theoretically shouldn't have `image = null` entries. This check is defensive programming.

### 8.3 Double Modulo Explained

- `((col % columns) + columns) % columns`: Handles negative column numbers (when scrolling left, col is negative)
- `((linearIndex % totalItems) + totalItems) % totalItems`: Handles negative linear indices

JavaScript's `%` operator preserves sign for negative numbers; the additional `+ N) % N` ensures positive results.

### 8.4 Horizontal Overflow Handling

When col exceeds column count, `extraRows = Math.floor(col / columns)` maps excess columns to row offsets, achieving natural horizontal wraparound.

---

## 9. Hit Detection (`#handleClick`)

### 9.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#handleClick(payload: ClickPayload) {
  const { x, y } = payload
  // CSS coordinates → content coordinates (add scroll offset)
  const contentX = x + this.#scrollX
  const contentY = y + this.#scrollY
  const defaultW = this.#config?.core.style?.width ?? 0
  const defaultH = this.#config?.core.style?.height ?? 0
  const gap = this.#config?.core.style?.gap ?? 0
  const blockW = defaultW + gap
  const blockH = defaultH + gap
  const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))

  if (this.#isLoopActive) {
    // ─── Loop mode: calculate hit through cell coordinate math ───
    const col = Math.floor(contentX / blockW)
    const row = Math.floor(contentY / blockH)
    // Check if click is within cell's valid area (exclude gap region)
    const cellX = contentX - col * blockW
    const cellY = contentY - row * blockH
    if (cellX > defaultW || cellY > defaultH) {
      // Click landed on gap, considered a miss
      this.#sendMessage(MessageType.ClickResult, null)
      return
    }
    // Modulo map to actual item
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
    // ─── Normal mode: iterate to find hit item ───
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
  // Reverse iteration: later-rendered elements are visually on top, should be hit first
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

**Design Notes**:

- **Two hit detection strategies**: In loop mode, item "positions" are dynamically computed (same item appears in multiple cells), so iteration won't work. Instead, math directly calculates which cell was clicked, then modulo maps to the item. In normal mode, items have unique layout coordinates, so reverse iteration suffices.
- **Gap exclusion check**: `cellX > defaultW || cellY > defaultH` determines whether the click landed in the spacing area between two items. Gaps don't belong to any item — should return null.
- **Reverse iteration** (`i = length - 1; i >= 0; i--`): Items at the end of the array are rendered last, visually stacked on top. Reverse iteration ensures that when users click in overlapping areas, the topmost element is hit (consistent with visual order).
- **`row` and `column` calculation**: In normal mode, row/column are reverse-computed from `itemIndex / columns` and `itemIndex % columns`. This makes the `row/column` information in callbacks meaningful to callers (e.g., highlighting entire rows/columns).

---

## 10. LoadMore Triggering (`#checkLoadMore`)

### 10.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#checkLoadMore() {
  // Any of three preconditions not met → skip
  if (!this.#config?.loader || this.#loadMoreState.loading || !this.#loadMoreState.hasMore) {
    return
  }
  const threshold = this.#config.interaction?.scroll?.threshold
  // Calculate remaining distance to boundary
  const remainingY = this.#contentHeight - this.#clientHeight - this.#scrollY
  const remainingX = this.#contentWidth - this.#clientWidth - this.#scrollX
  // Default threshold = one viewport distance
  const thresholdY = threshold ?? this.#clientHeight
  const thresholdX = threshold ?? this.#clientWidth
  // Trigger when approaching boundary in either direction
  if (remainingY <= thresholdY || remainingX <= thresholdX) {
    this.#loadMoreState.loading = true   // Re-entry guard
    this.#sendMessage(MessageType.LoadMore, null)
  }
}
```

**Design Notes**:

- **`loading` re-entry guard**: Once LoadMore message is sent, immediately set to true. Only reset when main thread returns `LoadMoreResponse`. This prevents inertial scrolling from triggering loadMore every frame.
- **`!hasMore` early exit**: When the last load returned `hasMore: false`, no further checks occur — pagination permanently stops.
- **Dual direction check (Y and X)**: Supports both vertical and horizontal infinite scrolling. In horizontal gallery scenarios `remainingX` reaches threshold first; in vertical masonry `remainingY` reaches first.
- **Default threshold = viewport size**: Loading triggers when one viewport height of distance remains from the bottom. When users scroll at normal speed, new data is ready before any blank space appears.

---

## 11. Resize Response

### 11.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
async #handleResize(payload: ResizePayload) {
  if (!this.#context) {
    return
  }
  try {
    const { clientHeight, clientWidth, dpr } = payload
    // Three dimensions checked independently for changes
    const w = clientWidth !== this.#clientWidth
    const h = clientHeight !== this.#clientHeight
    const d = dpr !== this.#dpr

    // Only execute when actual change occurs (avoids redundant resize events causing repeated work)
    if (w || h || d) {
      this.#clear()
      // Reset physical pixel dimensions
      this.#canvas.width = payload.clientWidth * payload.dpr
      this.#canvas.height = payload.clientHeight * payload.dpr
      this.#backgroundCanvas.width = clientWidth * dpr
      this.#backgroundCanvas.height = clientHeight * dpr

      // Update cached dimension state
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
      this.#dpr = dpr

      // Re-set DPR transform (canvas dimension change resets all context state)
      this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.#context.imageSmoothingEnabled = true
      this.#context.imageSmoothingQuality = 'high'
      this.#backgroundContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      this.#backgroundContext.imageSmoothingEnabled = true
      this.#backgroundContext.imageSmoothingQuality = 'high'

      // Container size changed, column count may differ → re-layout needed
      this.#performLayout()
      this.#handleRerender()
      this.#checkLoadMore()  // After resize, more space may be exposed, check if loading needed
    }
  } catch (error) {
    this.#sendError(error)
  }
}
```

**Design Notes**:

- **Three conditions checked independently**: Width, height, and DPR changes are independent events. A window might only change width (dragging edge), or only DPR (dragging to a different density screen) — checking each separately avoids missing any.
- **Setting `canvas.width/height` resets context state**: This is known Canvas API behavior — modifying canvas dimensions resets all previously set `setTransform`, `imageSmoothingQuality`, etc. to defaults. So they must be re-set after dimension changes.
- **`#checkLoadMore()` called after resize**: A larger container may cause `remainingY` to decrease (visible area grows, distance to bottom shrinks), requiring timely load triggering.

---

## 12. Data Update Handling

### 12.1 LoadMoreResponse Handling

```typescript
// src/core/worker/offscreen-canvas.ts
#handleLoadMoreResponse(payload: LoadMoreResponsePayload) {
  this.#loadMoreState.loading = false   // Release re-entry guard
  if (!payload.hasMore) {
    this.#loadMoreState.hasMore = false  // Permanently stop pagination
  }
  if (payload.data.length > 0) {
    // Convert newly loaded ImageBitmaps to GridItems and append to data list
    const newItems = payload.data.map((bitmap, i) => ({
      id: nanoid(),
      image: bitmap,
      status: 'loaded' as const,
      x: 0,
      y: 0,
      itemIndex: this.#allItems.length + i,  // Index continues from existing data
    }))
    this.#allItems.push(...newItems)
    this.#performLayout()      // Re-calculate layout with new data
    this.#handleRerender()     // Draw new content immediately
  }
  this.#checkLoadMore()  // Check if new data is enough to fill viewport; trigger again if not
}
```

### 12.2 ImageLoaded Handling

```typescript
// src/core/worker/offscreen-canvas.ts
#handleImageLoaded(payload: ImageLoadedPayload) {
  const item = this.#allItems[payload.index]
  if (!item) {
    return  // Defense: index out of bounds (shouldn't happen)
  }
  const wasLoading = item.status === 'loading'
  // Update item state in-place
  item.image = payload.bitmap
  item.status = 'loaded'
  item.width = payload.width
  item.height = payload.height
  if (wasLoading) {
    // Notify main thread to release placeholder resources for this ID
    this.#sendMessage(MessageType.RemoveLoading, item.id)
  }
  // Dimensions may have changed → re-layout (in masonry, actual image height affects layout)
  this.#performLayout()
  this.#handleRerender()
  this.#startAnimationLoop()  // Ensure animation loop runs (handle other still-loading items)
}
```

**Design Notes**:

- **`itemIndex: this.#allItems.length + i`**: New items' indices start from the end of existing data, ensuring globally unique and incrementing indices.
- **`#checkLoadMore()` called after loadMore response**: One page of data may not fill the expanded viewport (e.g., pageSize=10 but viewport can display 15). Re-checking ensures no blank space appears.
- **`wasLoading` check**: Only the loading → loaded transition should send `RemoveLoading`. If the item was already loaded due to loadMore (edge case), no redundant messages should be sent.
- **`#startAnimationLoop()`**: Restarts the animation loop after image load completes, since other loading items may still need placeholder animation rendering.

---

## 13. Image Drawing

### 13.1 Complete Implementation

```typescript
// src/core/worker/offscreen-canvas.ts
#renderGridItems(gridItems: GridItem[]): void {
  if (!this.#context || !this.#config?.core.style || gridItems.length === 0) {
    return
  }
  const { width: defaultWidth, height: defaultHeight, radius = 0 } = this.#config.core.style
  // Dispatch to different draw paths based on border radius (avoid save/clip/restore when no radius)
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
      this.#context?.clip()      // Clip region restricts draw area
      this.#context?.drawImage(item.image, item.x, item.y, w, h)
      this.#context?.restore()   // Restore clip state, won't affect next item
    }
  }
}
```

**Design Notes**:

- **Radius/no-radius separated into two methods**: `save()/beginPath()/roundRect()/clip()/restore()` are entirely unnecessary when there's no border radius. After separation, the no-radius path is just one `drawImage` call, eliminating 5 Context API calls per item. For 100 visible items, that's 500 fewer calls.
- **`item.width ?? defaultWidth`**: In masonry mode, items have individual widths/heights (determined by original image aspect ratio); in grid mode, all items use uniform `style.width/height`. The `??` operator elegantly accommodates both scenarios.
- **`roundRect + clip` for border radius**: Each element uses independent `save/restore` to isolate clip state. Without restore, clip regions would accumulate (intersection), making each subsequent item's draw area progressively smaller.
