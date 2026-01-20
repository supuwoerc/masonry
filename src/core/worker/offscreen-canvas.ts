import type { LimitFunction } from 'p-limit'
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
import { Queue, withTimeout } from '@supuwoerc/toolkit'
import { isError, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import pLimit from 'p-limit'
import { MasonryError } from '../error'
import { DefaultConcurrency, DefaultTimeout } from './constant'
import { MessageType } from './protocol'

interface LoadingItem {
  id: string
  url: string
}

export interface WorkerConfiguration extends Omit<
  MasonryConfiguration,
  'core' | 'interaction' | 'loader' | 'placeholderRenderer' | 'events'
> {
  core: Omit<Core, 'canvas'>
  interaction?: Omit<Interaction, 'onClick'>
  loader?: Omit<LoadMoreConfig, 'loadMore'>
}

class OffscreenCanvasWorker {
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

  #queue = new Queue<(() => void) | (() => Promise<void>)>()

  #isRunning = false

  #promiseLimit: LimitFunction | null = null

  #timeout = 0

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
        this.#handleRender()
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
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
      this.#dpr = payload.dpr
      this.#context = this.#canvas.getContext('2d')!
      this.#context.scale(payload.dpr, payload.dpr)
      this.#context.imageSmoothingEnabled = true
      this.#context.imageSmoothingQuality = 'high'
      this.#config = payload.config
      if (this.#config.core.limit) {
        this.#promiseLimit = pLimit(Math.max(DefaultConcurrency, this.#config.core.limit))
      }
      if (this.#config.core.timeout) {
        this.#timeout = Math.max(DefaultTimeout, this.#config.core.timeout)
      }
      if (this.#config.core.items?.length) {
        this.#allItems = this.#config.core.items.map((item) => {
          return {
            id: nanoid(),
            image: item,
            status: 'loaded',
            x: 0,
            y: 0,
          }
        })
      }
      this.#calculateSize()
      this.#generateGridItems(this.#allItems)
      this.#runTask()
      this.#sendMessage(MessageType.SetupResponse, null)
      // eslint-disable-next-line no-console
      console.log(this)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #handleRender() {
    if (this.#context) {
      try {
        this.#context.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
        this.#renderGridItems(this.#gridItems.flat())
      } catch (error) {
        this.#sendError(error)
      }
    }
  }

  #startAnimationLoop() {
    const renderFrame = () => {
      // TODO:只处理可见范围内的元素
      const loadingItems = this.#gridItems.flat().filter((item) => item.status !== 'loaded')
      if (loadingItems.length > 0) {
        const ids = loadingItems.map((item) => item.id)
        this.#sendMessage(MessageType.RenderLoading, ids)
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
    // TODO:完善加载逻辑
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
        }
      }),
    )
  }

  #loadMoreItems(urls: string[] = []): GridItem[] {
    const length = urls.length > 0 ? urls.length : (this.#config?.loader?.pageSize ?? 0)
    const result = Array.from({ length }).map(() => {
      const item: GridItem = {
        id: nanoid(),
        image: null,
        status: 'loading',
        x: 0,
        y: 0,
      }
      return item
    })
    if (urls.length === 0) {
      this.#sendMessage(MessageType.LoadMore, null)
    }
    return result
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
        this.#canvas.width = payload.clientWidth * payload.dpr
        this.#canvas.height = payload.clientHeight * payload.dpr
        this.#clientWidth = payload.clientWidth
        this.#clientHeight = payload.clientHeight
        this.#context.scale(payload.dpr, payload.dpr)
        this.#calculateSize()
        this.#generateGridItems([]) // TODO:处理图片数据等
        // TODO:重新渲染
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

  async #loadGridImage(url: string, id: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new MasonryError(`load image error! status: ${response.status}`)
    }
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const modify = this.#allItems.filter((item) => item.id === id)
    if (modify.length > 0) {
      modify.forEach((cell) => {
        cell.image = bitmap
        cell.status = 'loaded'
      })
      this.#sendMessage(MessageType.RemoveLoading, id)
    }
    // TODO:增量渲染 & 背景区域拆分
  }

  #addLoadGridImageTask(payload: LoadingItem[]) {
    this.#queue.enqueue(async () => {
      try {
        const tasks = payload.map(({ id, url }) => {
          type TaskFn = () => Promise<void>
          let task: TaskFn = () => this.#loadGridImage(url, id)
          if (this.#timeout > 0) {
            const original = task
            task = () => withTimeout(original(), this.#timeout, `load image ${url} timeout`)
          }
          if (this.#promiseLimit) {
            const original = task
            task = () => this.#promiseLimit!(original)
          }
          return task()
        })
        await Promise.all(tasks)
      } catch (error) {
        this.#sendError(error)
      }
    })
  }
}

new OffscreenCanvasWorker()
