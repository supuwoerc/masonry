# Image Loading & Placeholder Animation System

> This document covers the image loader's concurrency control and retry mechanisms, and the implementation principles of both placeholder animation renderers.

## Module Position

Image loading and placeholder animations together solve a core UX problem: what users see during the time gap between network fetch and rendering.

## Source Files

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/core/image-loader.ts` | 90 | Concurrent image loader |
| `src/core/placeholder/breathing-placeholder.ts` | 188 | Breathing gradient animation |
| `src/core/placeholder/spin-placeholder.ts` | 186 | Spinning loader animation |
| `src/helper/background.ts` | 50 | Background style utility |

---

## 1. ImageLoader Core Mechanism

### 1.1 Feature Overview

| Feature | Implementation | Default |
|---------|---------------|---------|
| Concurrency control | p-limit | 6 concurrent |
| Retry strategy | @supuwoerc/toolkit retry | Max 3 retries |
| Backoff algorithm | Exponential backoff | delay × 2^attempt |
| Timeout control | @supuwoerc/toolkit withTimeout | 10000ms |
| Custom request | ImageFetcher interface | fetch → blob |
| Cancellation | AbortController | Global abort |

### 1.2 Class Structure

```typescript
class ImageLoader {
  #limit: ReturnType<typeof pLimit>  // Concurrency limiter
  #maxRetries: number                // Max retry count
  #retryDelay: number                // Base retry delay
  #timeout: number                   // Timeout duration
  #fetcher: ImageFetcher             // Request function
  #abortController = new AbortController()  // Cancellation controller
}
```

### 1.3 Loading Flow

`loadBatch()` demonstrates the complete implementation of concurrency control and silent failure strategy:

```typescript
// src/core/image-loader.ts
async loadBatch(
  urls: Array<{ url: string; index: number; width?: number; height?: number }>,
  onLoaded: (index: number, bitmap: ImageBitmap, width: number, height: number) => void,
): Promise<void> {
  const tasks = urls.map(({ url, index, width, height }) => {
    // Each task is wrapped by p-limit, ensuring no more than `concurrency` run simultaneously
    return this.#limit(async () => {
      try {
        const bitmap = await this.#loadWithRetry(url)
        // width ?? bitmap.width: prefer preset dimensions (from ItemDescriptor),
        // fall back to bitmap's actual pixel dimensions when unavailable
        onLoaded(index, bitmap, width ?? bitmap.width, height ?? bitmap.height)
      } catch {
        // Failed loads are silently skipped — item remains in loading state
        // Worker continues requesting placeholder rendering for loading items
        // until user scrolls away or the page is destroyed
      }
    })
  })
  await Promise.all(tasks)
}
```

**Design Notes**:

- **Silent failure strategy**: A failed image doesn't interrupt the entire batch load or throw errors. The Worker side continues rendering placeholder animations for `status === 'loading'` items, so from the user's perspective, that position simply keeps showing the loading animation.
- **`width ?? bitmap.width` fallback**: If the user provided original dimensions via `ItemDescriptor`, those are used first — these dimensions are used for aspect ratio calculation in masonry layout. If not provided, the decoded bitmap's actual dimensions are used.
- **`Promise.all(tasks)`**: All tasks are initiated in parallel, but p-limit constrains how many execute simultaneously. This means even with 100 images, only 6 are actually loading from the network at once.

### 1.4 Concurrency Control (p-limit)

```typescript
this.#limit = pLimit(config?.concurrency ?? 6)
```

p-limit maintains an internal queue, limiting concurrent running Promises to the concurrency limit. Excess tasks queue up and wait.

**Why concurrency control**:
- Browsers limit concurrent connections per domain (typically 6-8)
- Loading too many images simultaneously competes for bandwidth, making all images slow
- Controlled concurrency lets the first few images appear faster

### 1.5 Retry and Timeout Complete Implementation

```typescript
// src/core/image-loader.ts
async #loadWithRetry(url: string): Promise<ImageBitmap> {
  return retry(() => this.#fetchWithTimeout(url), {
    maxAttempts: this.#maxRetries + 1,  // First attempt + retry count
    delayMs: this.#retryDelay,           // Base delay 500ms
    backoffFactor: 2,                    // Exponential backoff factor
    // Critical: if loader has been dispose()'d, stop retrying
    // Prevents background retries continuing after component destruction
    shouldRetry: () => !this.#abortController.signal.aborted,
  })
}

