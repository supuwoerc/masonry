# @supuwoerc/masonry — 项目架构总览与阅读指南

## 项目简介

`@supuwoerc/masonry` 是一个基于 **Canvas 2D + Web Worker + OffscreenCanvas** 的高性能图片网格/瀑布流布局库。它将所有渲染计算放在 Worker 线程中执行，主线程仅负责事件分发和资源加载，从而在处理大量图片时保持 60 FPS 的流畅体验。

### 核心特性

- **离屏渲染**：通过 `transferControlToOffscreen()` 将 Canvas 控制权转移到 Worker
- **双布局模式**：等高网格（Grid）与瀑布流（Masonry）可切换
- **惯性滚动**：带摩擦衰减的物理模型模拟自然滑动
- **视口裁剪**：仅渲染可见区域内的元素，支持万级数据
- **无缝循环**：数据加载完毕后可开启无限循环滚动
- **无限加载**：滚动到底部自动触发分页加载
- **占位动画**：图片加载中展示呼吸渐变或旋转加载动画
- **并发加载**：带重试和超时的图片并发加载器

---

## 技术栈

| 分类 | 技术 | 用途 |
|------|------|------|
| 渲染 | Canvas 2D API | 图片绘制、背景渲染 |
| 多线程 | Web Worker + OffscreenCanvas | 离屏渲染，不阻塞主线程 |
| 图片传输 | ImageBitmap + Transferable | 零拷贝跨线程图片传输 |
| 并发控制 | p-limit | 图片加载并发限制 |
| 重试机制 | @supuwoerc/toolkit (retry) | 指数退避重试 |
| 唯一 ID | nanoid | 消息和元素唯一标识 |
| 工具函数 | lodash-es | merge、get、类型判断 |
| 构建工具 | Vite + TypeScript | 开发/构建/类型声明 |
| 测试 | Vitest + Testing Library | 单元测试 |
| 代码质量 | ESLint + Prettier + Husky | 代码风格统一 |

---

## 目录结构

```
src/
├── index.ts                          # 入口文件，导出公开 API
├── core/
│   ├── builder.ts                    # MasonryBuilder 链式构建器
│   ├── masonry.ts                    # Masonry 主类（主线程编排器）
│   ├── types.ts                      # TypeScript 类型定义
│   ├── constant.ts                   # 默认配置常量
│   ├── error.ts                      # MasonryError 错误类
│   ├── image-loader.ts               # 图片加载器（并发/重试/超时）
│   ├── rules.ts                      # 配置验证规则
│   ├── layout/
│   │   ├── index.ts                  # 布局模块导出
│   │   ├── grid-layout.ts            # 等高网格布局策略
│   │   └── masonry-layout.ts         # 瀑布流布局策略
│   ├── placeholder/
│   │   ├── breathing-placeholder.ts  # 呼吸渐变占位符渲染器
│   │   └── spin-placeholder.ts       # 旋转加载占位符渲染器
│   └── worker/
│       ├── offscreen-canvas.ts       # Worker 渲染引擎（核心）
│       ├── protocol.ts               # 通信协议定义
│       └── constant.ts               # Worker 常量
├── helper/
│   ├── background.ts                 # 背景样式创建（纯色/渐变）
│   ├── validator.ts                  # 通用验证框架
│   └── stats-monitor.ts             # 性能监控（FPS/帧时间/内存）
├── utils/
│   ├── canvas.ts                     # 环境能力检测
│   └── is.ts                         # 增强类型检查
└── test/
    └── core/masonry.test.ts          # 单元测试
```

---

## 架构图

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
└──────────────────────────┬───────────────────────────────────┘
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

## 核心数据流

```
1. 初始化流程:
   Builder.build() → new Masonry(config) → #initWorker()
   → transferControlToOffscreen() → postMessage(Setup, [OffscreenCanvas])
   → Worker: handleSetup → performLayout → SetupResponse
   → Main: onReady + Render + loadImages

2. 滚动流程:
   wheel/pointer event → Main: sendMessage(Scroll, {deltaX, deltaY})
   → Worker: handleScroll → update scrollXY → tickInertia → handleRerender
   → Worker: checkLoadMore → (if threshold) → sendMessage(LoadMore)

3. 图片加载流程:
   Main: ImageLoader.loadBatch → fetch → createImageBitmap
   → sendMessage(ImageLoaded, {bitmap}, [bitmap])
   → Worker: handleImageLoaded → performLayout → handleRerender
   → Worker: sendMessage(RemoveLoading, id)
   → Main: placeholderRenderer.remove(id)

4. 无限滚动流程:
   Worker: checkLoadMore → sendMessage(LoadMore)
   → Main: loader.loadMore(page, pageSize) → 加载图片
   → sendMessage(LoadMoreResponse, {data: bitmaps})
   → Worker: handleLoadMoreResponse → performLayout → handleRerender
```

---

## 文档列表与阅读建议

建议按以下顺序阅读，从宏观到微观逐步深入：

| 序号 | 文档 | 内容概述 |
|------|------|---------|
| 01 | [整体架构与设计模式](./01-architecture-overview.zh-CN.md) | 双线程模型、设计模式、关键技术决策 |
| 02 | [Builder 构建器与配置验证](./02-builder-and-configuration.zh-CN.md) | 链式 API、类型系统、验证框架 |
| 03 | [主线程编排与事件协调](./03-main-thread-orchestration.zh-CN.md) | Masonry 类生命周期、消息路由、事件处理 |
| 04 | [Worker 通信协议](./04-worker-communication.zh-CN.md) | 消息结构、类型枚举、Transferable 传输 |
| 05 | [OffscreenCanvas 渲染引擎](./05-offscreen-rendering-engine.zh-CN.md) | 渲染循环、视口裁剪、惯性滚动、无缝循环 |
| 06 | [布局策略](./06-layout-strategies.zh-CN.md) | Grid/Masonry 算法、Strategy 模式 |
| 07 | [图片加载与占位符动画](./07-image-loading-and-placeholders.zh-CN.md) | 并发加载、重试策略、动画原理 |

---

## 术语表

| 术语 | 说明 |
|------|------|
| OffscreenCanvas | 可脱离 DOM 使用的 Canvas，支持在 Worker 中绑定渲染 |
| ImageBitmap | 预解码的位图对象，可通过 Transferable 零拷贝传输到 Worker |
| Transferable | postMessage 的传输对象，传输后原引用失效（转移所有权） |
| Viewport Culling | 视口裁剪，只渲染视口可见区域内的元素以提升性能 |
| Inertia Scrolling | 惯性滚动，释放触控后速度按摩擦系数逐帧衰减 |
| Strategy Pattern | 策略模式，通过统一接口切换不同的布局算法 |
| Builder Pattern | 构建者模式，通过链式调用逐步配置复杂对象 |
| DPR | Device Pixel Ratio，设备像素比，用于高清屏适配 |
| rAF | requestAnimationFrame，浏览器渲染帧回调 |

---

## 浏览器兼容性

| 浏览器 | 最低版本 | 关键依赖 |
|--------|---------|---------|
| Chrome | 69+ | OffscreenCanvas |
| Firefox | 105+ | OffscreenCanvas |
| Safari | 16.4+ | OffscreenCanvas |
| Edge | 79+ | OffscreenCanvas |

核心要求：Canvas 2D API + Web Worker + OffscreenCanvas + ImageBitmap + ResizeObserver
