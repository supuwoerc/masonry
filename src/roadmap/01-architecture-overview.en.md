# Architecture & Design Patterns

> This document provides a top-level view of `@supuwoerc/masonry`'s architectural design, threading model, design patterns, and key technical decisions.

## Module Position

This is the top-level architecture document, helping you understand why the library is designed this way and how the parts collaborate.

---

## 1. Dual-Thread Model

### 1.1 Why Dual Threads?

Bottlenecks of traditional DOM/Canvas approaches:
- Layout computation (especially masonry O(n) traversal) blocks the main thread
- Dense `drawImage` calls when rendering many images cause frame rate drops
- Scroll event handling and rendering compete for the same thread

This library's solution moves all **rendering-intensive** work to the Worker thread:

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│       Main Thread            │    │       Worker Thread          │
│                             │    │                             │
│ • Event listeners           │    │ • Layout calculation        │
│   (scroll/click)            │    │ • Canvas rendering          │
│ • Image resource loading    │    │ • Inertia scrolling physics │
│ • Placeholder generation    │    │ • Viewport culling          │
│ • ResizeObserver            │    │ • Hit detection (click)     │
│ • Message routing           │    │ • Seamless loop computation │
│ • Lifecycle management      │    │                             │
└─────────────────────────────┘    └─────────────────────────────┘
```

### 1.2 Inter-Thread Communication

Implemented via `postMessage` + `Transferable` objects:
- **OffscreenCanvas**: One-time irreversible transfer during initialization
- **ImageBitmap**: Zero-copy transfer each time an image finishes loading
- **Regular messages**: JSON-serialized `Message<T>` structure

`#initWorker()` demonstrates the core logic of OffscreenCanvas transfer and items normalization:

```typescript
// src/core/masonry.ts
async #initWorker() {
  try {
    this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
      type: 'module',
    })
    const canvas = this.#config.core.canvas
    // Critical: after transferControlToOffscreen, all rendering ops on this canvas from main thread become invalid
    const offscreenCanvas = canvas.transferControlToOffscreen()

    // ─── Build SetupPayload: only pass serializable pure data ───
    const payload: SetupPayload = {
      offscreenCanvas,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      config: { core: { backgroundColor, style, layout, limit, timeout } },
      dpr: window.devicePixelRatio || 1,
    }

    // ─── Items normalization: different processing paths for three input formats ───
    const items = this.#config.core.items
    if (items?.length) {
      if (items[0] instanceof ImageBitmap) {
        // Path 1: Pre-loaded ImageBitmap → pass directly to Worker
        payload.config.core.items = items as ImageBitmap[]
      } else {
        // Path 2: URL strings or ItemDescriptor → only pass count and dimensions
        const descriptors = this.#normalizeItems(items as string[] | ItemDescriptor[])
        payload.config.core.itemCount = descriptors.length
        payload.config.core.itemSizes = descriptors.map((d) => ({ width: d.width, height: d.height }))
        // URLs stay on main thread, loaded later by ImageLoader
        this.#pendingUrls = descriptors
      }
    }

    // OffscreenCanvas transferred as Transferable (zero-copy; main thread reference invalidated)
    this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas])
  } catch (error) {
    // Graceful degradation when Worker creation fails
    this.#useWorker = false
    this.#worker = null
    this.onError(error)
  }
}
```

**Design Notes**:

- **Items dual-path**: `ImageBitmap` can be directly transferred to Worker via `Transferable` (zero-copy), while URL strings cannot be serialized into render data Worker needs — they must stay on the main thread for async loading and per-image delivery.
- **Config trimming**: `onClick`, `loadMore`, `onReady` and other function references are non-serializable; only pure data config is sent to Worker.
- **try/catch degradation**: Worker initialization may fail due to CSP policy, unsupported environments, etc. On failure, marks `#useWorker = false` and notifies user via `onError`.

### 1.3 Why OffscreenCanvas?

| Approach | Pros | Cons |
|----------|------|------|
| DOM manipulation | Simple & intuitive | Reflow/repaint expensive, 10K+ elements infeasible |
| Main-thread Canvas | No DOM overhead | Rendering still blocks main thread |
| **OffscreenCanvas** | **Rendering never blocks main thread** | Requires Worker communication overhead |

Key code:
```typescript
// src/core/masonry.ts:160
const offscreenCanvas = canvas.transferControlToOffscreen()
```

---

## 2. Design Patterns

### 2.1 Builder Pattern

**File**: `src/core/builder.ts`

Provides a fluent API to reduce configuration complexity:

```typescript
const masonry = new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 } })
  .withInteraction({ onClick: (e) => console.log(e) })
  .withLoader({ pageSize: 20, loadMore: fetchImages })
  .build()
```

