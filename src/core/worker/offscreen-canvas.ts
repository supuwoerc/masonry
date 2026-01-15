import type { LimitFunction } from 'p-limit'
import type { MasonryConfiguration } from '../masonry'
import type { Core, Interaction, LoadMoreConfig } from '../types'
import type {
  GridItem,
  Message,
  MessagePayload,
  RenderLoadingResponsePayload,
  RenderPayload,
  ResizePayload,
  SetupPayload,
} from './protocol'
import { allSettledWithResults, Queue, sleep, withTimeout } from '@supuwoerc/toolkit'
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
  #config!: WorkerConfiguration

  #pagination = {
    page: 1,
    loading: false,
    hasMore: true,
  }

  #blockWidth = 0
  #blockHeight = 0
  #columns = 0
  #rows = 0

  #allItems: GridItem[] = []

  #queue = new Queue<(() => void) | (() => Promise<void>)>()

  #isRunning = false

  #promiseLimit: LimitFunction | null = null

  #timeout = 0

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
    switch (message.type) {
      case MessageType.Setup:
        this.#handleSetup(message.payload as SetupPayload, message.id)
        break
      case MessageType.Render:
        this.#handleRender(message.payload as RenderPayload, message.id)
        break
      case MessageType.RenderLoadingResponse:
        this.#handleRenderLoading(message.payload as RenderLoadingResponsePayload, message.id)
        break
      case MessageType.Resize:
        this.#handleResize(message.payload as ResizePayload, message.id)
        break
      default:
        throw new MasonryError(`unknown message type: ${message.type}`)
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

  #handleSetup(payload: SetupPayload, from: string): void {
    try {
      this.#canvas = payload.offscreenCanvas
      this.#canvas.width = payload.clientWidth * payload.dpr
      this.#canvas.height = payload.clientHeight * payload.dpr
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
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
      this.#calculateSize()
      if ((this.#config.loader?.pageSize ?? 0) > 0) {
        this.#allItems = this.#loadMoreItems()
      } else if ((this.#config.core.items?.length ?? 0) > 0) {
        this.#allItems = this.#loadMoreItems(this.#config.core.items!)
        this.#addLoadGridImageTask(this.#allItems, from)
      }
      // TODO:首次补充满网格
      this.#runTask()
      this.#handleRender({ clearBeforeRender: true }, from)
      this.#startAnimationLoop()
      this.#sendMessage(MessageType.SetupResponse, null, from)
      // eslint-disable-next-line no-console
      console.log(this)
    } catch (error) {
      this.#sendError(error)
    }
  }

  async #handleRender(payload: RenderPayload, from: string) {
    if (!this.#context) {
      return
    }
    try {
      if (payload.clearBeforeRender) {
        this.#context.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
      }
      this.#allItems = await this.#generateGridItems(this.#allItems)
      this.#renderGridItems(this.#allItems)
      this.#sendMessage(MessageType.RenderResponse, null, from)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #startAnimationLoop() {
    const renderFrame = () => {
      // TODO:只处理可见范围内的元素 & 每一个items绑定不同的动画
      const loadingItems = this.#allItems.filter((item) => !item.image || item.loading)
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

  async #handleRenderLoading(payload: RenderLoadingResponsePayload, from: string) {
    if (!this.#context) {
      return
    }
    try {
      const loadingItems: GridItem[] = []
      const modify = this.#allItems.find((cell) => cell.id === payload.id)
      if (modify) {
        modify.image = payload.bitmap
        loadingItems.push(modify)
        this.#renderGridItems(loadingItems)
        this.#sendMessage(MessageType.RenderResponse, null, from)
      }
    } catch (error) {
      this.#sendError(error)
    }
  }

  #generateGridItems(initialItems: GridItem[]): GridItem[] {
    if (!this.#config?.core.style) {
      return []
    }
    const totalCells = this.#columns * this.#rows
    const gridItems: GridItem[] = []
    let availableItems = [...initialItems]
    if ((this.#config.loader?.pageSize ?? 0) > 0) {
      while (this.#pagination.hasMore && availableItems.length < totalCells) {
        const list = this.#loadMoreItems()
        this.#allItems.push(...list)
        availableItems = this.#allItems
      }
    }
    if (availableItems.length > 0 && availableItems.length < totalCells) {
      for (let i = availableItems.length; i < totalCells; i++) {
        const sourceIndex = i % availableItems.length
        availableItems.push(availableItems[sourceIndex])
      }
    }

    // 生成网格项
    for (let i = 0; i < totalCells; i++) {
      const column = i % this.#columns
      const row = Math.floor(i / this.#columns)
      const x = column * this.#blockWidth
      const y = row * this.#blockHeight
      let source: GridItem
      if (i < availableItems.length) {
        source = {
          ...availableItems[i],
          x,
          y,
        }
      } else {
        source = {
          id: nanoid(),
          url: '',
          image: null,
          loading: true,
          x,
          y,
        }
      }
      gridItems.push(source)
    }
    return gridItems
  }

  #loadMoreItems(urls: string[] = []): GridItem[] {
    const length = urls.length > 0 ? urls.length : (this.#config?.loader?.pageSize ?? 0)
    const result = Array.from({ length }).map((_, index) => {
      return {
        id: nanoid(),
        url: urls[index],
        image: null,
        loading: true,
        x: 0,
        y: 0,
      }
    })
    if (urls.length === 0) {
      this.#pagination.page++
      this.#sendMessage(MessageType.LoadMore, { page: this.#pagination.page })
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

  async #handleResize(payload: ResizePayload, from: string) {
    if (!this.#context) {
      return
    }
    try {
      this.#canvas.width = payload.clientWidth * payload.dpr
      this.#canvas.height = payload.clientHeight * payload.dpr
      this.#clientWidth = payload.clientWidth
      this.#clientHeight = payload.clientHeight
      this.#context.scale(payload.dpr, payload.dpr)
      this.#calculateSize()
      this.#handleRender({ clearBeforeRender: true }, from)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #sendError(error: unknown) {
    const err = isError(error) ? error : new MasonryError(toString(error))
    this.#sendMessage(MessageType.Error, err, nanoid())
  }

  #sendMessage(type: MessageType, payload: MessagePayload, from?: string): void {
    const message: Message<MessagePayload> = {
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

  async #loadGridImage(url: string, id: string, from: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new MasonryError(`load image error! status: ${response.status}`)
    }
    await sleep(5000000)
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const modifyTarget = this.#allItems.find((item) => item.id === id)
    if (modifyTarget) {
      modifyTarget.image = bitmap
      modifyTarget.loading = false
    }
    // TODO:根据增量渲染
    this.#handleRender({ clearBeforeRender: true }, from)
  }

  #addLoadGridImageTask(payload: LoadingItem[], from: string) {
    this.#queue.enqueue(async () => {
      try {
        const tasks = payload.map(({ id, url }) => {
          type TaskFn = () => Promise<void>
          let task: TaskFn = () => this.#loadGridImage(url, id, from)
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
        await allSettledWithResults(tasks)
      } catch (error) {
        this.#sendError(error)
      }
    })
  }
}

new OffscreenCanvasWorker()
