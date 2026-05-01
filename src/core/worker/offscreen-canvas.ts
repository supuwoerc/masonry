import type { MasonryConfiguration } from '../masonry'
import type { Core, Interaction, LayoutStrategy, LoadMoreConfig } from '../types'
import type {
  ClickPayload,
  GridItem,
  ImageLoadedPayload,
  LoadMoreResponsePayload,
  Message,
  RenderLoadingResponsePayload,
  RequestPayload,
  ResizePayload,
  ResponsePayload,
  ScrollPayload,
  SetupPayload,
} from './protocol'
import { Queue } from '@supuwoerc/toolkit'
import { isError, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import { createBackgroundStyle } from '@/helper/background'
import { MasonryError } from '../error'
import { GridLayout } from '../layout/grid-layout'
import { MasonryLayout } from '../layout/masonry-layout'
import { MessageType } from './protocol'

/**
 * Worker 端配置接口（排除了仅主线程需要的字段）
 * Worker-side configuration interface (excludes main-thread-only fields)
 */
export interface WorkerConfiguration extends Omit<
  MasonryConfiguration,
  'core' | 'interaction' | 'loader' | 'placeholderRenderer' | 'events' | 'imageLoad'
> {
  /** 核心配置（无 canvas、items 固定为 ImageBitmap[]）| Core config (no canvas, items are ImageBitmap[]) */
  core: Omit<Core, 'canvas' | 'items'> & {
    items?: ImageBitmap[]
    /** 待加载项的数量（用于预分配占位符）| Number of items to load (for pre-allocating placeholders) */
    itemCount?: number
    /** 待加载项的原始尺寸（用于瀑布流布局）| Original sizes of items to load (for masonry layout) */
    itemSizes?: Array<{ width?: number; height?: number }>
  }
  /** 交互配置（无 onClick 回调）| Interaction config (no onClick callback) */
  interaction?: Omit<Interaction, 'onClick'>
  /** 加载配置（无 loadMore 函数）| Loader config (no loadMore function) */
  loader?: Omit<LoadMoreConfig, 'loadMore'>
}

/**
 * OffscreenCanvas Worker 渲染引擎
 * OffscreenCanvas Worker rendering engine
 *
 * 运行在 Web Worker 线程中，负责：
 * - 接收主线程传来的 OffscreenCanvas 进行离屏绘制
 * - 管理网格项的布局计算和渲染
 * - 处理背景绘制（纯色/渐变）
 * - 响应容器尺寸变化重新布局
 * - 协调占位符动画帧更新
 *
 * Runs in a Web Worker thread, responsible for:
 * - Receiving OffscreenCanvas from main thread for offscreen drawing
 * - Managing grid item layout calculation and rendering
 * - Handling background drawing (solid/gradient)
 * - Responding to container resize with re-layout
 * - Coordinating placeholder animation frame updates
 */
class OffscreenCanvasWorker {
  #backgroundCanvas!: OffscreenCanvas
  #backgroundContext!: OffscreenCanvasRenderingContext2D
  #canvas!: OffscreenCanvas
  #context!: OffscreenCanvasRenderingContext2D
  #clientWidth = 0
  #clientHeight = 0
  #dpr = 1
  #config!: WorkerConfiguration

  #layoutStrategy!: LayoutStrategy

  #allItems: GridItem[] = []

  #gridItems: GridItem[] = []

  #lastLoadingIds = new Set<string>()

  #queue = new Queue<(() => void) | (() => Promise<void>)>()

  #isRunning = false

  #scrollX = 0
  #scrollY = 0
  #velocityX = 0
  #velocityY = 0
  #contentWidth = 0
  #contentHeight = 0
  #isInertiaActive = false

  #loadMoreState = {
    loading: false,
    hasMore: true,
  }

  constructor() {
    this.#setupMessageHandler()
  }

  #setupMessageHandler(): void {
    globalThis.onmessage = (event: MessageEvent<Message>) => {
      try {
        this.#handleMessage(event.data)
      } catch (error) {
        this.#sendError(error)
      }
    }
  }

  #handleMessage(message: Message) {
    const { type, payload } = message
    switch (type) {
      case MessageType.Setup:
        this.#handleSetup(payload as SetupPayload)
        break
      case MessageType.Render:
        this.#startAnimationLoop()
        this.#handleRerender()
        this.#checkLoadMore()
        break
      case MessageType.Resize:
        this.#handleResize(payload as ResizePayload)
        break
      case MessageType.Scroll:
        this.#handleScroll(payload as ScrollPayload)
        break
      case MessageType.RenderLoadingResponse:
        this.#handleRenderLoading(payload as RenderLoadingResponsePayload)
        break
      case MessageType.LoadMoreResponse:
        this.#handleLoadMoreResponse(payload as LoadMoreResponsePayload)
        break
      case MessageType.ImageLoaded:
        this.#handleImageLoaded(payload as ImageLoadedPayload)
        break
      case MessageType.Click:
        this.#handleClick(payload as ClickPayload)
        break
      default:
        throw new MasonryError(`unknown message type: ${type}`)
    }
  }

  #performLayout() {
    if (!this.#config?.core.style) {
      return
    }
    const input = {
      items: this.#allItems,
      containerWidth: this.#clientWidth,
      containerHeight: this.#clientHeight,
      style: this.#config.core.style,
    }
    const result = this.#layoutStrategy.calculate(input)
    this.#gridItems = result.items
    this.#contentWidth = result.contentWidth
    this.#contentHeight = result.contentHeight
    this.#clampScroll()
    this.#sendMessage(MessageType.LayoutUpdated, {
      contentWidth: result.contentWidth,
      contentHeight: result.contentHeight,
    })
  }

  #handleSetup(payload: SetupPayload) {
    try {
      this.#canvas = payload.offscreenCanvas
      this.#canvas.width = payload.clientWidth * payload.dpr
      this.#canvas.height = payload.clientHeight * payload.dpr
      this.#backgroundCanvas = new OffscreenCanvas(this.#canvas.width, this.#canvas.height)
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
      this.#dpr = payload.dpr
      this.#context = this.#canvas.getContext('2d')!
      this.#backgroundContext = this.#backgroundCanvas.getContext('2d')!
      this.#context.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
      this.#context.imageSmoothingEnabled = true
      this.#context.imageSmoothingQuality = 'high'
      this.#backgroundContext.setTransform(payload.dpr, 0, 0, payload.dpr, 0, 0)
      this.#backgroundContext.imageSmoothingEnabled = true
      this.#backgroundContext.imageSmoothingQuality = 'high'
      this.#config = payload.config
      if (!this.#config.loader) {
        this.#loadMoreState.hasMore = false
      }
      const mode = this.#config.core.layout ?? 'grid'
      this.#layoutStrategy = mode === 'masonry' ? new MasonryLayout() : new GridLayout()
      if (this.#config.core.items?.length) {
        this.#allItems = this.#config.core.items.map((item, itemIndex) => {
          return {
            id: nanoid(),
            image: item,
            status: 'loaded',
            x: 0,
            y: 0,
            itemIndex,
          }
        })
      } else if (this.#config.core.itemCount) {
        const sizes = this.#config.core.itemSizes ?? []
        this.#allItems = Array.from({ length: this.#config.core.itemCount }, (_, itemIndex) => {
          return {
            id: nanoid(),
            image: null,
            status: 'loading' as const,
            x: 0,
            y: 0,
            width: sizes[itemIndex]?.width,
            height: sizes[itemIndex]?.height,
            itemIndex,
          }
        })
      }
      this.#performLayout()
      this.#runTask()
      this.#sendMessage(MessageType.SetupResponse, null)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #clearBackground() {
    this.#backgroundContext.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
  }

  #clear() {
    this.#context.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
  }

  #handleRenderBackground() {
    const bgStyle = createBackgroundStyle(
      this.#backgroundContext,
      this.#clientWidth,
      this.#clientHeight,
      this.#config.core.backgroundColor || '#fff',
    )
    this.#backgroundContext.save()
    this.#backgroundContext.fillStyle = bgStyle
    this.#backgroundContext.fillRect(0, 0, this.#clientWidth, this.#clientHeight)
    this.#backgroundContext.restore()
  }

  #copyBackground() {
    this.#context.drawImage(this.#backgroundCanvas, 0, 0, this.#clientWidth, this.#clientHeight)
  }

  #handleRerender() {
    if (this.#context) {
      try {
        this.#clear()
        this.#clearBackground()
        this.#handleRenderBackground()
        this.#copyBackground()
        this.#context.save()
        this.#context.translate(-this.#scrollX, -this.#scrollY)
        if (this.#isLoopActive) {
          this.#renderLoopedItems(this.#gridItems)
        } else {
          this.#renderGridItems(this.#getVisibleItems(this.#gridItems))
        }
        this.#context.restore()
      } catch (error) {
        this.#sendError(error)
      }
    }
  }

  /**
   * 视口裁剪：过滤出可见区域内的项目
   * Viewport culling: filter items within the visible area
   */
  #getVisibleItems(items: GridItem[]): GridItem[] {
    const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
    const bufferH = this.#clientHeight * buffer
    const bufferW = this.#clientWidth * buffer
    const top = this.#scrollY - bufferH
    const bottom = this.#scrollY + this.#clientHeight + bufferH
    const left = this.#scrollX - bufferW
    const right = this.#scrollX + this.#clientWidth + bufferW
    const defaultW = this.#config?.core.style?.width ?? 0
    const defaultH = this.#config?.core.style?.height ?? 0
    return items.filter((item) => {
      const w = item.width ?? defaultW
      const h = item.height ?? defaultH
      return item.x + w > left && item.x < right && item.y + h > top && item.y < bottom
    })
  }

  /**
   * 无缝循环模式渲染：水平+垂直均无限循环，1D modulo 映射
   * Loop mode render: both directions infinite, 1D modulo mapping
   */
  #renderLoopedItems(items: GridItem[]): void {
    if (!this.#context || !this.#config?.core.style || items.length === 0) {
      return
    }
    const { width: itemW, height: itemH, gap = 0, radius = 0 } = this.#config.core.style
    const blockW = itemW + gap
    const blockH = itemH + gap
    const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))
    const buffer = this.#config?.interaction?.scroll?.buffer ?? 1.0
    const bufferW = this.#clientWidth * buffer
    const bufferH = this.#clientHeight * buffer

    const left = this.#scrollX - bufferW
    const right = this.#scrollX + this.#clientWidth + bufferW
    const top = this.#scrollY - bufferH
    const bottom = this.#scrollY + this.#clientHeight + bufferH

    const colStart = Math.floor(left / blockW)
    const colEnd = Math.ceil(right / blockW) - 1
    const rowStart = Math.floor(top / blockH)
    const rowEnd = Math.ceil(bottom / blockH) - 1

    const totalItems = items.length

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const wrappedCol = ((col % columns) + columns) % columns
        const extraRows = Math.floor(col / columns)
        const linearIndex = (row + extraRows) * columns + wrappedCol
        const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
        const item = items[itemIndex]
        if (!item?.image) {
          continue
        }
        const drawX = col * blockW
        const drawY = row * blockH
        if (radius > 0) {
          this.#context.save()
          this.#context.beginPath()
          this.#context.roundRect(drawX, drawY, itemW, itemH, radius)
          this.#context.clip()
          this.#context.drawImage(item.image, drawX, drawY, itemW, itemH)
          this.#context.restore()
        } else {
          this.#context.drawImage(item.image, drawX, drawY, itemW, itemH)
        }
      }
    }
  }

  #handleScroll(payload: ScrollPayload) {
    const scroll = this.#config?.interaction?.scroll
    const disableH = scroll?.disabled?.horizontal ?? false
    const disableV = scroll?.disabled?.vertical ?? false
    const dx = disableH ? 0 : payload.deltaX
    const dy = disableV ? 0 : payload.deltaY
    this.#scrollX += dx
    this.#scrollY += dy
    this.#clampScroll()
    const inertia = scroll?.inertia ?? true
    if (inertia) {
      this.#velocityX = dx
      this.#velocityY = dy
      this.#isInertiaActive = true
      this.#startAnimationLoop()
    }
    this.#handleRerender()
    this.#checkLoadMore()
  }

  /**
   * 处理点击事件，计算命中的网格项
   * Handle click event, calculate which grid item was hit
   */
  #handleClick(payload: ClickPayload) {
    const { x, y } = payload
    const contentX = x + this.#scrollX
    const contentY = y + this.#scrollY
    const defaultW = this.#config?.core.style?.width ?? 0
    const defaultH = this.#config?.core.style?.height ?? 0
    const gap = this.#config?.core.style?.gap ?? 0
    const blockW = defaultW + gap
    const blockH = defaultH + gap
    const columns = Math.max(1, Math.ceil(this.#clientWidth / blockW))

    if (this.#isLoopActive) {
      const col = Math.floor(contentX / blockW)
      const row = Math.floor(contentY / blockH)
      const cellX = contentX - col * blockW
      const cellY = contentY - row * blockH
      if (cellX > defaultW || cellY > defaultH) {
        this.#sendMessage(MessageType.ClickResult, null)
        return
      }
      const linearIndex = row * columns + col
      const totalItems = this.#gridItems.length
      const itemIndex = ((linearIndex % totalItems) + totalItems) % totalItems
      const item = this.#gridItems[itemIndex]
      if (item?.image) {
        this.#sendMessage(MessageType.ClickResult, {
          item,
          index: item.itemIndex,
          row,
          column: col,
        })
      } else {
        this.#sendMessage(MessageType.ClickResult, null)
      }
    } else {
      const hitItem = this.#findHitItem(contentX, contentY, defaultW, defaultH)
      if (hitItem) {
        const row = Math.floor(hitItem.itemIndex / columns)
        const column = hitItem.itemIndex % columns
        this.#sendMessage(MessageType.ClickResult, {
          item: hitItem,
          index: hitItem.itemIndex,
          row,
          column,
        })
      } else {
        this.#sendMessage(MessageType.ClickResult, null)
      }
    }
  }

  /**
   * 在网格项中查找包含指定坐标的项
   * Find grid item containing the specified coordinates
   */
  #findHitItem(x: number, y: number, defaultW: number, defaultH: number): GridItem | null {
    for (let i = this.#gridItems.length - 1; i >= 0; i--) {
      const item = this.#gridItems[i]
      const w = item.width ?? defaultW
      const h = item.height ?? defaultH
      if (x >= item.x && x < item.x + w && y >= item.y && y < item.y + h) {
        return item
      }
    }
    return null
  }

  /**
   * 检查滚动位置是否接近边界，触发加载更多（垂直+水平）
   * Check if scroll position is near boundary to trigger load more (vertical + horizontal)
   */
  #checkLoadMore() {
    if (!this.#config?.loader || this.#loadMoreState.loading || !this.#loadMoreState.hasMore) {
      return
    }
    const threshold = this.#config.interaction?.scroll?.threshold
    const remainingY = this.#contentHeight - this.#clientHeight - this.#scrollY
    const remainingX = this.#contentWidth - this.#clientWidth - this.#scrollX
    const thresholdY = threshold ?? this.#clientHeight
    const thresholdX = threshold ?? this.#clientWidth
    if (remainingY <= thresholdY || remainingX <= thresholdX) {
      this.#loadMoreState.loading = true
      this.#sendMessage(MessageType.LoadMore, null)
    }
  }

  #clampScroll() {
    if (this.#isLoopActive) {
      this.#wrapScroll()
    } else {
      const maxX = Math.max(0, this.#contentWidth - this.#clientWidth)
      const maxY = Math.max(0, this.#contentHeight - this.#clientHeight)
      this.#scrollX = Math.max(0, Math.min(this.#scrollX, maxX))
      this.#scrollY = Math.max(0, Math.min(this.#scrollY, maxY))
    }
  }

  get #isLoopActive(): boolean {
    const loopEnabled = this.#config?.interaction?.scroll?.loop ?? true
    return loopEnabled && !this.#loadMoreState.hasMore
  }

  #wrapScroll() {
    const disableH = this.#config?.interaction?.scroll?.disabled?.horizontal ?? false
    const disableV = this.#config?.interaction?.scroll?.disabled?.vertical ?? false
    if (disableH) {
      this.#scrollX = 0
    }
    if (disableV) {
      this.#scrollY = 0
    }
  }

  #tickInertia() {
    const friction = this.#config?.interaction?.scroll?.friction ?? 0.95
    const threshold = 0.5
    this.#velocityX *= friction
    this.#velocityY *= friction
    this.#scrollX += this.#velocityX
    this.#scrollY += this.#velocityY
    this.#clampScroll()
    if (Math.abs(this.#velocityX) < threshold && Math.abs(this.#velocityY) < threshold) {
      this.#velocityX = 0
      this.#velocityY = 0
      this.#isInertiaActive = false
    }
    this.#checkLoadMore()
  }

  #animationRunning = false

  #startAnimationLoop() {
    if (this.#animationRunning) {
      return
    }
    this.#animationRunning = true
    const renderFrame = () => {
      if (this.#isInertiaActive) {
        this.#tickInertia()
        this.#handleRerender()
      }
      const loadingItems = this.#gridItems.filter((item) => item.status !== 'loaded')
      const ids = loadingItems.map((item) => item.id)
      if (ids.length > 0) {
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
      const hasWork = this.#isInertiaActive || ids.length > 0
      if (hasWork) {
        requestAnimationFrame(renderFrame)
      } else {
        this.#animationRunning = false
      }
    }
    renderFrame()
  }

  #handleLoadMoreResponse(payload: LoadMoreResponsePayload) {
    this.#loadMoreState.loading = false
    if (!payload.hasMore) {
      this.#loadMoreState.hasMore = false
    }
    if (payload.data.length > 0) {
      const newItems = payload.data.map((bitmap, i) => ({
        id: nanoid(),
        image: bitmap,
        status: 'loaded' as const,
        x: 0,
        y: 0,
        itemIndex: this.#allItems.length + i,
      }))
      this.#allItems.push(...newItems)
      this.#performLayout()
      this.#handleRerender()
    }
    this.#checkLoadMore()
  }

  #handleImageLoaded(payload: ImageLoadedPayload) {
    const item = this.#allItems[payload.index]
    if (!item) {
      return
    }
    const wasLoading = item.status === 'loading'
    item.image = payload.bitmap
    item.status = 'loaded'
    item.width = payload.width
    item.height = payload.height
    if (wasLoading) {
      this.#sendMessage(MessageType.RemoveLoading, item.id)
    }
    this.#performLayout()
    this.#handleRerender()
    this.#startAnimationLoop()
  }

  async #handleRenderLoading(payload: RenderLoadingResponsePayload) {
    if (!this.#context) {
      return
    }
    try {
      const loadingItems: GridItem[] = []
      const modify = this.#gridItems.filter((cell) => {
        return cell.id === payload.id && cell.status === 'loading'
      })
      if (modify.length > 0) {
        modify.forEach((cell) => {
          cell.image = payload.bitmap
          loadingItems.push(cell)
        })
        this.#renderGridItems(loadingItems)
      }
    } catch (error) {
      this.#sendError(error)
    }
  }

  #renderGridItems(gridItems: GridItem[]): void {
    if (!this.#context || !this.#config?.core.style || gridItems.length === 0) {
      return
    }
    const { width: defaultWidth, height: defaultHeight, radius = 0 } = this.#config.core.style
    if (radius > 0) {
      this.#renderWithRadius(gridItems, defaultWidth, defaultHeight, radius)
    } else {
      this.#renderWithoutRadius(gridItems, defaultWidth, defaultHeight)
    }
  }

  #renderWithoutRadius(items: GridItem[], defaultWidth: number, defaultHeight: number): void {
    for (const item of items) {
      if (item.image) {
        const w = item.width ?? defaultWidth
        const h = item.height ?? defaultHeight
        this.#context?.drawImage(item.image, item.x, item.y, w, h)
      }
    }
  }

  #renderWithRadius(
    items: GridItem[],
    defaultWidth: number,
    defaultHeight: number,
    radius: number,
  ): void {
    for (const item of items) {
      if (item.image) {
        const w = item.width ?? defaultWidth
        const h = item.height ?? defaultHeight
        this.#context?.save()
        this.#context?.beginPath()
        this.#context?.roundRect(item.x, item.y, w, h, radius)
        this.#context?.clip()
        this.#context?.drawImage(item.image, item.x, item.y, w, h)
        this.#context?.restore()
      }
    }
  }

  async #handleResize(payload: ResizePayload) {
    if (!this.#context) {
      return
    }
    try {
      const { clientHeight, clientWidth, dpr } = payload
      const w = clientWidth !== this.#clientWidth
      const h = clientHeight !== this.#clientHeight
      const d = dpr !== this.#dpr
      if (w || h || d) {
        this.#clear()
        this.#canvas.width = payload.clientWidth * payload.dpr
        this.#canvas.height = payload.clientHeight * payload.dpr
        this.#backgroundCanvas.width = clientWidth * dpr
        this.#backgroundCanvas.height = clientHeight * dpr
        this.#clientWidth = payload.clientWidth
        this.#clientHeight = payload.clientHeight
        this.#dpr = dpr
        this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.#context.imageSmoothingEnabled = true
        this.#context.imageSmoothingQuality = 'high'
        this.#backgroundContext.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.#backgroundContext.imageSmoothingEnabled = true
        this.#backgroundContext.imageSmoothingQuality = 'high'
        this.#performLayout()
        this.#handleRerender()
        this.#checkLoadMore()
      }
    } catch (error) {
      this.#sendError(error)
    }
  }

  #sendError(error: unknown) {
    const err = isError(error) ? error : new MasonryError(toString(error))
    this.#sendMessage(MessageType.Error, err, nanoid())
  }

  #sendMessage(type: MessageType, payload: RequestPayload | ResponsePayload, from?: string): void {
    const message: Message<RequestPayload | ResponsePayload> = {
      id: nanoid(),
      from,
      type,
      payload,
      timestamp: Date.now(),
    }
    globalThis.postMessage(message)
  }

  async #runTask() {
    if (!this.#isRunning) {
      try {
        this.#isRunning = true
        while (this.#queue.size > 0) {
          const task = this.#queue.dequeue()
          await task?.()
        }
      } finally {
        this.#isRunning = false
      }
    }
  }
}

new OffscreenCanvasWorker()