async #fetchWithTimeout(url: string): Promise<ImageBitmap> {
  // withTimeout wrapper: auto-rejects after timeout milliseconds
  const result = await withTimeout(
    this.#fetcher(url, this.#abortController.signal),
    this.#timeout,
  )
  // Custom fetcher may return ImageBitmap directly (e.g., from cache)
  if (result instanceof ImageBitmap) {
    return result
  }
  // Default path: fetcher returns Blob, needs decoding to ImageBitmap
  // createImageBitmap is the browser's built-in async decode API
  return await createImageBitmap(result)
}
```

**Design Notes**:

- **`shouldRetry: () => !aborted`**: When `dispose()` is called, the AbortController's signal becomes aborted. All pending retries stop immediately, preventing async operations from running in the background after component destruction.
- **`result instanceof ImageBitmap` check**: Custom fetchers have two valid return types — `Blob` (standard flow) or `ImageBitmap` (from Service Worker cache or other pre-decoded sources). This branch handles both scenarios correctly.
- **`withTimeout` vs AbortSignal difference**: `withTimeout` is Promise-level timeout (rejects after timeout), while `signal` is network-request-level cancellation (actually terminates the TCP connection). Using both together ensures timeout both breaks the Promise chain and releases underlying network resources.

**Exponential backoff timeline**:
```
1st failure → wait 500ms → retry
2nd failure → wait 1000ms → retry
3rd failure → wait 2000ms → retry
4th failure → give up
```

### 1.7 Custom Fetcher

```typescript
type ImageFetcher = (url: string, signal: AbortSignal) => Promise<Blob | ImageBitmap>
```

Use cases:
- Adding authentication headers (Authorization)
- Using custom proxies
- Image preprocessing
- Reading from Service Worker cache

Default implementation:
```typescript
#defaultFetcher: ImageFetcher = async (url, signal) => {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
  return await response.blob()
}
```

### 1.8 Cancellation Mechanism

```typescript
dispose() {
  this.#abortController.abort()  // Abort all in-progress fetches
  this.#limit.clearQueue()       // Clear waiting queue
}
```

`abort()` causes all fetches using that signal to reject immediately, while `clearQueue()` prevents queued tasks from continuing to execute.

---

## 2. PlaceholderRenderer Interface

### 2.1 Interface Design

```typescript
interface PlaceholderRenderer {
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  dispose: () => void
  remove: (id: string) => void
}
```

| Method | Call Timing | Responsibility |
|--------|-----------|----------------|
| `render` | Worker detects loading items | Generate one animation frame bitmap |
| `remove` | Image load complete | Clean up single placeholder resources |
| `dispose` | Masonry.destroy() | Clean up all resources |

### 2.2 Animation Coordination Flow

```
Worker: Animation loop detects loading items
  → sends RenderLoading(ids)

Main: For each id, calls renderer.render(w, h, id)
  → gets one frame ImageBitmap
  → sends back to Worker via Transferable

Worker: Draws bitmap at corresponding grid cell position

Next frame: Worker sends RenderLoading(ids) again
  → Main renders again (new frame)
  → loops until image loads complete

Image load complete:
  → Worker: item.status = 'loaded', sends RemoveLoading(id)
  → Main: renderer.remove(id) releases resources
