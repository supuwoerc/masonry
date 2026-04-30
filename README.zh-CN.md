# @supuwoerc/masonry

基于 Canvas + Web Worker + OffscreenCanvas 的高性能图片网格/瀑布流布局库。

所有布局计算和渲染在 Worker 线程中完成，主线程零阻塞。支持无限滚动、惯性滚动、无缝循环、视口裁剪、点击交互和自适应缩放。

[English](./README.md)

## 特性

- **Web Worker 渲染** — 布局计算和 Canvas 绑定均在 Worker 中执行，主线程仅负责事件代理
- **双布局模式** — 等高网格 (Grid) 和瀑布流 (Masonry)
- **惯性滚动** — 带摩擦系数衰减的物理滚动模拟
- **无缝循环** — 数据加载完毕后自动启用无限循环滚动
- **视口裁剪** — 仅渲染可见区域及缓冲区内的元素，支持百万级数据量
- **图片加载器** — 并发控制、超时、指数退避重试、自定义 fetcher
- **占位符动画** — 内置呼吸渐变和旋转圆点两种加载动画
- **点击交互** — Worker 端命中检测，精准返回被点击元素的行列索引
- **自适应缩放** — 监听 DPR 变化和容器尺寸变化自动重新渲染

## 安装

```bash
npm install @supuwoerc/masonry
# 或
pnpm add @supuwoerc/masonry
```

## 快速开始

### 基础用法（传入 ImageBitmap）

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
    onReady: (instance) => console.log('就绪', instance),
  })
  .build()
```

### URL 加载模式

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

### 带尺寸信息的 URL 加载（瀑布流推荐）

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

### 无限滚动

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

### 自定义图片请求（鉴权 / 代理）

```ts
new MasonryBuilder()
  .withCore({
    canvas,
    style: { width: 200, height: 300, gap: 10 },
    items: urls,
  })
  .withInteraction({
    scroll: { inertia: true, loop: true, buffer: 1.5 },
  })
  .withEvents({
    onReady: (ins) => console.log('ready'),
    onError: (err) => console.error(err),
  })
  .build()
```

ImageLoadConfig 自定义 fetcher：

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

### 点击交互

```ts
new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 }, items: bitmaps })
  .withInteraction({
    onClick: ({ item, index, row, column, event }) => {
      console.log(`点击了第 ${index} 个元素，位于第 ${row} 行第 ${column} 列`)
    },
  })
  .build()
```

### 占位符动画

```ts
import { BreathingPlaceholderRenderer, SpinPlaceholderRenderer } from '@supuwoerc/masonry'

// 呼吸渐变
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

// 旋转圆点
new MasonryBuilder()
  .withCore({ canvas, style: { width: 200, height: 300 }, items: urls })
  .withPlaceholder(
    new SpinPlaceholderRenderer({
      backgroundColor: '#f2f2f2',
    }),
  )
  .build()
```

### 性能监控

```ts
import { StatsMonitor } from '@supuwoerc/masonry'

