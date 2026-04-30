# @supuwoerc/masonry

High-performance image grid/masonry layout library powered by Canvas + Web Worker + OffscreenCanvas.

All layout calculations and rendering run in a Worker thread — zero main-thread blocking. Supports infinite scrolling, inertia scrolling, seamless loop, viewport culling, click interaction, and adaptive DPR scaling.

[中文文档](./README.zh-CN.md)

## Features

- **Web Worker rendering** — Layout and Canvas bindings execute in a Worker; the main thread only proxies events
- **Dual layout modes** — Equal-height grid and masonry (waterfall) layout
- **Inertia scrolling** — Physics-based scrolling with friction decay
- **Seamless loop** — Automatic infinite loop scrolling once all data is loaded
- **Viewport culling** — Only renders elements within the visible area + configurable buffer
- **Image loader** — Concurrency control, timeout, exponential backoff retry, custom fetcher
- **Placeholder animation** — Built-in breathing gradient and spinning dots loaders
- **Click interaction** — Worker-side hit detection, returns precise row/column index
- **Adaptive scaling** — Listens for DPR changes and container resize, auto re-renders

## Installation

```bash
npm install @supuwoerc/masonry
# or
pnpm add @supuwoerc/masonry
```

## Quick Start

### Basic Usage (ImageBitmap)

```ts
import { MasonryBuilder } from '@supuwoerc/masonry'

const canvas = document.getElementById('canvas') as HTMLCanvasElement

new MasonryBuilder()
  .withCore({
    canvas,
    style: { width: 200, height: 300, gap: 10, radius: 8 },
    items: bitmaps, // ImageBitmap[]
    backgroundColor: '#f5f5f5',
  })
  .withEvents({
    onReady: (instance) => console.log('Ready', instance),
  })
  .build()
```

### URL Loading

```ts
new MasonryBuilder()
  .withCore({
    canvas,
    style: { width: 200, height: 300, gap: 10, radius: 8 },
    items: [
      'https://example.com/image1.jpg',
      'https://example.com/image2.jpg',
    ],
  })
  .build()
```

### URL Loading with Dimensions (Recommended for Masonry)

```ts
new MasonryBuilder()
  .withCore({
    canvas,
    style: { width: 200, height: 300, gap: 10 },
    layout: 'masonry',
    items: [
      { url: 'https://example.com/1.jpg', width: 800, height: 1200 },
      { url: 'https://example.com/2.jpg', width: 600, height: 400 },
    ],
  })
  .build()
```

### Infinite Scrolling

```ts
new MasonryBuilder()
  .withCore({
    canvas,
    style: { width: 200, height: 300, gap: 10, radius: 8 },
  })
  .withLoader({
    pageSize: 20,
    loadMore: async (page, pageSize) => {
      const res = await fetch(`/api/images?page=${page}&size=${pageSize}`)
      const data = await res.json()
      return data.list // string[] | ItemDescriptor[] | ImageBitmap[]
    },
  })
  .build()
```

### Custom Image Fetcher (Auth / Proxy)

```ts
const masonry = new Masonry({
  core: { canvas, style: { width: 200, height: 300 }, items: urls },
  imageLoad: {
    concurrency: 4,
    timeout: 8000,
    maxRetries: 2,
    fetcher: async (url, signal) => {
      const res = await fetch(url, {
        signal,
        headers: { Authorization: 'Bearer token' },
      })
      return await res.blob()
    },
  },
})
```

### Click Interaction

```ts
new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 }, items: bitmaps })
  .withInteraction({
    onClick: ({ item, index, row, column, event }) => {
      console.log(`Clicked item ${index} at row ${row}, column ${column}`)
    },
  })
  .build()
```

### Placeholder Animations

```ts
import { BreathingPlaceholderRenderer, SpinPlaceholderRenderer } from '@supuwoerc/masonry'

// Breathing gradient
new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 }, items: urls })
  .withPlaceholder(
    new BreathingPlaceholderRenderer({
      backgroundColor: '#e0e0e0',
      highlightColor: 'rgba(255, 255, 255, 0.6)',
      duration: 1500,
      radius: 8,
    }),
  )
  .build()

// Spinning dots
new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 }, items: urls })
  .withPlaceholder(
    new SpinPlaceholderRenderer({
      backgroundColor: '#f2f2f2',
    }),
  )
  .build()
```

### Performance Monitoring

