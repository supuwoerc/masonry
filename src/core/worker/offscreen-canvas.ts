import type { MasonryConfiguration } from '../masonry'
import type { Core, Interaction } from '../types'
import type { GridItem, Message, MessagePayload, RenderPayload, SetupPayload } from './types'
import { Queue } from '@supuwoerc/toolkit'
import { isError, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import { MasonryError } from '../error'
import { MessageType } from './types'

export interface WorkerConfiguration extends Omit<
  MasonryConfiguration,
  'core' | 'interaction' | 'loader' | 'placeholderRenderer' | 'events'
> {
  core: Omit<Core, 'canvas'>
  interaction?: Omit<Interaction, 'onClick'>
}

class OffscreenCanvasWorker {
  #canvas: OffscreenCanvas | null = null
  #context: OffscreenCanvasRenderingContext2D | null = null
  #clientWidth = 0
  #clientHeight = 0
  #config: WorkerConfiguration | null = null

  #blockWidth = 0
  #blockHeight = 0
  #columns = 0
  #rows = 0

  #allItems: GridItem[] = []

  #queue = new Queue<() => Promise<void | (() => void)>>()

  #isRunning = false

  constructor() {
    this.#setupMessageHandler()
    this.#sendMessage(MessageType.Ready, null)
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
      this.#calculateSize()
      const gridItems = this.#urlToGridItems(this.#config.core.items ?? [])
      this.#allItems = gridItems
      this.#sendMessage(MessageType.SetupResponse, null, from)
      this.#sendMessage(
        MessageType.Modify,
        gridItems.map((item) => ({
          id: item.id,
          url: item.url,
        })),
        from,
      )
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

  #modifyGridItem(url: string, image: ImageBitmap) {
    this.#allItems.forEach((item) => {
      if (item.url === url) {
        item.image = image
      }
    })
  }

  #urlToGridItems(urls: string[]): GridItem[] {
    return urls.map((item) => {
      return {
        id: nanoid(),
        url: item,
        image: null,
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
