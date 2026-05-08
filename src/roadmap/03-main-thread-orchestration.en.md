# Main Thread Orchestration & Event Coordination

> This document covers the `Masonry` main class lifecycle, Worker initialization, message routing, scroll/click event handling, and container responsiveness.

## Module Position

The `Masonry` class is the core orchestrator of the entire library. Running on the main thread, it coordinates all subsystems: Worker communication, image loading, placeholder rendering, event listening, and container resize response.

## Source Files

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/core/masonry.ts` | 520 | Main orchestrator |
| `src/core/image-loader.ts` | 90 | Image loading |
| `src/core/constant.ts` | 26 | Default configurations |

---

## 1. Lifecycle

### 1.1 Construction Flow

```
new Masonry(config)
  │
  ├── isCanvasSupported() → throws if unsupported
  ├── Validator.validate(config) → throws if invalid
  ├── #config = config
  └── #init()
        ├── #initPlaceholderRenderer() → set placeholder renderer
        ├── #initEvents() → bind onReady / onError
        ├── #initObserver() → ResizeObserver + DPR listener
        ├── #initScrollListeners() → wheel / pointer events
        └── #initWorker() → create Worker + transfer OffscreenCanvas
```

### 1.2 Destruction Flow

```typescript
destroy() {
  worker.terminate()        // Terminate Worker
  imageLoader.dispose()     // Cancel all loads
  scrollAbort.abort()       // Unregister all event listeners
  resizeObserver.disconnect() // Disconnect Observer
  dprMediaQuery = null      // Release matchMedia
  placeholderRenderer.dispose() // Clean placeholder resources
}
```

---

## 2. Worker Initialization (`#initWorker`)

### 2.1 Full Implementation

```typescript
// src/core/masonry.ts
async #initWorker() {
  try {
    // import.meta.url lets Vite correctly resolve the Worker file path and bundle it
    this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
      type: 'module',
    })
    const canvas = this.#config.core.canvas
    // Critical: after transferControlToOffscreen, all rendering operations on this canvas from main thread become invalid
    const offscreenCanvas = canvas.transferControlToOffscreen()

    // Register message handlers
    this.#worker.onmessage = this.#handleWorkerMessage.bind(this)
    this.#worker.onerror = (e: Event) => {
      this.onError(new MasonryError(`Worker error: ${(e as ErrorEvent).message || 'unknown'}`))
    }

    // ─── Build SetupPayload: only pass serializable pure data ───
    const payload: SetupPayload = {
      offscreenCanvas,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      config: {
        core: {
          backgroundColor: this.#config.core.backgroundColor,
          style: this.#config.core.style,
          layout: this.#config.core.layout,
          limit: this.#config.core.limit,
          timeout: this.#config.core.timeout,
        },
      },
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
        payload.config.core.itemSizes = descriptors.map((d) => ({
          width: d.width,
          height: d.height,
        }))
        // URLs stay on main thread, loaded later by ImageLoader
        this.#pendingUrls = descriptors
      }
    }

    // ─── Config trimming: exclude non-serializable functions ───
    if (this.#config.interaction) {
      payload.config.interaction = {
        scroll: this.#config.interaction?.scroll,
      }
    }
    if (this.#config.loader) {
      payload.config.loader = {
        pageSize: this.#config.loader.pageSize,
      }
    }

    // OffscreenCanvas transferred as Transferable (zero-copy)
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

- **`type: 'module'`**: Enables ESM syntax in Worker, integrating with Vite's build pipeline. Vite automatically bundles Worker code as a separate chunk.
- **`transferControlToOffscreen()` is irreversible**: Once called, the main thread can never perform rendering operations on that canvas again. This is a hard browser constraint ensuring only one thread owns rendering rights.
- **try/catch degradation**: If Worker initialization fails (CSP policy blocking, Blob URL unavailable, etc.), the entire instance doesn't crash — it notifies the user via `onError` and marks `#useWorker = false`.
- **Config trimming**: `onClick`, `loadMore`, `onReady` and other function references are non-serializable (cannot be transferred via `postMessage`) and must remain on the main thread. Worker only needs pure data configuration.

---

## 3. Message Routing (`#handleWorkerMessage`)

### 3.1 Full Implementation