**Design intent**:
- Separates configuration concerns (core / interaction / loader / placeholder / events)
- Each `with*` method provides sensible defaults
- `build()` performs unified validation, throws `MasonryError` on failure

### 2.2 Strategy Pattern

**Files**: `src/core/layout/grid-layout.ts`, `src/core/layout/masonry-layout.ts`

Unified interface `LayoutStrategy`:

```typescript
interface LayoutStrategy {
  calculate: (input: LayoutInput) => LayoutResult
}
```

Worker selects strategy based on configuration:
```typescript
// src/core/worker/offscreen-canvas.ts:191
this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()
```

**Extending with new layouts**: Simply implement `LayoutStrategy` interface and register it in the Worker.

### 2.3 Observer Pattern

The project uses multiple observer/event mechanisms:

| Observer | Purpose | File |
|----------|---------|------|
| `ResizeObserver` | Monitor canvas container size changes | `src/core/masonry.ts:82` |
| `matchMedia` | Monitor DPR changes (browser zoom) | `src/core/masonry.ts:296-306` |
| `Worker.onmessage` | Receive Worker messages | `src/core/masonry.ts:161` |
| `globalThis.onmessage` | Worker receives main thread messages | `src/core/worker/offscreen-canvas.ts:105` |
| `AbortController` | Unified event listener cleanup | `src/core/masonry.ts:100` |

### 2.4 Queue Pattern (Serial Task Queue)

**Files**: `src/core/masonry.ts:94`, `src/core/worker/offscreen-canvas.ts:83`

Async tasks (loadMore, renderLoading) may arrive concurrently; queuing ensures ordered execution:

```typescript
// src/core/masonry.ts
#queue = new Queue<(() => void) | (() => Promise<void>)>()

async #runTask() {
  if (!this.#isRunning) {
    try {
      this.#isRunning = true
      while (this.#queue.size > 0) {
        const task = this.#queue.dequeue()
        await task?.()
      }
    } finally {
      // try/finally ensures exception safety: even if a task throws,
      // #isRunning is reset to false, preventing permanent queue deadlock
      this.#isRunning = false
    }
  }
}
```

**Design Notes**:

- **`try/finally` exception safety**: If `await task?.()` throws (e.g., loadMore network timeout), without finally `#isRunning` would remain `true` forever, and all subsequently enqueued tasks would never execute — the queue becomes permanently "stuck". `finally` ensures the lock is always released regardless of success or failure.
- **Re-entry prevention**: `if (!this.#isRunning)` ensures only one consumption loop runs at any time. Multiple calls to `#runTask()` won't start multiple concurrent consumers — newly enqueued tasks are automatically consumed by the currently running while loop.
- **Ordered execution guarantee**: `while (this.#queue.size > 0)` dequeues one at a time, combined with `await` ensures each async task completes before the next one starts.

---

## 3. Key Technical Decisions

### 3.1 Why ImageBitmap Instead of Image Elements?

| Image Element | ImageBitmap |
|--------------|-------------|
| Bound to main thread DOM | Pure data object, no DOM dependency |
| Cannot transfer cross-thread | Supports Transferable zero-copy transfer |
| Each drawImage requires decoding | Pre-decoded, better drawing performance |

```typescript
// src/core/image-loader.ts:80
return await createImageBitmap(result) // blob → pre-decoded bitmap
```

### 3.2 Why IIFE Format for Worker?

Configured in `vite.config.ts` as `worker.format: 'iife'`:
- IIFE format has the best compatibility, no ES Module loading dependency
- Bundled as a single file, avoids module resolution issues inside Worker
- No need for additional MIME type configuration during deployment

### 3.3 Why requestAnimationFrame for the Render Loop?

#### Full Implementation (`#startAnimationLoop`)

```typescript
// src/core/worker/offscreen-canvas.ts
#animationRunning = false

#startAnimationLoop() {
  if (this.#animationRunning) {
    return  // Prevent duplicate start: only one rAF loop runs at a time
  }
  this.#animationRunning = true
  const renderFrame = () => {
    // Step 1: Process inertia scrolling (decay velocity each frame + re-render)
    if (this.#isInertiaActive) {
      this.#tickInertia()
      this.#handleRerender()
    }
    // Step 2: Check if there are still items in loading state
    const loadingItems = this.#gridItems.filter((item) => item.status !== 'loaded')
    const ids = loadingItems.map((item) => item.id)
    if (ids.length > 0) {
      // idsChanged optimization: only send message when loading items set actually changes
      // Avoids sending duplicate RenderLoading requests every frame
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
    // Step 3: Conditional exit — stop loop when no inertia and no loading items
    const hasWork = this.#isInertiaActive || ids.length > 0
    if (hasWork) {
      requestAnimationFrame(renderFrame)
    } else {
      this.#animationRunning = false
    }
  }
  renderFrame()  // Execute first frame immediately, don't wait for next vsync
}
```

