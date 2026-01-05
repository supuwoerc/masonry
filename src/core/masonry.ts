import type { LimitFunction } from 'p-limit'
import type { Core, Interaction, LoadMoreConfig, PlaceholderRenderer } from './types'
import type {
  Message,
  MessagePayload,
  ModifyPayload,
  ModifyResponseItem,
  SetupPayload,
} from './worker/types'
import { allSettledWithResults, Queue, withTimeout } from '@supuwoerc/toolkit'
import { isFunction, isUndefined } from 'lodash-es'
import { nanoid } from 'nanoid'
import pLimit from 'p-limit'
import { Validator } from '@/helper/validator'
import { isCanvasSupported, isWorkerSupported } from '@/utils/canvas'
import { DefaultConcurrency, DefaultTimeout } from './constant'
import { MasonryError } from './error'
import { configurationRules } from './rules'
import { MessageType } from './worker/types'
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

  #useWorker = isWorkerSupported()

  #worker: Worker | null = null

  #queue = new Queue<() => Promise<void | (() => void)>>()

  #isRunning = false

  #promiseLimit!: LimitFunction

  #timeout = DefaultTimeout

  #pagination = {
    page: 1,
    loading: false,
    hasMore: true,
  }

  onReady: ((ins: Masonry) => void) | null = null

  onError: (e: unknown) => void = (e: unknown) => console.error(e)

  get isLoaderMode() {
    return !isUndefined(this.#config?.loader)
  }

  constructor(config: MasonryConfiguration) {
    if (!isCanvasSupported()) {
      throw new MasonryError('The current environment does not support the canvas API')
    }
    const { valid, errors } = this.#validator.validate(config)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    this.#config = config
    this.#init()
  }

  #init() {
    this.#promiseLimit = pLimit(Math.max(DefaultConcurrency, this.#config.core.limit ?? 1))
    this.#timeout = Math.max(DefaultTimeout, this.#config.core.timeout ?? 1000)
    if (this.#useWorker) {
      this.#initWorker()
    }
    this.#initEvents(this.#config)
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
          },
          interaction: {
            disabled: {
              horizontal: this.#config.interaction?.disabled?.horizontal,
              vertical: this.#config.interaction?.disabled?.vertical,
            },
          },
        },
        dpr: window.devicePixelRatio || 1,
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
        this.#sendMessage(MessageType.Render, {
          clearBeforeRender: true,
        })
        this.onReady?.(this)
        break
      case MessageType.Modify:
        this.#addLoadImageTask(payload as ModifyPayload)
        this.#runTask()
        break
      case MessageType.Error:
        this.onError(payload)
        break
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

  #loadImage(url: string, id: string): Promise<{ image: ImageBitmap; id: string }> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = async () => {
        const bitmap = await createImageBitmap(image)
        resolve({ image: bitmap, id })
      }
      image.onerror = (error) => {
        reject(error)
      }
      image.src = url
    })
  }

  #addLoadImageTask(payload: ModifyPayload) {
    if (payload.length === 0) {
      return
    }
    this.#queue.enqueue(async () => {
      try {
        const res = await allSettledWithResults(
          payload.map(({ id, url }) => {
            return this.#promiseLimit(() =>
              withTimeout(
                this.#loadImage(url, id),
                this.#timeout,
                new MasonryError(`load image ${url} timeout`),
              ),
            )
          }),
        )
        for (let index = 0; index < res.length; index++) {
          const element = res[index]
          if (element.status === 'fulfilled' && element.value?.image) {
            const payload: ModifyResponseItem = {
              id: element.value.id,
              url: '',
              image: element.value.image,
            }
            this.#sendMessage(MessageType.ModifyResponse, [payload], [payload.image])
          } else {
            this.onError(element.error ?? 'image load failed')
          }
        }
      } catch (error) {
        this.onError(error)
      }
    })
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

  destroy() {
    if (this.#useWorker && this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
  }
}