```typescript
// src/core/masonry.ts
#handleWorkerMessage(event: MessageEvent<Message>) {
  const { type, payload } = event.data
  switch (type) {
    case MessageType.SetupResponse:
      // Initialization complete: notify user → trigger first render → start image loading
      this.onReady?.(this)
      this.#sendMessage(MessageType.Render, null)
      this.#loadImages()
      break
    case MessageType.LoadMore:
      // Worker requests more data → enqueue async task
      this.#handleLoadMoreTask()
      this.#runTask()
      break
    case MessageType.RenderLoading:
      // Worker requests placeholder rendering → enqueue placeholder render task
      this.#handleRenderLoading(payload as Array<string>)
      this.#runTask()
      break
    case MessageType.RemoveLoading:
      // An item finished loading → release its placeholder resources
      this.#placeholderRenderer.remove(payload as string)
      break
    case MessageType.LayoutUpdated:
      // Layout changed → notify upstream application (e.g., update container height)
      this.#config.interaction?.onLayoutUpdate?.(payload as LayoutUpdatedPayload)
      break
    case MessageType.ClickResult:
      // Worker returns hit detection result → trigger onClick callback
      this.#handleClickResult(payload as ClickResultPayload)
      break
    case MessageType.Error:
      // Worker internal error → pass to onError
      this.onError(payload)
      break
  }
}
```

**Design Notes**:

- **`SetupResponse` is the startup signal**: It triggers three actions — notify user ready, send Render to start the render loop, start async image loading. The order matters: first notify the user they can interact, then start rendering (which may show placeholders), finally begin loading real images.
- **`LoadMore` and `RenderLoading` are queued**: These tasks involve async operations (network requests, placeholder rendering); queuing ensures serial execution and prevents concurrency issues.
- **`RemoveLoading` executes directly**: Releasing placeholder resources is synchronous with no side effects — no queuing needed.

### 3.2 Placeholder Rendering Task (`#handleRenderLoading`)

```typescript
// src/core/masonry.ts
#handleRenderLoading(ids: Array<string>) {
  if (ids.length > 0) {
    this.#queue.enqueue(async () => {
      try {
        const { width, height } = this.#config.core.style
        // Render all loading placeholders in parallel
        const tasks = ids.map(async (id) => {
          const bitmap = await this.#placeholderRenderer.render(width, height, id)
          // Validate bitmap before sending (prevent empty bitmaps causing Worker draw errors)
          if (bitmap.width > 0 && bitmap.height > 0) {
            this.#sendMessage(MessageType.RenderLoadingResponse, { bitmap, id }, [bitmap])
          }
        })
        await Promise.all(tasks)
      } catch (error) {
        this.onError(error)
      }
    })
  }
}
```

**Design Notes**:

- **`Promise.all(tasks)` parallel rendering**: Multiple placeholders can render simultaneously (each has its own independent Canvas), no serial waiting needed.
- **`bitmap.width > 0 && bitmap.height > 0` validation**: `createImageBitmap` may return empty bitmaps in edge cases (canvas dimensions are 0). Sending empty bitmaps to Worker would cause `drawImage` exceptions.
- **bitmap as Transferable**: `[bitmap]` transfers the ImageBitmap zero-copy to Worker; the main thread's bitmap reference becomes invalid immediately (width/height become 0).

### 3.3 Pagination Loading Task (`#handleLoadMoreTask`)

```typescript
// src/core/masonry.ts
#handleLoadMoreTask() {
  this.#queue.enqueue(async () => {
    // Triple guard: no loader / already loading / no more data
    if (!this.#config?.loader || this.#pagination.loading || !this.#pagination.hasMore) {
      return
    }
    try {
      this.#pagination.loading = true  // Re-entry prevention lock
      const { loadMore, pageSize } = this.#config.loader
      // Call user-provided loadMore function
      const list = await loadMore(this.#pagination.page, pageSize)

      const message: LoadMoreResponsePayload = {
        page: this.#pagination.page,
        hasMore: list.length >= pageSize,  // Heuristic: returned count < pageSize → no more data
        data: [],
      }

      if (list && list.length > 0) {
        this.#pagination.page++
        if (list[0] instanceof ImageBitmap) {
          // Path A: loadMore directly returns ImageBitmap (pre-loaded scenario)
          message.data = list as ImageBitmap[]
        } else {
          // Path B: returns URL/ItemDescriptor → need to load as ImageBitmap first
          const descriptors = this.#normalizeItems(list as string[] | ItemDescriptor[])
          const loader = this.#imageLoader ?? new ImageLoader(this.#config.imageLoad)
          const bitmaps: ImageBitmap[] = []
          await loader.loadBatch(
            descriptors.map((d, i) => ({
              url: d.url,
              index: i,
              width: d.width,
              height: d.height,
            })),
            (_index, bitmap) => {
              bitmaps.push(bitmap)
            },
          )
          message.data = bitmaps
        }
      }

      if (list.length < pageSize) {
        this.#pagination.hasMore = false
        message.hasMore = false
      }
      this.#sendMessage(MessageType.LoadMoreResponse, message)
    } catch (error) {
      this.onError(new MasonryError(`Failed to load more items: ${error}`))
    } finally {
      this.#pagination.loading = false  // Release lock regardless of success or failure
    }
  })
}
```

