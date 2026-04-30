import type { GridItem } from './worker/protocol'

/**
 * 布局模式
 * Layout mode
 * - `grid`: 等高网格布局 | Equal-height grid layout
 * - `masonry`: 瀑布流布局 | Masonry (waterfall) layout
 */
export type LayoutMode = 'grid' | 'masonry'

/**
 * 网格项样式配置
 * Grid item style configuration
 */
export interface GridItemStyle {
  /**
   * 项目宽度（px）
   * Item width in pixels
   */
  width: number
  /**
   * 项目高度（px）
   * Item height in pixels
   */
  height: number
  /**
   * 圆角半径（px）
   * Border radius in pixels
   */
  radius?: number
  /**
   * 项目间距（px）
   * Gap between items in pixels
   */
  gap?: number
}

/**
 * 图片资源描述符，用于通过 URL 加载图片
 * Image resource descriptor for loading images via URL
 */
export interface ItemDescriptor {
  /**
   * 图片 URL 地址
   * Image URL address
   */
  url: string
  /**
   * 图片原始宽度（用于瀑布流布局计算宽高比）
   * Original image width (used for aspect ratio calculation in masonry layout)
   */
  width?: number
  /**
   * 图片原始高度（用于瀑布流布局计算宽高比）
   * Original image height (used for aspect ratio calculation in masonry layout)
   */
  height?: number
}

/**
 * 点击事件回调参数
 * Click event callback parameters
 */
export interface ClickEvent {
  /**
   * 被点击的网格项
   * The clicked grid item
   */
  item: GridItem
  /**
   * 项目在数据源中的索引
   * Item index in the data source
   */
  index: number
  /**
   * 项目所在行号
   * Row number of the item
   */
  row: number
  /**
   * 项目所在列号
   * Column number of the item
   */
  column: number
  /**
   * 原生鼠标事件对象
   * Native mouse event object
   */
  event: MouseEvent
}

/**
 * 渐变色标
 * Gradient color stop
 */
export interface ColorStop {
  /**
   * 色标位置（0-1）
   * Stop position (0-1)
   */
  offset: number
  /**
   * 色标颜色值
   * Stop color value
   */
  color: string
}

/**
 * 渐变背景配置
 * Gradient background configuration
 */
export interface GradientBackground {
  /**
   * 渐变类型
   * Gradient type
   */
  type: 'linear' | 'radial'
  /**
   * 渐变色标数组
   * Array of gradient color stops
   */
  stops: ColorStop[]
  /**
   * 线性渐变参数
   * Linear gradient parameters
   */
  linear?: {
    /** 起点坐标 [x, y] | Start point coordinates [x, y] */
    start: [number, number]
    /** 终点坐标 [x, y] | End point coordinates [x, y] */
    end: [number, number]
  }
  /**
   * 径向渐变参数
   * Radial gradient parameters
   */
  radial?: {
    /** 起始圆心坐标 [x, y] | Start circle center [x, y] */
    start: [number, number]
    /** 结束圆心坐标 [x, y] | End circle center [x, y] */
    end: [number, number]
    /** 起始圆半径 | Start circle radius */
    r0: number
    /** 结束圆半径 | End circle radius */
    r1: number
  }
}

/**
 * 自定义图片请求函数类型
 * Custom image fetcher function type
 * @param url - 图片 URL | Image URL
 * @param signal - AbortSignal 用于取消请求 | AbortSignal for request cancellation
 * @returns 返回 Blob（库自动转 ImageBitmap）或直接返回 ImageBitmap
 *          Returns Blob (auto-converted to ImageBitmap) or ImageBitmap directly
 */
export type ImageFetcher = (url: string, signal: AbortSignal) => Promise<Blob | ImageBitmap>

/**
 * 图片加载配置
 * Image loading configuration
 */
export interface ImageLoadConfig {
  /**
   * 并发加载数量
   * Concurrent loading count
   * @default 6
   */
  concurrency?: number
  /**
   * 最大重试次数
   * Maximum retry attempts
   * @default 3
   */
  maxRetries?: number
  /**
   * 重试基础延迟（ms），实际采用指数退避策略
   * Base retry delay in ms, uses exponential backoff
   * @default 500
   */
  retryDelay?: number
  /**
   * 单张图片加载超时时间（ms）
   * Single image load timeout in ms
   * @default 10000
   */
  timeout?: number
  /**
   * 自定义图片请求函数（可用于添加鉴权头、自定义代理等）
   * Custom image fetcher (for adding auth headers, custom proxy, etc.)
   */
  fetcher?: ImageFetcher
}