```

---

## 3. BreathingPlaceholderRenderer (Breathing Gradient)

### 3.1 Animation Principle

Uses sine function for periodic brightness oscillation:

```
alpha = 0.3 + 0.3 × sin(progress × 2π)
```

- `progress = (elapsed % duration) / duration`: Normalized to [0, 1] cycle progress
- When `sin = 1`: alpha = 0.6 (brightest)
- When `sin = -1`: alpha = 0 (darkest)
- When `sin = 0`: alpha = 0.3 (middle)

### 3.2 Complete Render Implementation

```typescript
// src/core/placeholder/breathing-placeholder.ts
async render(width: number, height: number, id: string): Promise<ImageBitmap> {
  const now = performance.now()
  // DPR capped at 2: on 3x screens the visual difference for placeholders is negligible,
  // but pixel area is 2.25x that of 2x (3²/2²), diminishing returns
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cssWidth = width
  const cssHeight = height
  const physWidth = Math.round(width * dpr)
  const physHeight = Math.round(height * dpr)

  let state = this.#cache.get(id)

  if (!state) {
    // First render: create independent canvas (one per placeholder)
    const canvas = document.createElement('canvas')
    canvas.width = physWidth
    canvas.height = physHeight
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)  // One-time DPR scale setup

    state = {
      canvas,
      dpr,
      startTime: now,     // Record this placeholder's animation start time
      bitmap: await createImageBitmap(canvas),
    }
    this.#cache.set(id, state)
  }

  const ctx = state.canvas.getContext('2d')!
  // Reset transform matrix each frame to prevent scale accumulation from multiple calls
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0)

  // Clear previous frame content
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  ctx.save()
  // Round corner clipping (if radius configured)
  if (this.#options.radius > 0) {
    ctx.beginPath()
    ctx.roundRect(0, 0, cssWidth, cssHeight, this.#options.radius)
    ctx.clip()
  }

  // Draw base color (supports solid color string or gradient object)
  const bgStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, this.#options.backgroundColor)
  ctx.fillStyle = bgStyle
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // Calculate breathing animation progress and overlay highlight
  const elapsed = now - state.startTime
  const progress = (elapsed % this.#options.duration) / this.#options.duration
  // Sine alpha calculation: 0.3 + 0.3 * sin(progress * 2π) → range [0, 0.6]
  const alpha = 0.3 + 0.3 * Math.sin(progress * Math.PI * 2)
  // Regex replaces highlight color's alpha channel: 'rgba(255,255,255,0.6)' → 'rgba(255,255,255,{alpha})'
  ctx.fillStyle = this.#options.highlightColor.replace(/[\d.]+\)$/, `${alpha})`)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  ctx.restore()

  // Release previous frame's ImageBitmap to prevent memory leak
  state.bitmap.close()
  // Create new ImageBitmap from current canvas content
  state.bitmap = await createImageBitmap(state.canvas)

  return state.bitmap
}
```

**Design Notes**:

- **DPR capped at 2** (`Math.min(2, dpr)`): Placeholders are simple solid/gradient graphics — 3x resolution offers no perceptible clarity improvement, but increases canvas pixel area by 125% (from 4x to 9x), adding `createImageBitmap` decode overhead.
- **`ctx.setTransform` reset**: Called each frame instead of accumulating `ctx.scale`. If using `scale`, the value would grow exponentially over multiple frames. `setTransform` directly sets the absolute transform matrix, ensuring each frame starts from the correct DPR state.
- **`state.bitmap.close()` before creating new bitmap**: `createImageBitmap` creates a new GPU/memory resource reference. Without closing the old one, each animation frame accumulates an unreleased ImageBitmap — at 60fps that's 60 leaked per second.
- **Regex alpha replacement**: `highlightColor.replace(/[\d.]+\)$/, ...)` matches the number+closing-paren at the end of an rgba string (i.e., the alpha value), modifying only transparency while preserving color channels. This is more concise than parsing and reassembling RGBA each frame.

### 3.3 Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `backgroundColor` | `'#e0e0e0'` | Base color (supports GradientBackground) |
| `highlightColor` | `'rgba(255, 255, 255, 0.6)'` | Breathing highlight color |
| `duration` | `1500` | Single cycle duration (ms) |
| `radius` | `0` | Border radius (px) |

### 3.4 Caching Strategy

Each placeholder (id) has independent cache:

```typescript
interface AnimationState {
  startTime: number       // Animation start time
  bitmap: ImageBitmap     // Current frame bitmap
  canvas: HTMLCanvasElement // Offscreen drawing canvas
  dpr: number             // Device pixel ratio
}
```

**Why cache**:
- Canvas creation is expensive; reuse avoids GC pressure
- startTime ensures independent animation progress per placeholder
- Bitmap reuse avoids frequent creation/destruction

---

## 4. SpinPlaceholderRenderer (Spinning Loader)

### 4.1 Animation Principle

4 dots rotating around a center point:

```
angle = (elapsed / 1200 × 360) % 360
```

- Completes one full rotation in 1200ms
- 4 dots evenly distributed at square corners
- Each dot has gradient color (HSL lightness decreasing)

### 4.2 Complete Drawing Logic Implementation

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
  // Disable anti-aliasing: small dots appear blurry with smoothing enabled, sharper without it
  ctx.imageSmoothingEnabled = false

  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // Draw background
  const bgStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, this.#options.backgroundColor || '#f2f2f2')
  ctx.fillStyle = bgStyle
  ctx.fillRect(0, 0, Math.ceil(cssWidth), Math.ceil(cssHeight))

  // Calculate rotation angle: completes one full rotation (360°) in 1200ms
  const elapsed = now - state.startTime
  const angle = ((elapsed / 1200) * 360) % 360
  this.#drawLoader(ctx, cssWidth, cssHeight, angle)

  state.bitmap.close()
  state.bitmap = await createImageBitmap(state.canvas)
  return state.bitmap
}

#drawLoader(ctx: CanvasRenderingContext2D, width: number, height: number, angle: number) {
  // Math.round prevents sub-pixel rendering that causes dot blurriness
  const centerX = Math.round(width / 2)
  const centerY = Math.round(height / 2)
  const dotSize = 4      // Radius of each dot
  const loaderRadius = 8 // Distance from center to each dot

  ctx.save()
  ctx.translate(centerX, centerY)
  // Convert degrees to radians: rotate all dots as a group
  ctx.rotate((angle * Math.PI) / 180)

  // 4 dots positioned at square corners (±loaderRadius, ±loaderRadius)
  const positions = [
    { x: -loaderRadius, y: -loaderRadius },
    { x: loaderRadius, y: -loaderRadius },
    { x: loaderRadius, y: loaderRadius },
    { x: -loaderRadius, y: loaderRadius },
  ]

  positions.forEach((pos, index) => {
    const x = Math.round(pos.x)  // Align to pixel grid to avoid sub-pixel blur
    const y = Math.round(pos.y)

    ctx.beginPath()
    // HSL lightness decreasing: 75% → 65% → 55% → 45%, creating a "chasing tail" visual
    ctx.fillStyle = `hsl(225, 100%, ${75 - index * 10}%)`
    ctx.arc(x, y, dotSize, 0, Math.PI * 2)
    ctx.fill()
  })

  ctx.restore()
}
```