**Design Notes**:

- **`list.length >= pageSize` heuristic**: If returned data count equals the requested amount (pageSize), assume more data exists; less than pageSize means we've reached the end. This is a common pagination API convention.
- **`try/finally` ensures lock release**: `this.#pagination.loading = false` is in the finally block, so even if loadMore throws, the re-entry lock is released, preventing subsequent loads from being permanently blocked.
- **Dual-path processing**: loadMore can return `ImageBitmap[]` (server-side pre-rendering scenario) or strings/descriptors (normal URL loading scenario). The latter requires additional async loading steps.

---

## 4. Message Sending (`#sendMessage`)

Unified message sending method:

```typescript
#sendMessage(type: MessageType, payload: MessagePayload, transfer?: Transferable[]) {
  const message: Message = {
    id: nanoid(),           // Unique ID
    type,                   // Message type
    payload,                // Payload data
    timestamp: Date.now(),  // Timestamp
  }
  this.#worker?.postMessage(message, transfer ?? [])
}
```

The `transfer` array specifies Transferable objects (OffscreenCanvas, ImageBitmap); original references are invalidated after transfer.

---

## 5. Scroll Event Handling

### 5.1 Event Listener Registration

```typescript
// src/core/masonry.ts
#initScrollListeners() {
  const canvas = this.#config.core.canvas
  const signal = this.#scrollAbort.signal

  // passive: false allows preventDefault() (blocking page scroll)
  canvas.addEventListener('wheel', this.#handleWheel.bind(this), { passive: false, signal })
  canvas.addEventListener('pointerdown', this.#handlePointerDown.bind(this), { signal })
  canvas.addEventListener('pointermove', this.#handlePointerMove.bind(this), { signal })
  canvas.addEventListener('pointerup', this.#handlePointerUp.bind(this), { signal })
  canvas.addEventListener('pointercancel', this.#handlePointerUp.bind(this), { signal })
}
```

**Design Notes**: All listeners are managed uniformly via `AbortController.signal`. During `destroy()`, calling `this.#scrollAbort.abort()` unregisters all events at once — no need to call `removeEventListener` individually or save handler references.

### 5.2 Wheel Event

```typescript
// src/core/masonry.ts
#handleWheel(e: WheelEvent) {
  e.preventDefault()  // Block page scrolling (requires passive: false)
  const scroll = this.#config.interaction?.scroll
  const deltaX = scroll?.disabled?.horizontal ? 0 : e.deltaX
  const deltaY = scroll?.disabled?.vertical ? 0 : e.deltaY
  if (deltaX !== 0 || deltaY !== 0) {
    const payload: ScrollPayload = { deltaX, deltaY }
    this.#sendMessage(MessageType.Scroll, payload)
  }
}
```

### 5.3 Pointer Events (Touch/Drag) Full Implementation

```typescript
// src/core/masonry.ts
#handlePointerDown(e: PointerEvent) {
  this.#pointerState.down = true
  this.#pointerState.startX = e.clientX   // Record start position (for click determination)
  this.#pointerState.startY = e.clientY
  this.#pointerState.lastX = e.clientX    // Record last frame position (for delta calculation)
  this.#pointerState.lastY = e.clientY
  // setPointerCapture: ensures move/up events are received even if pointer leaves canvas bounds
  ;(e.target as HTMLElement)?.setPointerCapture?.(e.pointerId)
}

#handlePointerMove(e: PointerEvent) {
  if (!this.#pointerState.down) {
    return  // Ignore movement when not pressed
  }
  const scroll = this.#config.interaction?.scroll
  // Note: direction is reversed from wheel. Dragging right = content moves left = positive deltaX
  const dx = scroll?.disabled?.horizontal ? 0 : this.#pointerState.lastX - e.clientX
  const dy = scroll?.disabled?.vertical ? 0 : this.#pointerState.lastY - e.clientY
  this.#pointerState.lastX = e.clientX
  this.#pointerState.lastY = e.clientY
  if (dx !== 0 || dy !== 0) {
    const payload: ScrollPayload = { deltaX: dx, deltaY: dy }
    this.#sendMessage(MessageType.Scroll, payload)
  }
}

#handlePointerUp(e: PointerEvent) {
  if (!this.#pointerState.down) {
    return
  }
  this.#pointerState.down = false
  // Determine drag vs click: distance from start to end < 5px is considered a click
  const dx = Math.abs(e.clientX - this.#pointerState.startX)
  const dy = Math.abs(e.clientY - this.#pointerState.startY)
  if (dx < 5 && dy < 5 && this.#config.interaction?.onClick) {
    // Convert to canvas-relative coordinates
    const rect = this.#config.core.canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    this.#pendingClickEvent = e  // Save original event for later callback delivery
    const payload: ClickPayload = { x, y }
    this.#sendMessage(MessageType.Click, payload)
  }
}
```