/**
 * 滚动配置
 * Scroll configuration
 */
export interface ScrollConfig {
  /**
   * 禁用滚动方向
   * Disabled scroll directions
   */
  disabled?: { horizontal?: boolean; vertical?: boolean }
  /**
   * 是否启用惯性滚动
   * Whether to enable inertia scrolling
   * @default true
   */
  inertia?: boolean
  /**
   * 视口裁剪缓冲区倍数（上下各扩展 N 倍视口高度）
   * Viewport culling buffer multiplier (extends N viewport heights above and below)
   * @default 1.0
   */
  buffer?: number
  /**
   * 触发 loadMore 的距离阈值（px）
   * Distance threshold to trigger loadMore (px)
   * @default 200
   */
  threshold?: number
  /**
   * 数据加载完毕后是否启用无缝循环滚动
   * Whether to enable seamless loop scrolling when all data is loaded
   * @default true
   */
  loop?: boolean
}

/**
 * 核心配置
 * Core configuration
 */
export interface Core {
  /**
   * Canvas DOM 元素
   * Canvas DOM element
   */
  canvas: HTMLCanvasElement
  /**
   * 背景颜色或渐变配置
   * Background color or gradient configuration
   */
  backgroundColor?: string | GradientBackground
  /**
   * 图片数据源（支持 ImageBitmap 数组、URL 字符串数组或 ItemDescriptor 数组）
   * Image data source (supports ImageBitmap[], string[] URLs, or ItemDescriptor[])
   */
  items?: ImageBitmap[] | string[] | ItemDescriptor[]
  /**
   * 网格项样式
   * Grid item style
   */
  style: GridItemStyle
  /**
   * 布局模式
   * Layout mode
   * @default 'grid'
   */
  layout?: LayoutMode
  /**
   * 并发限制数
   * Concurrency limit
   */
  limit?: number
  /**
   * 请求超时时间（ms）
   * Request timeout in ms
   */
  timeout?: number
}

/**
 * 交互配置
 * Interaction configuration
 */
export interface Interaction {
  /**
   * 点击事件回调
   * Click event callback
   */
  onClick?: (event: ClickEvent) => void
  /**
   * 滚动配置
   * Scroll configuration
   */
  scroll?: ScrollConfig
}

/**
 * 加载更多（无限滚动）配置
 * Load more (infinite scroll) configuration
 */
export interface LoadMoreConfig {
  /**
   * 每页加载数量
   * Number of items per page
   */
  pageSize: number
  /**
   * 加载更多数据的异步函数
   * Async function to load more data
   * @param page - 当前页码 | Current page number
   * @param pageSize - 每页数量 | Items per page
   */
  loadMore: (page: number, pageSize: number) => Promise<ImageBitmap[] | string[] | ItemDescriptor[]>
}

/**
 * 占位符渲染器接口
 * Placeholder renderer interface
 */
export interface PlaceholderRenderer {
  /**
   * 渲染占位符图像
   * Render placeholder image
   * @param width - 占位符宽度 | Placeholder width
   * @param height - 占位符高度 | Placeholder height
   * @param id - 唯一标识符 | Unique identifier
   */
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  /**
   * 释放所有资源
   * Dispose all resources
   */
  dispose: () => void
  /**
   * 移除指定占位符
   * Remove a specific placeholder
   * @param id - 要移除的占位符 ID | ID of the placeholder to remove
   */
  remove: (id: string) => void
}

/**
 * 布局计算输入
 * Layout calculation input
 */
export interface LayoutInput {
  /** 待布局的网格项 | Grid items to lay out */
  items: GridItem[]
  /** 容器宽度（CSS 像素）| Container width (CSS pixels) */
  containerWidth: number
  /** 容器高度（CSS 像素）| Container height (CSS pixels) */
  containerHeight: number
  /** 网格项样式配置 | Grid item style configuration */
  style: GridItemStyle
}

/**
 * 布局计算结果
 * Layout calculation result
 */
export interface LayoutResult {
  /** 已定位的网格项 | Positioned grid items */
  items: GridItem[]
  /** 内容总宽度 | Total content width */
  contentWidth: number
  /** 内容总高度 | Total content height */
  contentHeight: number
  /** 列数 | Number of columns */
  columns: number
}

/**
 * 布局策略接口
 * Layout strategy interface
 */
export interface LayoutStrategy {
  /** 计算布局 | Calculate layout */
  calculate: (input: LayoutInput) => LayoutResult
}
