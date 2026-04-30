import type { ImageFetcher, ImageLoadConfig } from './types'
import { retry, withTimeout } from '@supuwoerc/toolkit'
import pLimit from 'p-limit'

/**
 * 图片加载器，支持并发控制、超时、重试和自定义请求函数
 * Image loader with concurrency control, timeout, retry, and custom fetcher support
 */
export class ImageLoader {
  #limit: ReturnType<typeof pLimit>
  #maxRetries: number
  #retryDelay: number
  #timeout: number
  #fetcher: ImageFetcher
  #abortController = new AbortController()

  constructor(config?: ImageLoadConfig) {
    this.#limit = pLimit(config?.concurrency ?? 6)
    this.#maxRetries = config?.maxRetries ?? 3
    this.#retryDelay = config?.retryDelay ?? 500
    this.#timeout = config?.timeout ?? 10000
    this.#fetcher = config?.fetcher ?? this.#defaultFetcher
  }

  /**
   * 加载单张图片（带并发控制和重试）
   * Load a single image (with concurrency control and retry)
   */
  async load(url: string): Promise<ImageBitmap> {
    return this.#limit(() => this.#loadWithRetry(url))
  }

  /**
   * 批量加载图片
   * Load multiple images in batch
   */
  async loadBatch(
    urls: Array<{ url: string; index: number; width?: number; height?: number }>,
    onLoaded: (index: number, bitmap: ImageBitmap, width: number, height: number) => void,
  ): Promise<void> {
    const tasks = urls.map(({ url, index, width, height }) => {
      return this.#limit(async () => {
        try {
          const bitmap = await this.#loadWithRetry(url)
          onLoaded(index, bitmap, width ?? bitmap.width, height ?? bitmap.height)
        } catch {
          // 加载失败静默跳过，item 保持 loading 状态
        }
      })
    })
    await Promise.all(tasks)
  }

  /**
   * 取消所有进行中的加载
   * Cancel all in-progress loads
   */
  dispose() {
    this.#abortController.abort()
    this.#limit.clearQueue()
  }

  async #loadWithRetry(url: string): Promise<ImageBitmap> {
    return retry(() => this.#fetchWithTimeout(url), {
      maxAttempts: this.#maxRetries + 1,
      delayMs: this.#retryDelay,
      backoffFactor: 2,
      shouldRetry: () => !this.#abortController.signal.aborted,
    })
  }

  async #fetchWithTimeout(url: string): Promise<ImageBitmap> {
    const result = await withTimeout(
      this.#fetcher(url, this.#abortController.signal),
      this.#timeout,
    )
    if (result instanceof ImageBitmap) {
      return result
    }
    return await createImageBitmap(result)
  }

  #defaultFetcher: ImageFetcher = async (url, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`)
    }
    return await response.blob()
  }
}
