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

Executed upon receiving the `Setup` message:

```
1. Set canvas dimensions: width = clientWidth * dpr, height = clientHeight * dpr
2. Create background cache canvas (same dimensions)
3. Get 2D contexts
4. Set DPR transform: ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
5. Enable image smoothing: imageSmoothingQuality = 'high'
6. Select layout strategy: 'masonry' → MasonryLayout, else → GridLayout
7. Process initial items:
   - ImageBitmap[] → create GridItem[] with 'loaded' status
   - itemCount → create GridItem[] with 'loading' status (awaiting image load)
8. Perform initial layout: #performLayout()
9. Send SetupResponse
```

### 2.1 DPR Transform Principle

```typescript
this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
```

Canvas physical pixels = CSS pixels × DPR. By scaling the coordinate system via `setTransform`, all subsequent drawing operations use CSS pixel units that automatically map to physical pixels, achieving HiDPI rendering.

---

## 3. Render Loop (`#startAnimationLoop`)

### 3.1 Loop Logic

```typescript
#startAnimationLoop() {
  if (this.#animationRunning) return  // Prevent duplicate starts
  this.#animationRunning = true

  const renderFrame = () => {
    // 1. Inertia scrolling: update position and velocity
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }

    // 2. Check loading items → request placeholders
    const loadingItems = this.#gridItems.filter(item => item.status !== 'loaded')
    if (loadingItems changed) {
      this.#sendMessage(MessageType.RenderLoading, ids)
    }

    // 3. Conditional exit
    const hasWork = this.#isInertiaActive || loadingItems.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false  // Stop loop
    }
  }

  renderFrame()
}
```

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

Drawing steps per frame:

```
1. #clear()              → Clear main canvas
2. #clearBackground()    → Clear background layer
3. #handleRenderBackground() → Draw background (solid/gradient) to background layer
4. #copyBackground()     → Copy background layer to main canvas
5. ctx.save()
6. ctx.translate(-scrollX, -scrollY) → Apply scroll offset
7. Draw grid items:
   - Loop mode → #renderLoopedItems()
   - Normal mode → #renderGridItems(#getVisibleItems())
8. ctx.restore()
```

### 4.1 Performance Benefit of Background Separation

Calling `createLinearGradient` + `addColorStop` every frame is wasteful. With background layer caching, only one `drawImage` per frame is needed.

### 4.2 Coordinate Transform

```typescript
this.#context.translate(-this.#scrollX, -this.#scrollY)
```

By inverse-translating the coordinate system, all item drawing coordinates remain in "content space" while the viewport moves with scrolling.

---

## 5. Viewport Culling (`#getVisibleItems`)

### 5.1 Algorithm

```typescript
#getVisibleItems(items: GridItem[]): GridItem[] {
  const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
  const bufferH = this.#clientHeight * buffer
  const bufferW = this.#clientWidth * buffer

  // Visible area (with buffer)
  const top = this.#scrollY - bufferH
  const bottom = this.#scrollY + this.#clientHeight + bufferH
  const left = this.#scrollX - bufferW
  const right = this.#scrollX + this.#clientWidth + bufferW

  return items.filter((item) => {
    const w = item.width ?? defaultW
    const h = item.height ?? defaultH
    // Rectangle intersection test
    return item.x + w > left && item.x < right
        && item.y + h > top && item.y < bottom
  })
}
```

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

### 6.1 Physics Formula

```
Per frame:
  velocity = velocity × friction     (velocity decay)
  position = position + velocity     (displacement update)

Stop condition:
  |velocity| < threshold (0.5px)
```

### 6.2 Implementation

```typescript
#tickInertia() {
  const friction = this.#config?.interaction?.scroll?.friction ?? 0.95
  const threshold = 0.5

  this.#velocityX *= friction   // Velocity decay
  this.#velocityY *= friction

  this.#scrollX += this.#velocityX  // Displacement update
  this.#scrollY += this.#velocityY

  this.#clampScroll()  // Boundary constraint

  if (Math.abs(this.#velocityX) < threshold && Math.abs(this.#velocityY) < threshold) {
    this.#velocityX = 0
    this.#velocityY = 0
    this.#isInertiaActive = false  // Stop
  }

  this.#checkLoadMore()  // Check if more data needed
}
```

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

### 7.1 Normal Mode

```typescript
const maxX = Math.max(0, this.#contentWidth - this.#clientWidth)
const maxY = Math.max(0, this.#contentHeight - this.#clientHeight)
this.#scrollX = Math.max(0, Math.min(this.#scrollX, maxX))
this.#scrollY = Math.max(0, Math.min(this.#scrollY, maxY))
```

