import type { Core, Interaction, LoadMoreConfig, PlaceholderRenderer } from './types'
import type { Message, MessagePayload, ResizePayload, SetupPayload } from './worker/protocol'
import { debounce } from '@supuwoerc/toolkit'
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

  #placeholder!: ImageBitmap

  #resizeObserver = new ResizeObserver(() => this.#resize())

  #useWorker = isWorkerSupported()

  #worker: Worker | null = null

  #pagination = {
    page: 1,
    loading: false,
    hasMore: true,
  }

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
    const { width, height } = this.#config.core.style
    const renderer = this.#config.placeholderRenderer ?? defaultPlaceholderRenderer
    this.#placeholder = await renderer.render(width, height)
    if (this.#useWorker) {
      this.#initWorker()
    }
    this.#initEvents(this.#config)
    this.#initObserver()
  }

  async #initWorker() {
    try {
      this.#worker = new Worker(new URL('./worker/offscreen-canvas.ts', import.meta.url), {
        type: 'module',
      })
      const canvas = this.#config.core.canvas
      const offscreenCanvas = canvas.transferControlToOffscreen()
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this)
      this.#worker.onerror = this.onError.bind(this)
      const payload: SetupPayload = {
        offscreenCanvas,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        config: {
          core: {
            items: this.#config.core.items,
            style: this.#config.core.style,
            limit: this.#config.core.limit,
            timeout: this.#config.core.timeout,
          },
          placeholder: this.#placeholder,
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
      this.#sendMessage(MessageType.Setup, payload, [offscreenCanvas, this.#placeholder])
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
        break
      case MessageType.Error:
        this.onError(payload)
        break
      default:
        throw new MasonryError(`unknown message type: ${type}`)
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
      this.onError(`failed to load more items:${error}`)
      return []
    } finally {
      this.#pagination.loading = false
    }
  }

  #resize = debounce(100 / 6, () => {
    const payload: ResizePayload = {
      clientWidth: this.#config.core.canvas.clientWidth,
      clientHeight: this.#config.core.canvas.clientHeight,
      dpr: window.devicePixelRatio || 1,
    }
    this.#sendMessage(MessageType.Resize, payload)
  })

  destroy() {
    if (this.#useWorker && this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
    this.#resizeObserver.disconnect()
  }
}