**Design Notes**:

- **`setPointerCapture`**: After capturing the pointer, move and up events continue to arrive even when the user drags outside the canvas area. This is critical for fast drags — fingers moving quickly easily exceed canvas boundaries.
- **5px threshold**: Touch jitter on mobile devices is typically 2-3px. A 5px threshold reliably distinguishes "finger tap" (click) from "finger swipe" (drag), avoiding mis-triggers.
- **`lastX - e.clientX` direction reversal**: The physical intuition of dragging is "pushing content in a direction", so finger moving right means content scrolls left (positive deltaX). This maintains semantic consistency with wheel events.
- **`#pendingClickEvent` preservation**: Click handling is asynchronous (send message to Worker → Worker hit detection → return result), so the original PointerEvent must be saved to pass to the user in the final callback.

---

## 6. Container Responsiveness

### 6.1 ResizeObserver

```typescript
#resizeObserver = new ResizeObserver(() => this.#resize())
```

Monitors the canvas element for size changes.

### 6.2 DPR Listener Full Implementation

```typescript
// src/core/masonry.ts
#initDprListener() {
  if (typeof window.matchMedia !== 'function') {
    return  // Environments without matchMedia support (SSR / some test environments)
  }
  const updateDpr = () => {
    this.#resize()
    // Remove old listener: its bound DPR value is now stale
    this.#dprMediaQuery?.removeEventListener('change', updateDpr)
    // Recursive rebuild: create new matchMedia query with the new DPR value
    this.#initDprListener()
  }
  // matchMedia monitors a specific DPR value: triggers change when DPR is no longer this value
  this.#dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  this.#dprMediaQuery.addEventListener('change', updateDpr)
}
```

**Design Notes**:

- **Why recursive rebuild**: `matchMedia('(resolution: 2dppx)')` only fires a single change event when DPR changes from 2 to some other value. After the change, the new DPR could be 1.5, 3, or any other value — a new query must be created to monitor the next change. This "recursive re-registration" is the standard pattern for monitoring continuous value changes with `matchMedia`.
- **Use cases**: Triggered when users drag a browser window to a different density display (macOS external monitor), or when using browser zoom (Ctrl+/Ctrl-).

### 6.3 Resize Debounce Full Implementation

```typescript
// src/core/masonry.ts
#resize = debounce(100 / 6, () => {
  const payload: ResizePayload = {
    clientWidth: this.#config.core.canvas.clientWidth,
    clientHeight: this.#config.core.canvas.clientHeight,
    dpr: window.devicePixelRatio || 1,
  }
  this.#sendMessage(MessageType.Resize, payload)
})
```

**Design Notes**:

- **`100 / 6 ≈ 16.7ms` debounce interval**: Aligned with one frame duration (60fps). Dragging a window to resize may trigger ResizeObserver every frame; debouncing ensures multiple resize events within the same frame only send one message.
- **DPR included in payload**: Resize events can come not only from window size changes, but also from DPR changes (`#initDprListener` also calls `#resize()`). Including DPR uniformly in the payload lets Worker handle both scenarios with unified logic.

---

## 7. Async Task Queue

### 7.1 Why a Queue?

Worker may send `LoadMore` and `RenderLoading` messages in rapid succession. Without queuing:
- Two loadMore calls might execute simultaneously, causing duplicate requests
- Interleaved renderLoading and loadMore execution could cause state inconsistency

### 7.2 Implementation

```typescript
#queue = new Queue<(() => void) | (() => Promise<void>)>()

async #runTask() {
  if (!this.#isRunning) {
    this.#isRunning = true
    while (this.#queue.size > 0) {
      const task = this.#queue.dequeue()
      await task?.()
    }
    this.#isRunning = false
  }
}
```

After enqueuing a task, `#runTask()` is called; if already running, new tasks automatically wait in queue.

---

## 8. Image Loading Flow

### 8.1 Trigger Timing

Starts immediately after `SetupResponse` message handling:

```typescript
case MessageType.SetupResponse:
  this.onReady?.(this)
  this.#sendMessage(MessageType.Render, null)
  this.#loadImages()  // ← Start async image loading
```

### 8.2 Loading & Notification

```typescript
#loadImages() {
  this.#imageLoader = new ImageLoader(this.#config.imageLoad)
  this.#imageLoader.loadBatch(batch, (index, bitmap, width, height) => {
    const payload: ImageLoadedPayload = { index, bitmap, width, height }
    this.#sendMessage(MessageType.ImageLoaded, payload, [bitmap])
  })
}
```

Each image is reported to Worker immediately upon loading. Worker updates the corresponding item and re-renders.