**Design Notes**:

- **`imageSmoothingEnabled = false`**: For 4px radius dots, anti-aliasing makes edges blurry and indistinct. Disabling it produces sharper dot edges, especially noticeable on low DPR screens.
- **`Math.round()` pixel grid alignment**: Canvas renders at non-integer coordinates using sub-pixel rendering (to simulate "between two pixels" positioning), which causes graphics to blur. Rounding to integers ensures each dot aligns precisely to pixels.
- **1200ms cycle choice**: Slightly slower than 1000ms, visually more "relaxed." Using 1000ms feels anxiously fast; 1500ms feels sluggish.
- **HSL lightness decreasing (`75 - index * 10`)**: Leverages human eye sensitivity to brightness differences — even with 4 dots arranged statically, the "direction" is perceivable. During rotation, this creates the classic "chasing tail" loading animation effect.

### 4.3 Color Scheme

4 dots from light to dark:
- Dot 0: `hsl(225, 100%, 75%)` — brightest blue
- Dot 1: `hsl(225, 100%, 65%)`
- Dot 2: `hsl(225, 100%, 55%)`
- Dot 3: `hsl(225, 100%, 45%)` — deepest blue

The visual effect during rotation is similar to a "chasing" animation.

### 4.4 Comparison with Breathing

| Feature | Breathing | Spin |
|---------|-----------|------|
| Animation type | Brightness oscillation | Rotational motion |
| Visual complexity | Minimal | Slightly complex |
| Drawing cost | Low (2× fillRect) | Medium (4× arc) |
| Config options | 4 | 1 |
| Best for | Large area placeholders | Small card placeholders |