const monitor = new StatsMonitor('fps') // 'fps' | 'ms' | 'mb'
// 双击切换显示/隐藏
document.addEventListener('dblclick', () => monitor.toggle())
```

## API 参考

### MasonryBuilder

链式构建器，推荐使用方式。

| 方法 | 参数 | 说明 |
|------|------|------|
| `withCore(config)` | `Core` | 设置核心配置（canvas、样式、数据源等） |
| `withInteraction(config)` | `Interaction` | 设置交互配置（点击、滚动、布局更新回调） |
| `withLoader(config)` | `LoadMoreConfig` | 设置无限滚动加载器 |
| `withPlaceholder(renderer)` | `PlaceholderRenderer` | 设置占位符渲染器 |
| `withEvents(config)` | `{ onReady?, onError? }` | 设置事件回调 |
| `build()` | — | 构建并返回 Masonry 实例 |

### Masonry

直接实例化方式：

```ts
const masonry = new Masonry(config: MasonryConfiguration)
masonry.destroy() // 销毁实例，释放所有资源
```

## 配置说明

### Core — 核心配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `canvas` | `HTMLCanvasElement` | ✓ | — | Canvas DOM 元素 |
| `style` | `GridItemStyle` | ✓ | — | 网格项样式配置 |
| `items` | `ImageBitmap[] \| string[] \| ItemDescriptor[]` | | — | 图片数据源 |
| `backgroundColor` | `string \| GradientBackground` | | `'#fff'` | 背景颜色或渐变 |
| `layout` | `'grid' \| 'masonry'` | | `'grid'` | 布局模式 |
| `limit` | `number` | | — | 并发限制数 |
| `timeout` | `number` | | — | 请求超时（ms） |

### GridItemStyle — 网格项样式

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `width` | `number` | ✓ | — | 项目宽度（px） |
| `height` | `number` | ✓ | — | 项目高度（px） |
| `gap` | `number` | | `0` | 项目间距（px） |
| `radius` | `number` | | `0` | 圆角半径（px） |

### ItemDescriptor — 图片资源描述符

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `url` | `string` | ✓ | — | 图片 URL |
| `width` | `number` | | — | 图片原始宽度（瀑布流布局使用） |
| `height` | `number` | | — | 图片原始高度（瀑布流布局使用） |

### Interaction — 交互配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `onClick` | `(event: ClickEvent) => void` | | — | 点击事件回调 |
| `onLayoutUpdate` | `(event: LayoutUpdateEvent) => void` | | — | 布局更新回调 |
| `scroll` | `ScrollConfig` | | — | 滚动配置 |

### ClickEvent — 点击事件参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `item` | `GridItem` | 被点击的网格项 |
| `index` | `number` | 在数据源中的索引 |
| `row` | `number` | 所在行号 |
| `column` | `number` | 所在列号 |
| `event` | `MouseEvent` | 原生事件对象 |

### LayoutUpdateEvent — 布局更新事件参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `contentWidth` | `number` | 内容总宽度（px） |
| `contentHeight` | `number` | 内容总高度（px） |

### ScrollConfig — 滚动配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `disabled` | `{ horizontal?: boolean; vertical?: boolean }` | | `{ horizontal: false, vertical: false }` | 禁用滚动方向 |
| `inertia` | `boolean` | | `true` | 是否启用惯性滚动 |
| `buffer` | `number` | | `1.0` | 视口裁剪缓冲区倍数（上下各扩展 N 倍视口尺寸） |
| `threshold` | `number` | | `200` | 触发 loadMore 的距离阈值（px） |
| `loop` | `boolean` | | `true` | 数据加载完毕后是否启用无缝循环滚动 |

### LoadMoreConfig — 无限滚动配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `pageSize` | `number` | ✓ | — | 每页加载数量 |
| `loadMore` | `(page: number, pageSize: number) => Promise<...>` | ✓ | — | 加载更多数据的异步函数 |

### ImageLoadConfig — 图片加载配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:----:|--------|------|
| `concurrency` | `number` | | `6` | 并发加载数 |
| `maxRetries` | `number` | | `3` | 最大重试次数 |
| `retryDelay` | `number` | | `500` | 重试基础延迟（ms），使用指数退避 |
| `timeout` | `number` | | `10000` | 单张图片超时时间（ms） |
| `fetcher` | `ImageFetcher` | | 内置 fetch | 自定义请求函数 |

### GradientBackground — 渐变背景配置

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `type` | `'linear' \| 'radial'` | ✓ | 渐变类型 |
| `stops` | `ColorStop[]` | ✓ | 色标数组 `{ offset: number; color: string }` |
| `linear` | `{ start: [x, y]; end: [x, y] }` | | 线性渐变参数 |
| `radial` | `{ start: [x, y]; end: [x, y]; r0: number; r1: number }` | | 径向渐变参数 |

### PlaceholderRenderer — 占位符渲染器接口

| 方法 | 签名 | 说明 |
|------|------|------|
| `render` | `(width, height, id) => ImageBitmap \| Promise<ImageBitmap>` | 渲染一帧占位符 |
| `remove` | `(id: string) => void` | 移除指定占位符 |
| `dispose` | `() => void` | 释放所有资源 |

内置实现：

- **BreathingPlaceholderRenderer** — 呼吸渐变动画
  - `backgroundColor`: 底色，默认 `'#e0e0e0'`
  - `highlightColor`: 叠加色，默认 `'rgba(255, 255, 255, 0.6)'`
  - `duration`: 周期（ms），默认 `1500`
  - `radius`: 圆角（px），默认 `0`

- **SpinPlaceholderRenderer** — 旋转圆点动画
  - `backgroundColor`: 底色，默认 `'#f2f2f2'`

### StatsMonitor — 性能监控

```ts
new StatsMonitor(panel?: 'fps' | 'ms' | 'mb' | 'custom', dom?: HTMLElement, start?: boolean)
```

| 方法 | 说明 |
|------|------|
| `start()` | 开始监控 |
| `stop()` | 停止监控 |
| `enable()` | 显示面板 |
| `disable()` | 隐藏面板 |
| `toggle()` | 切换显示/隐藏 |
| `customizeStyle(style)` | 自定义面板 DOM 样式 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        主线程 (Main Thread)                    │
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
│  │              Worker 消息通道 (postMessage)                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                    transferControlToOffscreen
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Worker 线程 (Web Worker)                  │
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

### 消息流

```
初始化:
  Main → Worker: Setup (OffscreenCanvas + config)
  Worker → Main: SetupResponse
  Main → Worker: Render

图片加载:
  Main → Worker: ImageLoaded (index + ImageBitmap)
  Worker → Main: RenderLoading (需要占位符的 ID 列表)
  Main → Worker: RenderLoadingResponse (占位符 ImageBitmap)
  Worker → Main: RemoveLoading (加载完成，移除占位符)

滚动:
  Main → Worker: Scroll (deltaX, deltaY)
  Worker 内部: 惯性计算 → 视口裁剪 → 重绘

无限滚动:
  Worker → Main: LoadMore (滚动到阈值)
  Main → Worker: LoadMoreResponse (新数据)

点击:
  Main → Worker: Click (x, y)
  Worker → Main: ClickResult (item, index, row, column)

容器变化:
  Main → Worker: Resize (clientWidth, clientHeight, dpr)

布局变化:
  Worker → Main: LayoutUpdated (contentWidth, contentHeight)
```

### 渲染流程

1. **初始化** — 主线程将 Canvas 控制权通过 `transferControlToOffscreen()` 转交给 Worker
2. **布局计算** — Worker 根据配置的布局策略（Grid/Masonry）计算每个 item 的位置
3. **视口裁剪** — 每帧仅绘制当前视口 + 缓冲区范围内的元素
4. **循环滚动** — 数据加载完毕后，使用 1D 模运算将无限坐标映射到有限数据集
5. **惯性滚动** — 释放指针后，速度以摩擦系数（0.95）逐帧衰减直至停止
6. **动画循环** — 按需启动/停止 `requestAnimationFrame`，无动画时零 CPU 消耗

## 浏览器兼容性

| 特性 | 要求 |
|------|------|
| Canvas 2D | ✓ 必需 |
| Web Worker | ✓ 必需 |
| OffscreenCanvas | ✓ 必需 |
| ImageBitmap | ✓ 必需 |
| ResizeObserver | ✓ 必需 |

支持所有现代浏览器（Chrome 69+、Firefox 105+、Safari 16.4+、Edge 79+）。

## License

MIT
