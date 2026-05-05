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

**Design intent**: Prevents concurrent loadMore and renderLoading callbacks from interleaving and causing state inconsistency.

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

```typescript
// src/core/worker/offscreen-canvas.ts:507
const renderFrame = () => {
  if (this.#isInertiaActive) { ... }
  if (hasWork) {
    requestAnimationFrame(renderFrame)
  } else {
    this.#animationRunning = false
  }
}
```

- Synchronizes with display refresh rate (typically 60Hz)
- Auto-pauses when page is not visible, saving resources
- Conditional exit: stops loop when no inertia and no loading items, avoids idle spinning

### 3.4 Background Layer Separation (Dual Canvas)

Worker uses two canvases: `#canvas` (main) + `#backgroundCanvas` (background cache)

```typescript
// src/core/worker/offscreen-canvas.ts:66-67
#backgroundCanvas!: OffscreenCanvas
#canvas!: OffscreenCanvas
```

**Reason**: Background (gradient) doesn't change per frame; separation avoids recalculating gradient stops every frame → just `drawImage` copy from cache.

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
