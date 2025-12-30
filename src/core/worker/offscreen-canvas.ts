import type { GridItem, GridItemStyle } from '../types'
import type {
  InitPayload,
  MessagePayload,
  RenderPayload,
  UpdatePositionPayload,
  WorkerMessage,
} from './types'
import { isError, toString } from 'lodash-es'
import { nanoid } from 'nanoid'
import { WorkerMessageType } from '../constant'
import { MasonryError } from '../error'

class OffscreenCanvasWorker {
  #canvas: OffscreenCanvas | null = null
  #context: OffscreenCanvasRenderingContext2D | null = null
  #style: GridItemStyle | null = null
  #width = 0
  #height = 0
  #dpr = 1

  constructor() {
    this.#setupMessageHandler()
  }

  #setupMessageHandler(): void {
    globalThis.onmessage = (event: MessageEvent<WorkerMessage>) => {
      try {
        this.#handleMessage(event.data)
      } catch (error) {
        this.#sendError(error)
      }
    }
  }

  #handleMessage(message: WorkerMessage): void {
    switch (message.type) {
      case WorkerMessageType.Init:
        this.#handleInit(message.payload as InitPayload, message.id)
        break
      case WorkerMessageType.Render:
        this.#handleRender(message.payload as RenderPayload)
        break
      case WorkerMessageType.UpdatePosition:
        this.#handleUpdatePosition(message.payload as UpdatePositionPayload, message.id)
        break
      case WorkerMessageType.Clear:
        this.#handleClear(message.id)
        break
      default:
        throw new MasonryError(`unknown message type: ${message.type}`)
    }
  }

  #handleInit(payload: InitPayload, messageId: string): void {
    try {
      this.#canvas = payload.canvas
      this.#context = this.#canvas.getContext('2d', { alpha: true })!
      this.#style = payload.style
      this.#width = payload.width
      this.#height = payload.height
      this.#dpr = payload.dpr
      this.#context.scale(this.#dpr, this.#dpr)
      this.#context.imageSmoothingEnabled = true
      this.#context.imageSmoothingQuality = 'high'
      this.#sendMessage(WorkerMessageType.InitResponse, null, messageId)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #handleRender(payload: RenderPayload): void {
    if (!this.#context) {
      this.#sendError(new MasonryError('offscreen canvas not initialized'))
      return
    }
    try {
      if (payload.clearBeforeRender) {
        this.#context.clearRect(0, 0, this.#width, this.#height)
      }
      this.#renderItems(payload.items)
    } catch (error) {
      this.#sendError(error)
    }
  }

  #handleUpdatePosition(_payload: UpdatePositionPayload, messageId: string): void {
    this.#sendMessage(WorkerMessageType.UpdatePositionResponse, null, messageId)
  }

  #handleClear(messageId: string): void {
    if (this.#context) {
      this.#context.clearRect(0, 0, this.#width, this.#height)
    }
    this.#sendMessage(WorkerMessageType.ClearResponse, null, messageId)
  }

  #renderItems(items: GridItem[][]): void {
    if (!this.#context || !this.#style || items.length === 0) {
      return
    }
    const { width, height, radius = 0 } = this.#style
    const flatItems = items.flat()
    if (radius > 0) {
      this.#renderWithRadius(flatItems, width, height, radius)
    } else {
      this.#renderWithoutRadius(flatItems, width, height)
    }
  }

  #renderWithoutRadius(items: GridItem[], width: number, height: number): void {
    for (const item of items) {
      this.#context!.drawImage(item.source, item.x, item.y, width, height)
    }
  }

  #renderWithRadius(items: GridItem[], width: number, height: number, radius: number): void {
    for (const item of items) {
      this.#renderRoundedItem(item, width, height, radius)
    }
  }

  #renderRoundedItem(item: GridItem, width: number, height: number, radius: number): void {
    this.#context?.save()
    this.#context?.beginPath()
    this.#context?.roundRect(item.x, item.y, width, height, radius)
    this.#context?.clip()
    this.#context?.drawImage(item.source, item.x, item.y, width, height)
    this.#context?.restore()
  }

  #sendError(error: unknown) {
    const err = isError(error) ? error : new MasonryError(toString(error))
    this.#sendMessage(WorkerMessageType.Error, err, nanoid())
  }

  #sendMessage(type: WorkerMessageType, payload: MessagePayload, id: string): void {
    globalThis.postMessage({
      type,
      payload,
      id,
      timestamp: Date.now(),
    })
  }
}

new OffscreenCanvasWorker()
