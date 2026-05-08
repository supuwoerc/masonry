# @supuwoerc/masonry — Project Architecture Overview & Reading Guide

## Introduction

`@supuwoerc/masonry` is a high-performance image grid/masonry layout library built on **Canvas 2D + Web Worker + OffscreenCanvas**. All rendering computations are executed in a Worker thread, while the main thread only handles event dispatching and resource loading, ensuring a smooth 60 FPS experience even with large image sets.

### Core Features

- **Offscreen Rendering**: Transfers Canvas control to Worker via `transferControlToOffscreen()`
- **Dual Layout Modes**: Switchable between equal-height grid and waterfall masonry
- **Inertia Scrolling**: Physics-based model with friction decay simulating natural scrolling
- **Viewport Culling**: Only renders elements within the visible area, supports 10,000+ items
- **Seamless Loop**: Infinite loop scrolling after all data is loaded
- **Infinite Loading**: Auto-triggers pagination when scrolling near the bottom
- **Placeholder Animation**: Breathing gradient or spinning dots animation during image loading
- **Concurrent Loading**: Image loader with retry and timeout support

---

## Tech Stack

| Category | Technology | Purpose |
|----------|-----------|---------|
| Rendering | Canvas 2D API | Image drawing, background rendering |
| Multi-threading | Web Worker + OffscreenCanvas | Off-main-thread rendering |
| Image Transfer | ImageBitmap + Transferable | Zero-copy cross-thread image transfer |
| Concurrency | p-limit | Image loading concurrency control |
| Retry | @supuwoerc/toolkit (retry) | Exponential backoff retry |
| Unique IDs | nanoid | Message and element identification |
| Utilities | lodash-es | merge, get, type checking |
| Build Tool | Vite + TypeScript | Development/build/type declarations |
| Testing | Vitest + Testing Library | Unit testing |
| Code Quality | ESLint + Prettier + Husky | Consistent code style |

---

## Directory Structure

```
src/
├── index.ts                          # Entry file, exports public API
├── core/
│   ├── builder.ts                    # MasonryBuilder fluent API
│   ├── masonry.ts                    # Masonry main class (main-thread orchestrator)
│   ├── types.ts                      # TypeScript type definitions
│   ├── constant.ts                   # Default configuration constants
│   ├── error.ts                      # MasonryError error class
│   ├── image-loader.ts               # Image loader (concurrency/retry/timeout)
│   ├── rules.ts                      # Configuration validation rules
│   ├── layout/
│   │   ├── index.ts                  # Layout module exports
│   │   ├── grid-layout.ts            # Equal-height grid layout strategy
│   │   └── masonry-layout.ts         # Masonry (waterfall) layout strategy
│   ├── placeholder/
│   │   ├── breathing-placeholder.ts  # Breathing gradient placeholder renderer
│   │   └── spin-placeholder.ts       # Spinning loader placeholder renderer
│   └── worker/
│       ├── offscreen-canvas.ts       # Worker rendering engine (core)
│       ├── protocol.ts               # Communication protocol definitions
│       └── constant.ts               # Worker constants
├── helper/
│   ├── background.ts                 # Background style creation (solid/gradient)
│   ├── validator.ts                  # Generic validation framework
│   └── stats-monitor.ts             # Performance monitoring (FPS/frame time/memory)
├── utils/
│   ├── canvas.ts                     # Environment capability detection
│   └── is.ts                         # Enhanced type checking
└── test/
    └── core/masonry.test.ts          # Unit tests
```

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Main Thread                            │
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌────────────────┐   │
│  │MasonryBuilder│───→│   Masonry   │───→│  ImageLoader   │   │
│  └─────────────┘    └──────┬──────┘    └────────────────┘   │
│                            │                                  │
│              ┌─────────────┼─────────────┐                   │
│              │             │             │                    │
│      ┌───────▼──┐  ┌──────▼─────┐  ┌───▼──────────────┐    │
│      │  Resize  │  │   Scroll   │  │  Placeholder     │    │
│      │ Observer │  │  Listeners │  │  Renderer        │    │
│      └──────────┘  └────────────┘  └──────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                           │ postMessage (Transferable)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                       Worker Thread                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            OffscreenCanvasWorker                       │   │
│  │                                                       │   │
│  │  ┌────────────┐  ┌──────────┐  ┌─────────────────┐  │   │
│  │  │  Layout    │  │ Viewport │  │  Inertia        │  │   │
│  │  │  Strategy  │  │ Culling  │  │  Scrolling      │  │   │
│  │  └────────────┘  └──────────┘  └─────────────────┘  │   │
│  │                                                       │   │
│  │  ┌────────────┐  ┌──────────┐  ┌─────────────────┐  │   │
│  │  │ Background │  │  Hit     │  │  Animation      │  │   │
│  │  │ Rendering  │  │ Detection│  │  Loop (rAF)     │  │   │
│  │  └────────────┘  └──────────┘  └─────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## Core Data Flow

