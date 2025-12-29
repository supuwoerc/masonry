import type { GridItem, GridItemStyle } from '../masonry'
import type {
  ErrorDetails,
  ErrorPayload,
  InitPayload,
  PerformanceReport,
  RenderPayload,
  UpdatePositionPayload,
  WorkerMessage,
} from './types'
import { isObject, isString } from 'lodash-es'
import { WorkerErrorCode, WorkerMessageType } from '../constant'

class OffscreenCanvasWorker {
  #canvas: OffscreenCanvas | null = null
  #context: OffscreenCanvasRenderingContext2D | null = null
  #style: GridItemStyle | null = null
  #width = 0
  #height = 0
  #dpr = 1
  #lastRenderTime = 0
  #renderCount = 0
  #fps = 0

  constructor() {
    this.#setupMessageHandler()
  }

  #setupMessageHandler(): void {
    globalThis.onmessage = (event: MessageEvent<WorkerMessage>) => {
      try {
        this.#handleMessage(event.data)
      } catch (error) {
        this.#sendError(
          WorkerErrorCode.InvalidMessage,
          'failed to process message',
          this.#convertErrorToDetails(error),
        )
      }
    }
  }

  #handleMessage(message: WorkerMessage): void {
    switch (message.type) {
      case WorkerMessageType.Init:
        this.#handleInit(message.payload as InitPayload, message.id)
        break
      case WorkerMessageType.Render:
        this.#handleRender(message.payload as RenderPayload, message.id)
        break
      case WorkerMessageType.UpdatePosition:
        this.#handleUpdatePosition(message.payload as UpdatePositionPayload, message.id)
        break
      case WorkerMessageType.Clear:
        this.#handleClear(message.id)
        break
      default:
        this.#sendError(WorkerErrorCode.InvalidMessage, `unknown message type: ${message.type}`)
    }
  }

  #handleInit(payload: InitPayload, messageId?: string): void {
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
      this.#sendResponse(WorkerMessageType.InitResponse, { success: true }, messageId)
    } catch (error) {
      this.#sendError(
        WorkerErrorCode.CanvasNotReady,
        'failed to initialize offscreen canvas',
        this.#convertErrorToDetails(error),
      )
    }
  }

  #handleRender(payload: RenderPayload, messageId?: string): void {
    if (!this.#context || !this.#style) {
      this.#sendError(WorkerErrorCode.CanvasNotReady, 'offscreen canvas not initialized')
      return
    }
    const startTime = performance.now()
    try {
      if (payload.clearBeforeRender !== false) {
        this.#context.clearRect(0, 0, this.#width, this.#height)
      }
      this.#renderItems(payload.items)
      const renderTime = performance.now() - startTime
      this.#updatePerformanceMetrics(renderTime)
      this.#sendResponse(
        WorkerMessageType.RenderResponse,
        {
          success: true,
          renderTime,
          fps: this.#fps,
        },
        messageId,
      )
      this.#sendPerformanceReport(renderTime)
    } catch (error) {
      this.#sendError(
        WorkerErrorCode.RenderFailed,
        'failed to render items',
        this.#convertErrorToDetails(error),
      )
    }
  }

  #handleUpdatePosition(payload: UpdatePositionPayload, messageId?: string): void {
    // 这里可以实现在Worker中计算位置更新，减少主线程负担
    // 目前只是转发响应，实际计算可以在主线程或Worker中完成
    this.#sendResponse(
      WorkerMessageType.UpdatePositionResponse,
      {
        success: true,
        processed: true,
      },
      messageId,
    )
  }

  #handleClear(messageId?: string): void {
    if (this.#context) {
      this.#context.clearRect(0, 0, this.#width, this.#height)
    }
    this.#sendResponse(WorkerMessageType.ClearResponse, { success: true }, messageId)
  }

  #renderItems(items: GridItem[][]): void {
    if (!this.#context || !this.#style || items.length === 0) {
      return
    }
    const { width, height, radius = 0 } = this.#style
    const flatItems = items.flat()
    for (const item of flatItems) {
      if (radius > 0) {
        this.#renderRoundedItem(item, width, height, radius)
      } else {
        this.#context.drawImage(item.source, item.x, item.y, width, height)
      }
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

  #updatePerformanceMetrics(renderTime: number): void {
    this.#renderCount++
    const now = performance.now()
    if (this.#lastRenderTime > 0) {
      const elapsed = now - this.#lastRenderTime
      if (elapsed > 0) {
        this.#fps = Math.round(1000 / elapsed)
      }
    }
    this.#lastRenderTime = now
    if (this.#renderCount % 10 === 0) {
      this.#sendPerformanceReport(renderTime)
    }
  }

  #sendPerformanceReport(renderTime: number): void {
    const report: PerformanceReport = {
      renderTime,
      fps: this.#fps,
      timestamp: Date.now(),
    }
    if ('memory' in (performance as any)) {
      report.memoryUsage = (performance as any).memory.usedJSHeapSize
    }
    this.#sendMessage(WorkerMessageType.PerformanceReport, report)
  }

  #sendResponse<T>(type: WorkerMessageType, payload: T, messageId?: string): void {
    this.#sendMessage(type, payload, messageId)
  }

  #convertErrorToDetails(error: unknown): ErrorDetails {
    if (error instanceof Error) {
      return error
    } else if (isString(error)) {
      return error
    } else if (error && isObject(error)) {
      return error as Record<string, unknown>
    } else {
      return String(error)
    }
  }

  #sendError(code: WorkerErrorCode, message: string, details?: ErrorDetails): void {
    const errorPayload: ErrorPayload = {
      code,
      message,
      details,
    }
    this.#sendMessage(WorkerMessageType.Error, errorPayload)
  }

  #sendMessage<T>(type: WorkerMessageType, payload: T, id?: string): void {
    const message: WorkerMessage<T> = {
      type,
      payload,
      id,
      timestamp: Date.now(),
    }
    globalThis.postMessage(message)
  }
}

// eslint-disable-next-line no-new
new OffscreenCanvasWorker()