**Design Notes**:

- **`idsChanged` optimization**: Placeholder rendering is a cross-thread async flow (Worker → Main → render → Main → Worker). Sending `RenderLoading` every frame would flood the message channel with redundant requests. `idsChanged` uses Set comparison to ensure messages are only sent when the loading set actually changes.
- **Conditional exit avoids idle spinning**: When `hasWork` is false, sets `#animationRunning = false` and stops the loop. This means once all images are loaded and no inertia scrolling is active, the rAF loop completely stops — zero CPU consumption. Subsequent scrolls or new data arrival call `#startAnimationLoop()` again to restart.
- **`renderFrame()` called immediately**: Not `requestAnimationFrame(renderFrame)` but direct `renderFrame()`. This ensures the first frame executes immediately without waiting for the next vsync signal (~16.7ms delay).

### 3.4 Background Layer Separation (Dual Canvas)

Worker uses two canvases: `#canvas` (main) + `#backgroundCanvas` (background cache)

```typescript
// src/core/worker/offscreen-canvas.ts:66-67
#backgroundCanvas!: OffscreenCanvas
#canvas!: OffscreenCanvas
```

**Reason**: Background (gradient) doesn't change per frame; separation avoids recalculating gradient stops every frame → just `drawImage` copy from cache.

#### Render Pipeline Full Flow (`#handleRerender`)

```typescript
// src/core/worker/offscreen-canvas.ts
#handleRerender() {
  if (this.#context) {
    try {
      // Step 1: Clear main canvas current frame content
      this.#clear()
      // Step 2: Clear background canvas (prepare for redraw)
      this.#clearBackground()
      // Step 3: Draw gradient/solid background on background canvas
      this.#handleRenderBackground()
      // Step 4: Copy background canvas content to main canvas (drawImage bulk copy)
      this.#copyBackground()
      // Step 5: Save current transform matrix state
      this.#context.save()
      // Step 6: Apply scroll offset (translate instead of per-item coordinate calculation)
      this.#context.translate(-this.#scrollX, -this.#scrollY)
      // Step 7: Choose rendering strategy based on mode
      if (this.#isLoopActive) {
        this.#renderLoopedItems(this.#gridItems)    // Seamless loop: modulo mapping
      } else {
        this.#renderGridItems(this.#getVisibleItems(this.#gridItems))  // Normal mode: viewport culling
      }
      // Step 8: Restore transform matrix
      this.#context.restore()
    } catch (error) {
      this.#sendError(error)
    }
  }
}
```

**Design Notes**:

- **`save()/restore()` pairing**: `translate` shifts the coordinate origin; `restore()` ensures the next frame's background drawing isn't affected by scroll offset. Forgetting `restore()` would cause the background to move with scrolling.
- **`translate(-scrollX, -scrollY)` replaces per-item offset**: Canvas provides matrix transform APIs; a single `translate` is more efficient than N items each subtracting scrollX/scrollY — only one GPU state change.
- **Background separation benefit**: `createLinearGradient` + `addColorStop` calls are expensive at large pixel counts. Separated to `#backgroundCanvas`, gradients are only regenerated on resize/DPR changes; each frame just needs one `drawImage` bulk copy (GPU-optimized path).
- **try/catch error boundary**: `#sendError` forwards exceptions back to main thread's `onError` callback, preventing render errors from crashing the Worker.

---

## 4. Module Dependency Graph

```
index.ts
  └── core/builder.ts
        └── core/masonry.ts (main orchestrator)
              ├── core/image-loader.ts
              ├── core/placeholder/*
              ├── helper/validator.ts + core/rules.ts
              └── core/worker/offscreen-canvas.ts (Worker entry)
                    ├── core/layout/grid-layout.ts
                    ├── core/layout/masonry-layout.ts
                    ├── core/worker/protocol.ts
                    └── helper/background.ts
```

---

## 5. Performance Design Summary

| Strategy | Effect |
|----------|--------|
| Worker offscreen rendering | Zero rendering blocking on main thread |
| ImageBitmap Transferable | Zero-copy image transfer |
| Viewport culling | Only render dozens of 10,000+ elements |
| Background layer cache | Avoid recalculating gradient per frame |
| Inertia stop threshold | Stop animation loop when velocity < 0.5px |
| Conditional rAF | No idle spinning when no work |
| debounce resize | Prevent high-frequency resize messages |
| p-limit concurrency | Avoid too many simultaneous network requests |
