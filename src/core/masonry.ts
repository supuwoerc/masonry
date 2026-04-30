import type {
  Core,
  ImageLoadConfig,
  Interaction,
  ItemDescriptor,
  LoadMoreConfig,
  PlaceholderRenderer,
} from './types'
import type {
  ClickPayload,
  ClickResultPayload,
  ImageLoadedPayload,
  LayoutUpdatedPayload,
  LoadMoreResponsePayload,
  Message,
  MessagePayload,
  ResizePayload,
  ScrollPayload,
  SetupPayload,
} from './worker/protocol'
import { debounce, isFunction, Queue } from '@supuwoerc/toolkit'
import { nanoid } from 'nanoid'
import { Validator } from '@/helper/validator'
import { isCanvasSupported, isWorkerSupported } from '@/utils/canvas'
import { defaultPlaceholderRenderer } from './constant'
import { MasonryError } from './error'
import { ImageLoader } from './image-loader'
import { configurationRules } from './rules'
import { MessageType } from './worker/protocol'
import 'path2d-polyfill'

/**
 * Masonry 完整配置接口
 * Complete Masonry configuration interface
 */
export interface MasonryConfiguration {
  /** 核心配置 | Core configuration */
  core: Core

  /** 交互配置 | Interaction configuration */
  interaction?: Interaction

  /** 无限滚动加载配置 | Infinite scroll loader configuration */
  loader?: LoadMoreConfig

  /** 图片加载配置 | Image loading configuration */
  imageLoad?: ImageLoadConfig

  /** 占位符渲染器 | Placeholder renderer */
  placeholderRenderer?: PlaceholderRenderer

  /** 事件回调 | Event callbacks */
  events?: {
    /** 实例就绪回调 | Instance ready callback */
    onReady?: (instance: Masonry) => void
    /** 错误回调 | Error callback */
    onError?: (err: unknown) => void
  }
}

/**
 * Masonry 核心类，负责主线程端的协调工作
 * Masonry core class, responsible for main-thread orchestration
 *
 * 职责包括：
 * - 初始化 Web Worker 和 OffscreenCanvas
 * - 管理主线程与 Worker 间的消息通信
 * - 处理 ResizeObserver 响应容器尺寸变化
 * - 协调占位符渲染和无限滚动加载
 *
 * Responsibilities include:
 * - Initializing Web Worker and OffscreenCanvas
 * - Managing message communication between main thread and worker
 * - Handling ResizeObserver for container size changes
 * - Coordinating placeholder rendering and infinite scroll loading
 */
export class Masonry {
  #validator = new Validator<MasonryConfiguration>(configurationRules)

  #config: MasonryConfiguration

  #resizeObserver = new ResizeObserver(() => this.#resize())

  #useWorker = isWorkerSupported()

  #worker: Worker | null = null

