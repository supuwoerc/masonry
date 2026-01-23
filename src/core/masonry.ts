import type { Core, Interaction, LoadMoreConfig, PlaceholderRenderer } from './types'
import type {
  LoadMoreResponsePayload,
  Message,
  MessagePayload,
  ResizePayload,
  SetupPayload,
} from './worker/protocol'
import { debounce, Queue } from '@supuwoerc/toolkit'
import { isFunction } from 'lodash-es'
import { nanoid } from 'nanoid'
import { Validator } from '@/helper/validator'
import { isCanvasSupported, isWorkerSupported } from '@/utils/canvas'
import { defaultPlaceholderRenderer } from './constant'
import { MasonryError } from './error'
import { configurationRules } from './rules'
import { MessageType } from './worker/protocol'
import 'path2d-polyfill'

export interface MasonryConfiguration {
  core: Core

  interaction?: Interaction

  loader?: LoadMoreConfig

  placeholderRenderer?: PlaceholderRenderer

  events?: {
    onReady?: (instance: Masonry) => void
    onError?: (err: unknown) => void
  }
}

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

  onReady: ((ins: Masonry) => void) | null = null

  onError: (e: unknown) => void = (e: unknown) => console.error(e)

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

  async #init() {
    this.#initPlaceholderRenderer(this.#config)
    this.#initEvents(this.#config)
    this.#initObserver()
    if (this.#useWorker) {
      this.#initWorker()
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
        this.onError(`there is an error with your worker:${JSON.stringify(e)}`)
      }
      const payload: SetupPayload = {
        offscreenCanvas,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        config: {
          core: {
            backgroundColor: this.#config.core.backgroundColor,
            items: this.#config.core.items,
            style: this.#config.core.style,
            limit: this.#config.core.limit,
            timeout: this.#config.core.timeout,
          },
        },
        dpr: window.devicePixelRatio || 1,
      }
      if (this.#config.interaction) {
        payload.config.interaction = {
          disabled: {
            horizontal: this.#config.interaction?.disabled?.horizontal,
            vertical: this.#config.interaction?.disabled?.vertical,
          },
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
  }

  #handleLoadMoreTask() {
    this.#queue.enqueue(async () => {
      if (!this.#config?.loader || this.#pagination.loading || !this.#pagination.hasMore) {
        return
      }
      try {
        this.#pagination.loading = true
        const { loadMore, pageSize } = this.#config.loader
        const message: LoadMoreResponsePayload = {
          page: this.#pagination.page,
          hasMore: true,
          data: [],
        }
        const list = await loadMore(this.#pagination.page, pageSize)
        if (list && list.length > 0) {
          this.#pagination.page++
          message.data = list
        }
        if (list.length < pageSize) {
          this.#pagination.hasMore = false
          message.hasMore = false
        }
        this.#sendMessage(MessageType.LoadMoreResponse, message)
      } catch (error) {
        this.onError(`failed to load more items:${error}`)
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

  destroy() {
    if (this.#useWorker && this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
    this.#resizeObserver.disconnect()
    this.#config.placeholderRenderer?.dispose()
  }
}