Constraint range: `[0, contentSize - viewportSize]`

### 7.2 Loop Mode

In loop mode, no clamping is applied, allowing infinite scrolling:
```typescript
get #isLoopActive(): boolean {
  const loopEnabled = this.#config?.interaction?.scroll?.loop ?? true
  return loopEnabled && !this.#loadMoreState.hasMore
}
```

Loop activation condition: `loop=true` (default) AND all data loaded (`hasMore=false`).

---

## 8. Seamless Loop Mode (`#renderLoopedItems`)

### 8.1 Principle

In loop mode, content is treated as an infinitely repeating grid. Modulo operations map any position back to the finite dataset:

```
Viewport position → Grid coordinates (col, row) → Linear index → itemIndex = linearIndex % totalItems
```

### 8.2 Core Algorithm

```typescript
#renderLoopedItems(items: GridItem[]): void {
  // 1. Calculate grid range covered by viewport
  const colStart = Math.floor(left / blockW)
  const colEnd = Math.ceil(right / blockW) - 1
  const rowStart = Math.floor(top / blockH)
  const rowEnd = Math.ceil(bottom / blockH) - 1

  // 2. Iterate all visible cells
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      // 3. Modulo mapping
      const wrappedCol = ((col % columns) + columns) % columns
      const extraRows = Math.floor(col / columns)
      const linearIndex = (row + extraRows) * columns + wrappedCol
      const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems

      // 4. Calculate draw position
      const drawX = col * blockW
      const drawY = row * blockH

      // 5. Draw
      ctx.drawImage(items[itemIndex].image, drawX, drawY, itemW, itemH)
    }
  }
}
```

### 8.3 Double Modulo Explained

- `((col % columns) + columns) % columns`: Handles negative column numbers (when scrolling left, col is negative)
- `((linearIndex % totalItems) + totalItems) % totalItems`: Handles negative linear indices

JavaScript's `%` operator preserves sign for negative numbers; the additional `+ N) % N` ensures positive results.

### 8.4 Horizontal Overflow Handling

When col exceeds column count, `extraRows = Math.floor(col / columns)` maps excess columns to row offsets, achieving natural horizontal wraparound.

---

## 9. Hit Detection (`#handleClick`)

### 9.1 Coordinate Conversion

```typescript
const contentX = x + this.#scrollX  // CSS coords → content coords
const contentY = y + this.#scrollY
```

### 9.2 Loop Mode Hit Detection

```typescript
// Calculate which cell was clicked
const col = Math.floor(contentX / blockW)
const row = Math.floor(contentY / blockH)

// Check if click is within cell (excluding gap area)
const cellX = contentX - col * blockW
const cellY = contentY - row * blockH
if (cellX > defaultW || cellY > defaultH) return null  // Click in gap

// Modulo map to actual item
const linearIndex = row * columns + col
const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
```

### 9.3 Normal Mode Hit Detection

Reverse-iterate all gridItems, testing rectangle containment:

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

Reverse iteration ensures later-rendered elements (visually on top) are hit first.

---

## 10. LoadMore Triggering (`#checkLoadMore`)

### 10.1 Trigger Condition

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

### 10.2 Threshold Meaning

Default threshold = viewport height/width, meaning loading triggers when one viewport distance remains from bottom/right, ensuring users never see blank space.

---

## 11. Resize Response

```typescript
#handleResize(payload: ResizePayload) {
  // Only process when dimensions or DPR actually change
  if (w || h || d) {
    canvas.width = clientWidth * dpr
    canvas.height = clientHeight * dpr
    backgroundCanvas.width = clientWidth * dpr
    backgroundCanvas.height = clientHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Re-layout + re-render
    this.#performLayout()
    this.#handleRerender()
    this.#checkLoadMore()
  }
}
```

---

## 12. Image Drawing

### 12.1 Without Border Radius

```typescript
for (const item of items) {
  if (item.image) {
    ctx.drawImage(item.image, item.x, item.y, w, h)
  }
}
```

### 12.2 With Border Radius

```typescript
for (const item of items) {
  if (item.image) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(item.x, item.y, w, h, radius)
    ctx.clip()  // Clip region
    ctx.drawImage(item.image, item.x, item.y, w, h)
    ctx.restore()
  }
}
```

`roundRect + clip` achieves rounded corners; each element uses separate save/restore to isolate clip state.