```ts
import { StatsMonitor } from '@supuwoerc/masonry'

const monitor = new StatsMonitor('fps') // 'fps' | 'ms' | 'mb'
// Double-click to toggle visibility
document.addEventListener('dblclick', () => monitor.toggle())
```

## API Reference

### MasonryBuilder

Fluent builder — the recommended way to create instances.

| Method | Parameter | Description |
|--------|-----------|-------------|
| `withCore(config)` | `Core` | Set core configuration (canvas, style, data source, etc.) |
| `withInteraction(config)` | `Interaction` | Set interaction configuration (click, scroll, layout callback) |
| `withLoader(config)` | `LoadMoreConfig` | Set infinite scroll loader |
| `withPlaceholder(renderer)` | `PlaceholderRenderer` | Set placeholder renderer |
| `withEvents(config)` | `{ onReady?, onError? }` | Set event callbacks |
| `build()` | — | Build and return a Masonry instance |

### Masonry

Direct instantiation:

```ts
const masonry = new Masonry(config: MasonryConfiguration)
masonry.destroy() // Destroy instance and release all resources
```

## Configuration

### Core

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `canvas` | `HTMLCanvasElement` | ✓ | — | Canvas DOM element |
| `style` | `GridItemStyle` | ✓ | — | Grid item style configuration |
| `items` | `ImageBitmap[] \| string[] \| ItemDescriptor[]` | | — | Image data source |
| `backgroundColor` | `string \| GradientBackground` | | `'#fff'` | Background color or gradient |
| `layout` | `'grid' \| 'masonry'` | | `'grid'` | Layout mode |
| `limit` | `number` | | — | Concurrency limit |
| `timeout` | `number` | | — | Request timeout (ms) |

### GridItemStyle

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `width` | `number` | ✓ | — | Item width (px) |
| `height` | `number` | ✓ | — | Item height (px) |
| `gap` | `number` | | `0` | Gap between items (px) |
| `radius` | `number` | | `0` | Border radius (px) |

### ItemDescriptor

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `url` | `string` | ✓ | — | Image URL |
| `width` | `number` | | — | Original image width (used in masonry layout) |
| `height` | `number` | | — | Original image height (used in masonry layout) |

### Interaction

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `onClick` | `(event: ClickEvent) => void` | | — | Click event callback |
| `onLayoutUpdate` | `(event: LayoutUpdateEvent) => void` | | — | Layout update callback |
| `scroll` | `ScrollConfig` | | — | Scroll configuration |

### ClickEvent

| Parameter | Type | Description |
|-----------|------|-------------|
| `item` | `GridItem` | The clicked grid item |
| `index` | `number` | Index in the data source |
| `row` | `number` | Row number |
| `column` | `number` | Column number |
| `event` | `MouseEvent` | Native event object |

### LayoutUpdateEvent

| Parameter | Type | Description |
|-----------|------|-------------|
| `contentWidth` | `number` | Total content width (px) |
| `contentHeight` | `number` | Total content height (px) |

### ScrollConfig

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `disabled` | `{ horizontal?: boolean; vertical?: boolean }` | | `{ horizontal: false, vertical: false }` | Disabled scroll directions |
| `inertia` | `boolean` | | `true` | Enable inertia scrolling |
| `buffer` | `number` | | `1.0` | Viewport culling buffer multiplier (extends N viewport sizes above/below) |
| `threshold` | `number` | | `200` | Distance threshold to trigger loadMore (px) |
| `loop` | `boolean` | | `true` | Enable seamless loop scrolling when all data is loaded |

### LoadMoreConfig

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `pageSize` | `number` | ✓ | — | Items per page |
| `loadMore` | `(page: number, pageSize: number) => Promise<...>` | ✓ | — | Async function to load more data |

### ImageLoadConfig

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `concurrency` | `number` | | `6` | Concurrent load count |
| `maxRetries` | `number` | | `3` | Maximum retry attempts |
| `retryDelay` | `number` | | `500` | Base retry delay (ms), uses exponential backoff |
| `timeout` | `number` | | `10000` | Single image timeout (ms) |
| `fetcher` | `ImageFetcher` | | built-in fetch | Custom request function |

### GradientBackground

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `type` | `'linear' \| 'radial'` | ✓ | Gradient type |
| `stops` | `ColorStop[]` | ✓ | Color stop array `{ offset: number; color: string }` |
| `linear` | `{ start: [x, y]; end: [x, y] }` | | Linear gradient parameters |
| `radial` | `{ start: [x, y]; end: [x, y]; r0: number; r1: number }` | | Radial gradient parameters |

