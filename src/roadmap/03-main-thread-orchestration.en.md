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

### 2.1 Creating the Worker

```typescript
this.#worker = new Worker(
  new URL('./worker/offscreen-canvas.ts', import.meta.url),
  { type: 'module' }
)
```

Uses `import.meta.url` so Vite correctly resolves the Worker file path and bundles it.

### 2.2 Transferring OffscreenCanvas

```typescript
const offscreenCanvas = canvas.transferControlToOffscreen()
```

**Key point**: After `transferControlToOffscreen()`, all rendering operations on this canvas from the main thread become invalid. Control is completely transferred to the Worker.

### 2.3 Constructing SetupPayload

The initialization message sent to Worker contains:

| Field | Content |
|-------|---------|
| `offscreenCanvas` | Offscreen canvas (Transferable) |
| `clientWidth/Height` | Container CSS dimensions |
| `dpr` | Device pixel ratio |
| `config.core` | Background color, style, layout mode |
| `config.interaction` | Scroll configuration |
| `config.loader` | pageSize |

### 2.4 Items Normalization

Branched processing based on input type:

```
items[0] instanceof ImageBitmap → passed directly to Worker (payload.config.core.items)
items is string[] / ItemDescriptor[] → converted to {itemCount, itemSizes} + #pendingUrls
```

The latter creates loading placeholders in Worker; main thread loads images asynchronously and notifies Worker one by one.

---

## 3. Message Routing (`#handleWorkerMessage`)

Messages from Worker arrive via `onmessage` and are dispatched by `type`:

| MessageType | Handling Logic |
|-------------|---------------|
| `SetupResponse` | Trigger onReady → send Render → start image loading |
| `LoadMore` | Enqueue pagination loading task |
| `RenderLoading` | Enqueue placeholder rendering task |
| `RemoveLoading` | Call placeholderRenderer.remove(id) |
| `LayoutUpdated` | Callback onLayoutUpdate |
| `ClickResult` | Callback onClick |
| `Error` | Callback onError |

### 3.1 Placeholder Rendering Task (`#handleRenderLoading`)

```
Worker detects loading items → sends RenderLoading(ids)
→ Main: for each id, call placeholderRenderer.render(width, height, id)
→ generates ImageBitmap → sends RenderLoadingResponse({bitmap, id}, [bitmap])
→ Worker: draws bitmap at corresponding grid cell
```

### 3.2 Pagination Loading Task (`#handleLoadMoreTask`)

```
Worker detects near boundary → sends LoadMore
→ Main: calls loader.loadMore(page, pageSize)
→ gets new data → loads as ImageBitmap[]
→ sends LoadMoreResponse({page, hasMore, data})
→ Worker: appends items → performLayout → rerender
```

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
canvas.addEventListener('wheel', handler, { passive: false, signal })
canvas.addEventListener('pointerdown', handler, { signal })
canvas.addEventListener('pointermove', handler, { signal })
canvas.addEventListener('pointerup', handler, { signal })
canvas.addEventListener('pointercancel', handler, { signal })
```

All listeners managed via `AbortController.signal`, unregistered in one call during `destroy()`.

### 5.2 Wheel Event

```typescript
#handleWheel(e: WheelEvent) {
  e.preventDefault()  // Prevent page scrolling
  // Filter directions based on disabled config
  const deltaX = scroll?.disabled?.horizontal ? 0 : e.deltaX
  const deltaY = scroll?.disabled?.vertical ? 0 : e.deltaY
  // Send message if there's delta
  if (deltaX !== 0 || deltaY !== 0) {
    this.#sendMessage(MessageType.Scroll, { deltaX, deltaY })
  }
}
```

### 5.3 Pointer Events (Touch/Drag)

Three-phase handling:

1. **pointerdown**: Record start position, capture pointer
2. **pointermove**: Calculate delta, send Scroll message
3. **pointerup**: Determine drag vs click (displacement < 5px = click)

```typescript
// Click determination: distance from start to end < 5px
const dx = Math.abs(e.clientX - this.#pointerState.startX)
const dy = Math.abs(e.clientY - this.#pointerState.startY)
if (dx < 5 && dy < 5 && this.#config.interaction?.onClick) {
  // Treated as click → send Click message to Worker for hit detection
}
```

### 5.4 Click Handling Flow

```
pointerup (displacement<5px) → calculate canvas-relative coords → sendMessage(Click, {x, y})
→ Worker: handleClick → hit detection → sendMessage(ClickResult, {item, index, row, column})
→ Main: handleClickResult → call onClick callback
```

---

## 6. Container Responsiveness

### 6.1 ResizeObserver

```typescript
#resizeObserver = new ResizeObserver(() => this.#resize())
```

Monitors the canvas element for size changes.

### 6.2 DPR Listener

Uses `matchMedia` with recursive rebuilding for DPR changes:

```typescript
#initDprListener() {
  const updateDpr = () => {
    this.#resize()
    this.#dprMediaQuery?.removeEventListener('change', updateDpr)
    this.#initDprListener() // Rebuild recursively because DPR value changed
  }
  this.#dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  this.#dprMediaQuery.addEventListener('change', updateDpr)
}
```

**Why recursive rebuild**: `matchMedia` binds to a specific DPR value (e.g., `2dppx`); when DPR changes, a new value must be monitored.

### 6.3 Resize Debouncing

```typescript
#resize = debounce(100 / 6, () => {
  this.#sendMessage(MessageType.Resize, {
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
    dpr: window.devicePixelRatio || 1,
  })
})
```

~16.7ms debounce, aligned with one frame duration, avoiding excessive messages from continuous resizing.

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
