import type { Core, Interaction, LoadMoreConfig, PlaceholderRenderer } from './types'
import type { Message, MessagePayload, SetupPayload } from './worker/types'
import { isFunction } from 'lodash-es'
import { nanoid } from 'nanoid'
import { Validator } from '@/helper/validator'
import { isCanvasSupported, isWorkerSupported } from '@/utils/canvas'
import { defaultPlaceholderRenderer } from './constant'
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

  onReady: ((ins: Masonry) => void) | null = null

  onError: (e: unknown) => void = (e: unknown) => console.error(e)

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
          ...this.#config,
          core: {
            items: this.#config.core.items,
            style: this.#config.core.style,
          },
          placeholderRenderer: this.#config.placeholderRenderer ?? defaultPlaceholderRenderer,
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

  destroy() {
    if (this.#useWorker && this.#worker) {
      this.#worker.terminate()
      this.#worker = null
    }
  }
}