### PlaceholderRenderer Interface

| Method | Signature | Description |
|--------|-----------|-------------|
| `render` | `(width, height, id) => ImageBitmap \| Promise<ImageBitmap>` | Render one frame |
| `remove` | `(id: string) => void` | Remove specific placeholder |
| `dispose` | `() => void` | Release all resources |

Built-in implementations:

- **BreathingPlaceholderRenderer** — Breathing gradient animation
  - `backgroundColor`: Base color, default `'#e0e0e0'`
  - `highlightColor`: Overlay color, default `'rgba(255, 255, 255, 0.6)'`
  - `duration`: Cycle duration (ms), default `1500`
  - `radius`: Border radius (px), default `0`

- **SpinPlaceholderRenderer** — Spinning dots animation
  - `backgroundColor`: Base color, default `'#f2f2f2'`

### StatsMonitor

```ts
new StatsMonitor(panel?: 'fps' | 'ms' | 'mb' | 'custom', dom?: HTMLElement, start?: boolean)
```

| Method | Description |
|--------|-------------|
| `start()` | Start monitoring |
| `stop()` | Stop monitoring |
| `enable()` | Show panel |
| `disable()` | Hide panel |
| `toggle()` | Toggle visibility |
| `customizeStyle(style)` | Customize panel DOM style |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Thread                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  Masonry   │   │ ImageLoader  │   │ PlaceholderRenderer│  │
│  │  /Builder  │   │              │   │                   │  │
│  └─────┬─────┘   └──────┬───────┘   └─────────┬─────────┘  │
│        │                 │                     │             │
│        │    postMessage   │   ImageBitmap       │  ImageBitmap│
│        ▼                 ▼                     ▼             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │            Worker Message Channel (postMessage)          │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                    transferControlToOffscreen
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Worker Thread (Web Worker)              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │LayoutStrategy│  │ ScrollState  │  │ OffscreenCanvas │   │
│  │ Grid/Masonry │  │ + Inertia    │  │   Rendering     │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ViewportCulling│  │  HitTest     │  │  Loop Scroll    │   │
│  │  + Buffer    │  │  Detection   │  │  (1D Modulo)    │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Message Flow

```
Initialization:
  Main → Worker: Setup (OffscreenCanvas + config)
  Worker → Main: SetupResponse
  Main → Worker: Render

Image Loading:
  Main → Worker: ImageLoaded (index + ImageBitmap)
  Worker → Main: RenderLoading (placeholder ID list)
  Main → Worker: RenderLoadingResponse (placeholder ImageBitmap)
  Worker → Main: RemoveLoading (loaded, remove placeholder)

Scrolling:
  Main → Worker: Scroll (deltaX, deltaY)
  Worker internal: inertia calculation → viewport culling → repaint

Infinite Scroll:
  Worker → Main: LoadMore (scrolled to threshold)
  Main → Worker: LoadMoreResponse (new data)

Click:
  Main → Worker: Click (x, y)
  Worker → Main: ClickResult (item, index, row, column)

Container Changes:
  Main → Worker: Resize (clientWidth, clientHeight, dpr)

Layout Changes:
  Worker → Main: LayoutUpdated (contentWidth, contentHeight)
```

### Rendering Pipeline

1. **Initialization** — Main thread transfers Canvas control to Worker via `transferControlToOffscreen()`
2. **Layout Calculation** — Worker computes each item's position using the configured strategy (Grid/Masonry)
3. **Viewport Culling** — Each frame only draws items within the current viewport + buffer zone
4. **Loop Scrolling** — Once all data is loaded, 1D modulo arithmetic maps infinite coordinates to the finite dataset
5. **Inertia Scrolling** — After pointer release, velocity decays per-frame with friction (0.95) until stop
6. **Animation Loop** — Starts/stops `requestAnimationFrame` on demand; zero CPU when idle

## Browser Compatibility

| Feature | Requirement |
|---------|-------------|
| Canvas 2D | ✓ Required |
| Web Worker | ✓ Required |
| OffscreenCanvas | ✓ Required |
| ImageBitmap | ✓ Required |
| ResizeObserver | ✓ Required |

Supports all modern browsers (Chrome 69+, Firefox 105+, Safari 16.4+, Edge 79+).

## License

MIT