```
1. Initialization Flow:
   Builder.build() → new Masonry(config) → #initWorker()
   → transferControlToOffscreen() → postMessage(Setup, [OffscreenCanvas])
   → Worker: handleSetup → performLayout → SetupResponse
   → Main: onReady + Render + loadImages

2. Scroll Flow:
   wheel/pointer event → Main: sendMessage(Scroll, {deltaX, deltaY})
   → Worker: handleScroll → update scrollXY → tickInertia → handleRerender
   → Worker: checkLoadMore → (if threshold) → sendMessage(LoadMore)

3. Image Loading Flow:
   Main: ImageLoader.loadBatch → fetch → createImageBitmap
   → sendMessage(ImageLoaded, {bitmap}, [bitmap])
   → Worker: handleImageLoaded → performLayout → handleRerender
   → Worker: sendMessage(RemoveLoading, id)
   → Main: placeholderRenderer.remove(id)

4. Infinite Scroll Flow:
   Worker: checkLoadMore → sendMessage(LoadMore)
   → Main: loader.loadMore(page, pageSize) → load images
   → sendMessage(LoadMoreResponse, {data: bitmaps})
   → Worker: handleLoadMoreResponse → performLayout → handleRerender
```

---

## Document List & Reading Order

Recommended reading order, from macro to micro:

| # | Document | Summary |
|---|----------|---------|
| 01 | [Architecture & Design Patterns](./01-architecture-overview.md) | Dual-thread model, design patterns, key technical decisions |
| 02 | [Builder & Configuration](./02-builder-and-configuration.md) | Fluent API, type system, validation framework |
| 03 | [Main Thread Orchestration](./03-main-thread-orchestration.md) | Masonry class lifecycle, message routing, event handling |
| 04 | [Worker Communication Protocol](./04-worker-communication.md) | Message structure, type enum, Transferable transfer |
| 05 | [OffscreenCanvas Rendering Engine](./05-offscreen-rendering-engine.md) | Render loop, viewport culling, inertia scrolling, seamless loop |
| 06 | [Layout Strategies](./06-layout-strategies.md) | Grid/Masonry algorithms, Strategy pattern |
| 07 | [Image Loading & Placeholders](./07-image-loading-and-placeholders.md) | Concurrent loading, retry strategy, animation principles |

---

## Glossary

| Term | Description |
|------|-------------|
| OffscreenCanvas | Canvas detached from DOM, can be rendered in a Worker |
| ImageBitmap | Pre-decoded bitmap object, zero-copy transferable to Worker |
| Transferable | postMessage transfer object, original reference invalidated after transfer (ownership transfer) |
| Viewport Culling | Only rendering elements within the visible viewport area for performance |
| Inertia Scrolling | After touch release, velocity decays per frame by friction coefficient |
| Strategy Pattern | Swap different layout algorithms via a unified interface |
| Builder Pattern | Incrementally configure complex objects through chained method calls |
| DPR | Device Pixel Ratio, used for HiDPI display adaptation |
| rAF | requestAnimationFrame, browser render frame callback |

---

## Browser Compatibility

| Browser | Min Version | Key Dependency |
|---------|-------------|---------------|
| Chrome | 69+ | OffscreenCanvas |
| Firefox | 105+ | OffscreenCanvas |
| Safari | 16.4+ | OffscreenCanvas |
| Edge | 79+ | OffscreenCanvas |

Core requirements: Canvas 2D API + Web Worker + OffscreenCanvas + ImageBitmap + ResizeObserver
