import type { WorkerConfiguration } from './offscreen-canvas'

/**
 * 网格项数据结构
 * Grid item data structure
 */
export interface GridItem {
  /** 唯一标识符 | Unique identifier */
  id: string
  /** 图片位图数据 | Image bitmap data */
  image: ImageBitmap | null
  /** 加载状态 | Loading status */
  status: 'loading' | 'loaded'
  /** X 坐标（布局位置）| X coordinate (layout position) */
  x: number
  /** Y 坐标（布局位置）| Y coordinate (layout position) */
  y: number
  /** 渲染宽度 | Rendered width */
  width?: number
  /** 渲染高度 | Rendered height */
  height?: number
  /** 在数据源中的索引 | Index in data source */
  itemIndex: number
}

/**
 * Worker 通信消息类型枚举
 * Worker communication message type enum
 */
export enum MessageType {
  /** 初始化设置 | Initialize setup */
  Setup,
  /** 初始化完成响应 | Setup complete response */
  SetupResponse,
  /** 请求加载更多数据 | Request to load more data */
  LoadMore,
  /** 加载更多数据响应 | Load more data response */
  LoadMoreResponse,
  /** 触发渲染 | Trigger render */
  Render,
  /** 请求渲染加载占位符 | Request to render loading placeholder */
  RenderLoading,
  /** 占位符渲染完成响应 | Placeholder render complete response */
  RenderLoadingResponse,
  /** 容器尺寸变化 | Container resize */
  Resize,
  /** 移除加载占位符 | Remove loading placeholder */
  RemoveLoading,
  /** 错误消息 | Error message */
  Error,
  /** 滚动偏移更新（主线程→Worker）| Scroll offset update (main→worker) */
  Scroll,
  /** 布局更新通知（Worker→主线程）| Layout update notification (worker→main) */
  LayoutUpdated,
  /** 图片加载完成（主线程→Worker）| Image loaded (main→worker) */
  ImageLoaded,
  /** 命中测试请求（主线程→Worker）| Hit test request (main→worker) */
  HitTest,
  /** 命中测试结果响应（Worker→主线程）| Hit test result response (worker→main) */
  HitTestResponse,
}

/**
 * 主线程发送给 Worker 的请求负载联合类型
 * Request payload union type sent from main thread to worker
 */
export type RequestPayload =
  | SetupPayload
  | ResizePayload
  | ScrollPayload
  | ImageLoadedPayload
  | HitTestPayload
  | Array<string>
  | string

/**
 * Worker 返回给主线程的响应负载联合类型
 * Response payload union type returned from worker to main thread
 */
export type ResponsePayload =
  | RenderLoadingResponsePayload
  | LayoutUpdatedPayload
  | HitTestResponsePayload
  | LoadMoreResponsePayload
  | Error
  | null

/**
 * 消息负载联合类型
 * Message payload union type
 */
export type MessagePayload = RequestPayload | ResponsePayload

/**
 * Worker 通信消息结构
 * Worker communication message structure
 * @template T - 负载类型 | Payload type
 */
export interface Message<T = MessagePayload> {
  /** 消息唯一 ID | Message unique ID */
  id: string
  /** 来源消息 ID（用于请求-响应配对）| Source message ID (for request-response pairing) */
  from?: string
  /** 消息类型 | Message type */
  type: MessageType
  /** 消息负载 | Message payload */
  payload: T
  /** 时间戳 | Timestamp */
  timestamp: number
}

/**
 * Worker 初始化负载
 * Worker setup payload
 */
export interface SetupPayload {
  /** 离屏画布（通过 Transferable 传输）| OffscreenCanvas (transferred via Transferable) */
  offscreenCanvas: OffscreenCanvas
  /** 容器 CSS 宽度 | Container CSS width */
  clientWidth: number
  /** 容器 CSS 高度 | Container CSS height */
  clientHeight: number
  /** Worker 配置 | Worker configuration */
  config: WorkerConfiguration
  /** 设备像素比 | Device pixel ratio */
  dpr: number
}

/**
 * 加载更多数据响应负载
 * Load more data response payload
 */
export interface LoadMoreResponsePayload {
  /** 当前页码 | Current page number */
  page: number
  /** 是否还有更多数据 | Whether there is more data */
  hasMore: boolean
  /** 加载的图片位图数组 | Array of loaded image bitmaps */
  data: Array<ImageBitmap>
}

/**
 * 容器尺寸变化负载
 * Container resize payload
 */
export interface ResizePayload {
  /** 新的 CSS 宽度 | New CSS width */
  clientWidth: number
  /** 新的 CSS 高度 | New CSS height */
  clientHeight: number
  /** 新的设备像素比 | New device pixel ratio */
  dpr: number
}

/**
 * 占位符渲染完成响应负载
 * Placeholder render complete response payload
 */
export interface RenderLoadingResponsePayload {
  /** 占位符 ID | Placeholder ID */
  id: string
  /** 渲染好的位图 | Rendered bitmap */
  bitmap: ImageBitmap
}

/**
 * 滚动偏移负载（主线程→Worker）
 * Scroll offset payload (main thread → worker)
 */
export interface ScrollPayload {
  /** 水平滚动偏移量（px）| Horizontal scroll offset (px) */
  offsetX: number
  /** 垂直滚动偏移量（px）| Vertical scroll offset (px) */
  offsetY: number
}

/**
 * 布局更新通知负载（Worker→主线程）
 * Layout update notification payload (worker → main thread)
 */
export interface LayoutUpdatedPayload {
  /** 内容总宽度 | Total content width */
  contentWidth: number
  /** 内容总高度 | Total content height */
  contentHeight: number
}

/**
 * 图片加载完成负载（主线程→Worker）
 * Image loaded payload (main thread → worker)
 */
export interface ImageLoadedPayload {
  /** 图片在数据源中的索引 | Image index in data source */
  index: number
  /** 加载完成的位图 | Loaded bitmap */
  bitmap: ImageBitmap
  /** 图片原始宽度 | Original image width */
  width: number
  /** 图片原始高度 | Original image height */
  height: number
}

/**
 * 命中测试请求负载
 * Hit test request payload
 */
export interface HitTestPayload {
  /** 点击的 CSS X 坐标 | Click CSS X coordinate */
  x: number
  /** 点击的 CSS Y 坐标 | Click CSS Y coordinate */
  y: number
}

/**
 * 命中测试响应负载（命中时返回项信息，未命中返回 null）
 * Hit test response payload (returns item info on hit, null on miss)
 */
export type HitTestResponsePayload = {
  /** 命中的网格项 | Hit grid item */
  item: GridItem
  /** 数据源索引 | Data source index */
  index: number
  /** 行号 | Row number */
  row: number
  /** 列号 | Column number */
  column: number
} | null