  #pagination = {
    page: 1,
    loading: false,
    hasMore: true,
  }

  #queue = new Queue<(() => void) | (() => Promise<void>)>()

  #isRunning = false

  #placeholderRenderer: PlaceholderRenderer = defaultPlaceholderRenderer

  #scrollAbort = new AbortController()

  #dprMediaQuery: MediaQueryList | null = null
  #pointerState: { down: boolean; startX: number; startY: number; lastX: number; lastY: number } = {
    down: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
  }

  #imageLoader: ImageLoader | null = null

  #pendingUrls: ItemDescriptor[] = []

  #pendingClickEvent: PointerEvent | null = null

  /** 实例就绪回调 | Instance ready callback */
  onReady: ((ins: Masonry) => void) | null = null

  /** 错误处理回调 | Error handler callback */
  onError: (e: unknown) => void = (e: unknown) => console.error(e)

  /**
   * 创建 Masonry 实例
   * Create a Masonry instance
   * @param config - 完整配置 | Complete configuration
   * @throws {MasonryError} 环境不支持 Canvas 或配置验证失败时抛出
   *         Throws when Canvas is not supported or configuration validation fails
   */
  constructor(config: MasonryConfiguration) {
    if (!isCanvasSupported()) {
      throw new MasonryError('the current environment does not support the canvas API')
    }
    const { valid, errors } = this.#validator.validate(config)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    this.#config = config
    this.#init()
  }

  #init() {
    this.#initPlaceholderRenderer(this.#config)
    this.#initEvents(this.#config)
    this.#initObserver()
    this.#initScrollListeners()
    if (this.#useWorker) {
      this.#initWorker()
    } else {
      this.onError(new MasonryError('Web Worker is not supported in this environment'))
    }
  }

  async #initWorker() {
    try {
      this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
        type: 'module',
      })
      const canvas = this.#config.core.canvas
      const offscreenCanvas = canvas.transferControlToOffscreen()
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this)
      this.#worker.onerror = (e: Event) => {
        this.onError(new MasonryError(`Worker error: ${(e as ErrorEvent).message || 'unknown'}`))
      }
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
      const items = this.#config.core.items
      if (items?.length) {
        if (items[0] instanceof ImageBitmap) {
          payload.config.core.items = items as ImageBitmap[]
        } else {
          const descriptors = this.#normalizeItems(items as string[] | ItemDescriptor[])
          payload.config.core.itemCount = descriptors.length
          payload.config.core.itemSizes = descriptors.map((d) => ({
            width: d.width,
            height: d.height,
          }))
          this.#pendingUrls = descriptors
        }
      }
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
      this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas])
    } catch (error) {
      this.#useWorker = false
      this.#worker = null
      this.onError(error)
    }
  }

  #handleWorkerMessage(event: MessageEvent<Message>) {
    const { type, payload } = event.data
    switch (type) {
      case MessageType.SetupResponse:
        this.onReady?.(this)
        this.#sendMessage(MessageType.Render, null)
        this.#loadImages()
        break
      case MessageType.LoadMore:
        this.#handleLoadMoreTask()
        this.#runTask()
        break
      case MessageType.RenderLoading:
        this.#handleRenderLoading(payload as Array<string>)
        this.#runTask()
        break
      case MessageType.RemoveLoading:
        this.#placeholderRenderer.remove(payload as string)
        break
      case MessageType.LayoutUpdated:
        this.#config.interaction?.onLayoutUpdate?.(payload as LayoutUpdatedPayload)
        break
      case MessageType.ClickResult:
        this.#handleClickResult(payload as ClickResultPayload)
        break
      case MessageType.Error:
        this.onError(payload)
        break
    }
  }

  #handleRenderLoading(ids: Array<string>) {
    if (ids.length > 0) {
      this.#queue.enqueue(async () => {
        try {
          const { width, height } = this.#config.core.style
          const tasks = ids.map(async (id) => {
            const bitmap = await this.#placeholderRenderer.render(width, height, id)
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

  #sendMessage(type: MessageType, payload: MessagePayload, transfer?: Transferable[]) {
    const message: Message<MessagePayload> = {
      id: nanoid(),
      type,
      payload,
      timestamp: Date.now(),
    }
    this.#worker?.postMessage(message, transfer ?? [])
  }

  #initPlaceholderRenderer(config: MasonryConfiguration) {
    if (config.placeholderRenderer) {
      this.#placeholderRenderer = config.placeholderRenderer
    }
  }

  #initEvents(config: MasonryConfiguration) {
    if (config.events?.onReady && isFunction(config.events.onReady)) {
      this.onReady = config.events.onReady
    }
    if (config.events?.onError && isFunction(config.events.onError)) {
      this.onError = config.events.onError
    }
  }

  #initObserver() {
    this.#resizeObserver.observe(this.#config.core.canvas)
    this.#initDprListener()
  }

  /**
   * 监听设备像素比变化（浏览器缩放）
   * Listen for device pixel ratio changes (browser zoom)
   */
  #initDprListener() {
    if (typeof window.matchMedia !== 'function') {
      return
    }
    const updateDpr = () => {
      this.#resize()
      this.#dprMediaQuery?.removeEventListener('change', updateDpr)
      this.#initDprListener()
    }
    this.#dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.#dprMediaQuery.addEventListener('change', updateDpr)
  }

  #handleLoadMoreTask() {
    this.#queue.enqueue(async () => {
      if (!this.#config?.loader || this.#pagination.loading || !this.#pagination.hasMore) {
        return
      }
      try {
        this.#pagination.loading = true
        const { loadMore, pageSize } = this.#config.loader
        const list = await loadMore(this.#pagination.page, pageSize)
        const message: LoadMoreResponsePayload = {
          page: this.#pagination.page,
          hasMore: list.length >= pageSize,
          data: [],
        }
        if (list && list.length > 0) {
          this.#pagination.page++
          if (list[0] instanceof ImageBitmap) {
            message.data = list as ImageBitmap[]
          } else {
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
        this.#pagination.loading = false
      }
    })
  }

  #resize = debounce(100 / 6, () => {
    const payload: ResizePayload = {
      clientWidth: this.#config.core.canvas.clientWidth,
      clientHeight: this.#config.core.canvas.clientHeight,
      dpr: window.devicePixelRatio || 1,
    }
    this.#sendMessage(MessageType.Resize, payload)
  })

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

  /**
   * 标准化 items 为 ItemDescriptor 数组
   * Normalize items to ItemDescriptor array
   */
  #normalizeItems(items: string[] | ItemDescriptor[]): ItemDescriptor[] {
    return items.map((item) => {
      if (typeof item === 'string') {
        return { url: item }
      }
      return item
    })
  }

  /**
   * 启动图片异步加载
   * Start asynchronous image loading
   */
  #loadImages() {
    if (this.#pendingUrls.length === 0) {
      return
    }
    this.#imageLoader = new ImageLoader(this.#config.imageLoad)
    const batch = this.#pendingUrls.map((desc, index) => ({
      url: desc.url,
      index,
      width: desc.width,
      height: desc.height,
    }))
    this.#imageLoader.loadBatch(batch, (index, bitmap, width, height) => {
      const payload: ImageLoadedPayload = { index, bitmap, width, height }
      this.#sendMessage(MessageType.ImageLoaded, payload, [bitmap])
    })
    this.#pendingUrls = []
  }

  /**
   * 初始化滚动事件监听
   * Initialize scroll event listeners
   */
  #initScrollListeners() {
    const canvas = this.#config.core.canvas
    const signal = this.#scrollAbort.signal

    canvas.addEventListener('wheel', this.#handleWheel.bind(this), { passive: false, signal })
    canvas.addEventListener('pointerdown', this.#handlePointerDown.bind(this), { signal })
    canvas.addEventListener('pointermove', this.#handlePointerMove.bind(this), { signal })
    canvas.addEventListener('pointerup', this.#handlePointerUp.bind(this), { signal })
    canvas.addEventListener('pointercancel', this.#handlePointerUp.bind(this), { signal })
  }

  #handleWheel(e: WheelEvent) {
    e.preventDefault()
    const scroll = this.#config.interaction?.scroll
    const deltaX = scroll?.disabled?.horizontal ? 0 : e.deltaX
    const deltaY = scroll?.disabled?.vertical ? 0 : e.deltaY
    if (deltaX !== 0 || deltaY !== 0) {
      const payload: ScrollPayload = { deltaX, deltaY }
      this.#sendMessage(MessageType.Scroll, payload)
    }
  }

  #handlePointerDown(e: PointerEvent) {
    this.#pointerState.down = true
    this.#pointerState.startX = e.clientX
    this.#pointerState.startY = e.clientY
    this.#pointerState.lastX = e.clientX
    this.#pointerState.lastY = e.clientY
    ;(e.target as HTMLElement)?.setPointerCapture?.(e.pointerId)
  }

  #handlePointerMove(e: PointerEvent) {
    if (!this.#pointerState.down) {
      return
    }
    const scroll = this.#config.interaction?.scroll
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
    const dx = Math.abs(e.clientX - this.#pointerState.startX)
    const dy = Math.abs(e.clientY - this.#pointerState.startY)
    if (dx < 5 && dy < 5 && this.#config.interaction?.onClick) {
      const rect = this.#config.core.canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      this.#pendingClickEvent = e
      const payload: ClickPayload = { x, y }
      this.#sendMessage(MessageType.Click, payload)
    }
  }

  /**
   * 处理 Worker 返回的点击结果
   * Handle click result returned from Worker
   */
  #handleClickResult(payload: ClickResultPayload) {
    if (!payload || !this.#pendingClickEvent) {
      this.#pendingClickEvent = null
      return
    }
    const onClick = this.#config.interaction?.onClick
    if (onClick) {
      onClick({
        item: payload.item,
        index: payload.index,
        row: payload.row,
        column: payload.column,
        event: this.#pendingClickEvent,
      })
    }
    this.#pendingClickEvent = null
  }

  /**
   * 销毁实例，释放所有资源
   * Destroy the instance and release all resources
   */
  destroy() {
    if (this.#useWorker && this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
    this.#imageLoader?.dispose()
    this.#scrollAbort.abort()
    this.#resizeObserver.disconnect()
    this.#dprMediaQuery = null
    this.#config.placeholderRenderer?.dispose()
  }
}
