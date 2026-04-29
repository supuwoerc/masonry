import type { MasonryConfiguration } from '../masonry'
import type { Core, Interaction, LoadMoreConfig } from '../types'
import type {
  GridItem,
  LoadMoreResponsePayload,
  Message,
  RenderLoadingResponsePayload,
  RequestPayload,
  ResizePayload,
  ResponsePayload,
  SetupPayload,
} from './protocol'
import { Queue } from '@supuwoerc/toolkit'
import { isError, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import { createBackgroundStyle } from '@/helper/background'
import { MasonryError } from '../error'
import { MessageType } from './protocol'

export interface WorkerConfiguration extends Omit<
  MasonryConfiguration,
  'core' | 'interaction' | 'loader' | 'placeholderRenderer' | 'events'
> {
  core: Omit<Core, 'canvas'>
  interaction?: Omit<Interaction, 'onClick'>
  loader?: Omit<LoadMoreConfig, 'loadMore'>
}

class OffscreenCanvasWorker {
  #backgroundCanvas!: OffscreenCanvas
  #backgroundContext!: OffscreenCanvasRenderingContext2D
  #canvas!: OffscreenCanvas
  #context!: OffscreenCanvasRenderingContext2D
  #clientWidth = 0
  #clientHeight = 0
  #dpr = 1
  #config!: WorkerConfiguration

  #blockWidth = 0
  #blockHeight = 0
  #columns = 0
  #rows = 0

  #allItems: GridItem[] = []

  #gridItems: GridItem[][] = []

  #lastLoadingIds = new Set<string>()

  #queue = new Queue<(() => void) | (() => Promise<void>)>()

  #isRunning = false

  #pagination = {
    page: 1,
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
        break
      case MessageType.Resize:
        this.#handleResize(payload as ResizePayload)
        break
      case MessageType.RenderLoadingResponse:
        this.#handleRenderLoading(payload as RenderLoadingResponsePayload)
        break
      case MessageType.LoadMoreResponse:
        this.#handleLoadMoreResponse(payload as LoadMoreResponsePayload)
        break
      default:
        throw new MasonryError(`unknown message type: ${type}`)
    }
  }

  #calculateSize() {
    if (!this.#config?.core.style) {
      return
    }
    const { width: itemWidth, height: itemHeight, gap = 0 } = this.#config.core.style
    this.#blockWidth = itemWidth + gap
    this.#blockHeight = itemHeight + gap
    this.#columns = Math.ceil(this.#clientWidth / this.#blockWidth)
    this.#rows = Math.ceil(this.#clientHeight / this.#blockHeight)
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
      }
      this.#calculateSize()
      this.#generateGridItems(this.#allItems)
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
        this.#renderGridItems(this.#gridItems.flat())
      } catch (error) {
        this.#sendError(error)
      }
    }
  }

  #startAnimationLoop() {
    const renderFrame = () => {
      const loadingItems = this.#gridItems.flat().filter((item) => item.status !== 'loaded')
      const ids = loadingItems.map((item) => item.id)
      const idsChanged =
        ids.length !== this.#lastLoadingIds.size || ids.some((id) => !this.#lastLoadingIds.has(id))
      if (idsChanged && ids.length > 0) {
        this.#lastLoadingIds = new Set(ids)
        this.#sendMessage(MessageType.RenderLoading, ids)
      }
      if (ids.length === 0) {
        this.#lastLoadingIds.clear()
      }
      requestAnimationFrame(() => {
        renderFrame()
      })
    }
    renderFrame()
  }

  #handleLoadMoreResponse(payload: LoadMoreResponsePayload) {
    this.#pagination = {
      page: payload.page,
      hasMore: payload.hasMore,
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
      this.#generateGridItems(this.#allItems)
      this.#handleRerender()
    }
  }

  async #handleRenderLoading(payload: RenderLoadingResponsePayload) {
    if (!this.#context) {
      return
    }
    try {
      const loadingItems: GridItem[] = []
      const modify = this.#gridItems.flat().filter((cell) => {
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

  #generateGridItems(items: GridItem[]) {
    this.#gridItems = Array.from({ length: this.#rows }, (_, row) =>
      Array.from({ length: this.#columns }, (_, column) => {
        const x = column * this.#blockWidth
        const y = row * this.#blockHeight
        const index = row * this.#columns + column
        const itemIndex = items.length > 0 ? index % items.length : 0
        const patch = items[itemIndex] || null
        return {
          id: patch?.id ?? nanoid(),
          image: patch?.image ?? null,
          status: patch?.status ?? 'loading',
          x,
          y,
          itemIndex,
        }
      }),
    )
  }

  #renderGridItems(gridItems: GridItem[]): void {
    if (!this.#context || !this.#config?.core.style || gridItems.length === 0) {
      return
    }
    const { width: itemWidth, height: itemHeight, radius = 0 } = this.#config.core.style
    if (radius > 0) {
      this.#renderWithRadius(gridItems, itemWidth, itemHeight, radius)
    } else {
      this.#renderWithoutRadius(gridItems, itemWidth, itemHeight)
    }
  }

  #renderWithoutRadius(items: GridItem[], width: number, height: number): void {
    for (const item of items) {
      if (item.image) {
        this.#context?.drawImage(item.image, item.x, item.y, width, height)
      }
    }
  }

  #renderWithRadius(items: GridItem[], width: number, height: number, radius: number): void {
    for (const item of items) {
      if (item.image) {
        this.#context?.save()
        this.#context?.beginPath()
        this.#context?.roundRect(item.x, item.y, width, height, radius)
        this.#context?.clip()
        this.#context?.drawImage(item.image, item.x, item.y, width, height)
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
        this.#context.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.#backgroundContext.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.#calculateSize()
        this.#generateGridItems(this.#allItems)
        // TODO:重新渲染
        this.#handleRerender()
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