---

## 5. Background Style Utility (`helper/background.ts`)

### 5.1 Function

Provides unified background style generation for placeholders and Worker main canvas:

```typescript
function createBackgroundStyle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: string | GradientBackground,
): CanvasFillStrokeStyles['fillStyle']
```

### 5.2 Complete Implementation

```typescript
// src/helper/background.ts
export function createBackgroundStyle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bg: string | GradientBackground,
): CanvasFillStrokeStyles['fillStyle'] {
  // Solid color fast path: string used directly as fillStyle
  if (isString(bg)) {
    return bg
  }

  // Gradient path: dispatch by type field
  let gradient: CanvasGradient
  if (bg.type === 'linear') {
    // Linear gradient: start/end defaults to left-to-right ([0,0] → [width,0])
    const [x0, y0] = bg.linear?.start || [0, 0]
    const [x1, y1] = bg.linear?.end || [width, 0]
    gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  } else {
    // Radial gradient: default center point is canvas center
    const [x0, y0] = bg.radial?.start || [width / 2, height / 2]
    const [x1, y1] = bg.radial?.end || [x0, y0]
    gradient = ctx.createRadialGradient(
      x0,
      y0,
      bg.radial?.r0 || 0,                         // Inner radius defaults to 0 (starts from center point)
      x1,
      y1,
      bg.radial?.r1 || Math.max(width, height),   // Outer radius defaults to cover entire canvas
    )
  }

  // Add color stops: stops array defines the gradient's color distribution
  bg.stops.forEach((stop) => {
    gradient.addColorStop(stop.offset, stop.color)
  })

  return gradient
}
```

**Design Notes**:

- **Unified return type for solid and gradient**: `CanvasFillStrokeStyles['fillStyle']` can be either a string (color value) or a `CanvasGradient`, which corresponds exactly to the function's two branches. Callers don't need to know the specific return type — just assign directly to `ctx.fillStyle`.
- **Default value strategy**: Linear gradient defaults to horizontal (left-to-right), radial gradient defaults to expanding from center to cover the entire canvas (`Math.max(width, height)` ensures coverage of the largest dimension). This lets users provide only `stops` to get a reasonable default gradient effect.
- **`r0 || 0` and `r1 || Math.max(...)`**: Inner radius of 0 means the gradient starts from a point; outer radius using the canvas's maximum side length ensures the gradient reaches all corners (using only `width` or `height` would cause the shorter dimension of a rectangular canvas to reach its boundary early).
- **Context type compatibility**: Parameter type accepts both `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`, because this function is used by both main thread placeholder renderers and the Worker-side canvas background.

---

## 6. StatsMonitor (Performance Monitoring)

### 6.1 Function

Wraps the `stats.js` library to provide a runtime performance panel:

```typescript
const monitor = new StatsMonitor('fps', document.body)
```

### 6.2 Panel Types

| Type | Displays |
|------|----------|
| `fps` | Frame rate (recommended) |
| `ms` | Per-frame duration |
| `mb` | Memory usage |
| `custom` | Custom panel |

### 6.3 Complete Implementation

```typescript
// src/helper/stats-monitor.ts

// Panel type to stats.js internal index mapping
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
    start = true,   // Default starts immediately, reducing boilerplate code
  ) {
    this.#stats = new Stats()
    this.#stats.showPanel(panelMap[showPanel])
    dom.appendChild(this.#stats.dom)  // Mount panel DOM to specified container
    if (start) {
      this.start()
    }
  }

  start() {
    // Prevent duplicate starts: only start when animationId is null
    if (!this.#animationId) {
      this.#stats.begin()
      this.loop()
    }
  }

  stop() {
    if (this.#animationId) {
      cancelAnimationFrame(this.#animationId)  // Cancel next frame callback
      this.#animationId = null                  // Reset state, allowing start() again
      this.#stats.end()                         // End current frame timing
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

  // Recursive rAF loop: calls stats.update() every frame to refresh panel data
  private loop(): void {
    this.#stats.update()
    // Arrow function ensures correct `this` binding
    this.#animationId = requestAnimationFrame(() => this.loop())
  }
}
```

**Design Notes**:

- **Recursive `requestAnimationFrame` pattern**: The `loop()` method registers the next frame callback at the end of each frame via `requestAnimationFrame(() => this.loop())`. Compared to `setInterval`, rAF automatically aligns with the display's refresh rate and auto-pauses when the page is not visible, avoiding unnecessary resource consumption.
- **`#animationId` dual purpose**: Serves as both the `cancelAnimationFrame` handle and the running state flag. `null` means not running, non-null means running. `start()` checks this value to prevent duplicate starts, `stop()` resets it to allow restarting.
- **`start = true` default parameter**: The typical use case for a performance monitor is to begin monitoring immediately upon creation. Default `true` saves the user from calling `start()` separately. Passing `false` enables "lazy start" mode for scenarios requiring manual timing control.
- **`enable()/disable()` vs `start()/stop()` distinction**: The former only controls DOM visibility (panel continues collecting data but isn't displayed), while the latter completely stops the rAF loop. This lets users save rendering overhead when not viewing the panel without losing continuity of performance data.

### 6.4 API

| Method | Description |
|--------|-------------|
| `start()` | Start monitoring loop (prevents duplicate starts) |
| `stop()` | Stop monitoring (cancels rAF + resets state) |
| `enable()` / `disable()` | Show/hide panel (doesn't stop data collection) |
| `toggle()` | Toggle visibility state |
| `customizeStyle(style)` | Customize panel DOM styles |

---

## 7. Resource Management & Lifecycle

### 7.1 Memory Considerations

| Resource | Created When | Released When |
|----------|-------------|---------------|
| HTMLCanvasElement (placeholder) | First `render` call | `remove(id)` or `dispose()` |
| ImageBitmap (placeholder frame) | Each frame `createImageBitmap` | Next frame `bitmap.close()` |
| ImageBitmap (image) | `createImageBitmap(blob)` | Held by Worker, released on page unload |
| AbortController | ImageLoader creation | `dispose()` |

### 7.2 Release Strategy

```typescript
// PlaceholderRenderer.remove(id) — single release
const state = this.#cache.get(id)
state.canvas.width = 0   // Release canvas memory
state.canvas.height = 0
state.bitmap.close()      // Release ImageBitmap
this.#cache.delete(id)

// PlaceholderRenderer.dispose() — full release
this.#cache.forEach(state => { ... })
this.#cache.clear()
```

`canvas.width = 0` is the standard practice for releasing Canvas memory, forcing release of the backing buffer.
