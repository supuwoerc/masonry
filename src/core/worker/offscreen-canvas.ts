import type { LimitFunction } from 'p-limit'
import type { MasonryConfiguration } from '../masonry'
import type { Core, PlaceholderRenderer } from '../types'
import type { GridItem, Message, MessagePayload, RenderPayload, SetupPayload } from './types'
import { allSettledWithResults, Queue, withTimeout } from '@supuwoerc/toolkit'
import { isError, isUndefined, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import pLimit from 'p-limit'
import { MasonryError } from '../error'
import { MessageType } from './types'

export interface WorkerConfiguration extends Omit<MasonryConfiguration, 'core'> {
  core: Omit<Core, 'canvas'>
  placeholderRenderer: PlaceholderRenderer
}

const DefaultConcurrency = 6
const DefaultTimeout = 1000

class OffscreenCanvasWorker {
  #promiseLimit!: LimitFunction
  #timeout!: number

  #canvas: OffscreenCanvas | null = null
  #context: OffscreenCanvasRenderingContext2D | null = null
  #clientWidth = 0
  #clientHeight = 0
  #config: WorkerConfiguration | null = null

  #blockWidth = 0
  #blockHeight = 0
  #columns = 0
  #rows = 0

  #pagination = {
    page: 1,
    loading: false,
    hasMore: true,
  }

  #allItems: GridItem[] = []

  #queue = new Queue<() => Promise<void | (() => void)>>()

  get isLoaderMode() {
    return !isUndefined(this.#config?.loader)
  }

  constructor() {
    this.#setupMessageHandler()
    this.#sendMessage(MessageType.Ready, null)
  }

  async #runTask() {
    while (this.#queue.size > 0) {
      const task = this.#queue.dequeue()
      await task()
    }
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
        this.#handleInit(message.payload as SetupPayload, message.id)
        break
      case MessageType.Render:
        this.#handleRender(message.payload as RenderPayload, message.id)
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
    this.#columns = Math.floor(this.#clientWidth / this.#blockWidth)
    this.#rows = Math.floor(this.#clientHeight / this.#blockHeight)
  }

  #handleInit(payload: SetupPayload, from: string): void {
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
      this.#promiseLimit = pLimit(Math.max(DefaultConcurrency, payload.config.core.limit ?? 1))
      this.#timeout = Math.max(DefaultTimeout, payload.config.core.timeout ?? 1000)
      this.#calculateSize()
      this.#allItems = this.#urlToGridItems(this.#config.core.items ?? [])
      this.#addLoadImageTask(this.#config.core.items ?? [])
      this.#sendMessage(MessageType.SetupResponse, null, from)
    } catch (error) {
      this.#sendError(error)
    }
  }

  async #handleRender(payload: RenderPayload, _from: string) {
    if (!this.#context) {
      this.#sendError(new MasonryError('offscreen canvas not initialized or not ready'))
      return
    }
    if (payload.clearBeforeRender) {
      this.#context.clearRect(0, 0, this.#clientWidth, this.#clientHeight)
    }
    // try {
    //   const initialItems = this.isLoaderMode ? [] : (this.#config?.core.items ?? [])
    //   const gridItems = await this.#initGridItems(initialItems)
    //   this.#renderGridItems(gridItems)
    //   this.#sendMessage(MessageType.RenderResponse, null, from)
    // } catch (error) {
    //   this.#sendError(error)
    // }
  }

  #loadImage(url: string): Promise<{ image: HTMLImageElement; url: string }> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        resolve({ image, url })
      }
      image.onerror = (error) => {
        reject(error)
      }
      image.src = url
    })
  }

  #modifyGridItem(url: string, image?: HTMLImageElement) {
    const target = this.#allItems.filter((item) => item.url === url)
    target.forEach((item) => {
      if (image) {
        item.image = image
      }
      item.status = image ? 'loaded' : 'failed'
    })
  }

  #addLoadImageTask(urls: string[]) {
    if (urls.length === 0) {
      return
    }
    const tasks = urls.map((url) => {
      return this.#promiseLimit(() => withTimeout(this.#loadImage(url), this.#timeout))
    })
    this.#queue.enqueue(async () => {
      try {
        const res = await allSettledWithResults(tasks)
        for (let index = 0; index < res.length; index++) {
          const element = res[index]
          if (element.status === 'fulfilled') {
            this.#modifyGridItem(element.value!.url, element.value!.image)
          } else {
            this.#modifyGridItem(element.value!.url, element.value!.image)
            this.#sendError(element.error ?? 'image load failed')
          }
        }
      } catch (error) {
        this.#sendError(error)
      }
    })
  }

  #urlToGridItems(urls: string[]): GridItem[] {
    return urls.map((item) => {
      return {
        id: nanoid(),
        url: item,
        image: null,
        status: 'loading',
        x: 0,
        y: 0,
      }
    })
  }

  async #initGridItems(_initialItems: HTMLImageElement[]): Promise<GridItem[]> {
    if (!this.#config?.core.style) {
      return []
    }
    // const totalCells = this.#columns * this.#rows
    const gridItems: GridItem[] = []
    // let availableItems = [...initialItems]
    // if (this.isLoaderMode) {
    //   while (this.#pagination.hasMore && availableItems.length < totalCells) {
    //     const list = await this.#loadMoreItems()
    //     // this.#allItems.push(...list)
    //     // availableItems = this.#allItems
    //     if (list.length < (this.#config.loader?.pageSize ?? 10)) {
    //       break
    //     }
    //   }
    // }
    // if (availableItems.length > 0 && availableItems.length < totalCells) {
    //   for (let i = availableItems.length; i < totalCells; i++) {
    //     const sourceIndex = i % availableItems.length
    //     availableItems.push(availableItems[sourceIndex])
    //   }
    // }

    // 生成网格项
    // for (let i = 0; i < totalCells; i++) {
    //   const column = i % this.#columns
    //   const row = Math.floor(i / this.#columns)
    //   const x = column * this.#blockWidth
    //   const y = row * this.#blockHeight
    //   let source: string
    //   if (i < availableItems.length) {
    //     source = availableItems[i]
    //   } else {
    //     // const { width, height } = this.#config.core.style
    //     // source = this.#config.placeholderRenderer.render(width, height, i)
    //     source = ''
    //   }
    //   gridItems.push({ image: source, x, y })
    // }
    return gridItems
  }

  async #loadMoreItems(): Promise<string[]> {
    if (!this.#config?.loader || this.#pagination.loading || !this.#pagination.hasMore) {
      return []
    }
    this.#pagination.loading = true
    try {
      const { loadMore, pageSize } = this.#config.loader
      const list = await loadMore(this.#pagination.page, pageSize)
      if (list && list.length > 0) {
        this.#pagination.page++
      }
      if (list.length < pageSize) {
        this.#pagination.hasMore = false
      }
      return list
    } catch (error) {
      this.#sendError(`failed to load more items:${error}`)
      return []
    } finally {
      this.#pagination.loading = false
    }
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

  #renderWithoutRadius(_items: GridItem[], _width: number, _height: number): void {
    // for (const item of items) {
    //   this.#context?.drawImage(item.image, item.x, item.y, width, height)
    // }
  }

  #renderWithRadius(_items: GridItem[], _width: number, _height: number, _radius: number): void {
    // for (const item of items) {
    //   this.#context?.save()
    //   this.#context?.beginPath()
    //   this.#context?.roundRect(item.x, item.y, width, height, radius)
    //   this.#context?.clip()
    //   this.#context?.drawImage(item.image, item.x, item.y, width, height)
    //   this.#context?.restore()
    // }
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
}

new OffscreenCanvasWorker()
