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

```
loadBatch(urls)
  │
  ├── Create limit-wrapped task for each URL
  │     │
  │     └── #loadWithRetry(url)
  │           │
  │           └── retry(() => #fetchWithTimeout(url), options)
  │                 │
  │                 └── withTimeout(fetcher(url, signal), timeout)
  │                       │
  │                       ├── Returns ImageBitmap → use directly
  │                       └── Returns Blob → createImageBitmap(blob)
  │
  └── Each task completes → onLoaded(index, bitmap, width, height)
```

### 1.4 Concurrency Control (p-limit)

```typescript
this.#limit = pLimit(config?.concurrency ?? 6)
```

p-limit maintains an internal queue, limiting concurrent running Promises to the concurrency limit. Excess tasks queue up and wait.

**Why concurrency control**:
- Browsers limit concurrent connections per domain (typically 6-8)
- Loading too many images simultaneously competes for bandwidth, making all images slow
- Controlled concurrency lets the first few images appear faster

### 1.5 Retry Strategy

```typescript
async #loadWithRetry(url: string): Promise<ImageBitmap> {
  return retry(() => this.#fetchWithTimeout(url), {
    maxAttempts: this.#maxRetries + 1,  // First attempt + retries
    delayMs: this.#retryDelay,           // Base delay 500ms
    backoffFactor: 2,                    // Exponential factor
    shouldRetry: () => !this.#abortController.signal.aborted,
  })
}
```

**Exponential backoff timeline**:
```
1st failure → wait 500ms → retry
2nd failure → wait 1000ms → retry
3rd failure → wait 2000ms → retry
4th failure → give up
```

### 1.6 Timeout Control

```typescript
async #fetchWithTimeout(url: string): Promise<ImageBitmap> {
  const result = await withTimeout(
    this.#fetcher(url, this.#abortController.signal),
    this.#timeout,  // Default 10000ms
  )
  if (result instanceof ImageBitmap) return result
  return await createImageBitmap(result)  // Blob → ImageBitmap
}
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

### 3.2 Rendering One Frame

```typescript
async render(width: number, height: number, id: string): Promise<ImageBitmap> {
  // 1. DPR adaptation
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const physWidth = Math.round(width * dpr)
  const physHeight = Math.round(height * dpr)

  // 2. Get or create cached state
  let state = this.#cache.get(id)
  if (!state) {
    const canvas = document.createElement('canvas')
    canvas.width = physWidth
    canvas.height = physHeight
    state = { canvas, dpr, startTime: now, bitmap: ... }
    this.#cache.set(id, state)
  }

  // 3. Clear canvas
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 4. Round corner clipping (if radius configured)
  if (radius > 0) {
    ctx.roundRect(0, 0, cssWidth, cssHeight, radius)
    ctx.clip()
  }

  // 5. Draw background (supports solid/gradient)
  ctx.fillStyle = createBackgroundStyle(ctx, cssWidth, cssHeight, backgroundColor)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 6. Overlay breathing highlight
  const elapsed = now - state.startTime
  const progress = (elapsed % duration) / duration
  const alpha = 0.3 + 0.3 * Math.sin(progress * Math.PI * 2)
  ctx.fillStyle = highlightColor.replace(/[\d.]+\)$/, `${alpha})`)
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  // 7. Generate ImageBitmap
  state.bitmap.close()  // Release previous frame
  state.bitmap = await createImageBitmap(state.canvas)
  return state.bitmap
}
```

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

### 4.2 Drawing Logic

```typescript
#drawLoader(ctx, width, height, angle) {
  const centerX = width / 2
  const centerY = height / 2

  ctx.translate(centerX, centerY)
  ctx.rotate((angle * Math.PI) / 180)

  const positions = [
    { x: -8, y: -8 },  // Top-left
    { x: 8, y: -8 },   // Top-right
    { x: 8, y: 8 },    // Bottom-right
    { x: -8, y: 8 },   // Bottom-left
  ]

  positions.forEach((pos, index) => {
    ctx.fillStyle = `hsl(225, 100%, ${75 - index * 10}%)`
    ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2)
    ctx.fill()
  })
}
```

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

### 5.2 Supported Types

**Solid color**:
```typescript
if (isString(bg)) return bg  // Return color string directly
```

**Linear gradient**:
```typescript
const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
bg.stops.forEach(stop => gradient.addColorStop(stop.offset, stop.color))
```

**Radial gradient**:
```typescript
const gradient = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1)
bg.stops.forEach(stop => gradient.addColorStop(stop.offset, stop.color))
```

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

### 6.3 API

| Method | Description |
|--------|-------------|
| `start()` | Start monitoring loop |
| `stop()` | Stop monitoring |
| `enable()` / `disable()` | Show/hide panel |
| `toggle()` | Toggle visibility |
| `customizeStyle(style)` | Customize panel styles |

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
