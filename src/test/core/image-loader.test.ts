import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageLoader } from '@/core/image-loader'

class MockImageBitmap {
  width: number
  height: number
  close = vi.fn()
  constructor(width = 100, height = 100) {
    this.width = width
    this.height = height
  }
}

;(globalThis as any).ImageBitmap = MockImageBitmap

vi.mock('@supuwoerc/toolkit', () => ({
  retry: vi.fn((fn: () => Promise<any>, _options?: any) => {
    return fn()
  }),
  withTimeout: vi.fn((promise: Promise<any>, _timeout: number) => {
    return promise
  }),
}))

let mockLimitFn: ReturnType<typeof vi.fn>
let mockClearQueue: ReturnType<typeof vi.fn>

vi.mock('p-limit', () => ({
  default: vi.fn(() => {
    mockClearQueue = vi.fn()
    mockLimitFn = Object.assign(
      vi.fn((fn: () => Promise<any>) => fn()),
      { clearQueue: mockClearQueue },
    )
    return mockLimitFn
  }),
}))

describe('class ImageLoader', () => {
  let mockBlob: Blob
  let mockBitmap: InstanceType<typeof MockImageBitmap>

  beforeEach(() => {
    mockBlob = new Blob(['fake'], { type: 'image/png' })
    mockBitmap = new MockImageBitmap(100, 100)

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    } as Response)

    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const loader = new ImageLoader()
      expect(loader).toBeInstanceOf(ImageLoader)
    })

    it('should create instance with custom config', () => {
      const loader = new ImageLoader({
        concurrency: 3,
        maxRetries: 5,
        retryDelay: 1000,
        timeout: 5000,
      })
      expect(loader).toBeInstanceOf(ImageLoader)
    })

    it('should use custom fetcher when provided', async () => {
      const customFetcher = vi.fn().mockResolvedValue(mockBlob)
      const loader = new ImageLoader({ fetcher: customFetcher })

      await loader.load('https://example.com/image.png')

      expect(customFetcher).toHaveBeenCalledWith(
        'https://example.com/image.png',
        expect.any(AbortSignal),
      )
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('load', () => {
    it('should load a single image and return ImageBitmap', async () => {
      const loader = new ImageLoader()
      const result = await loader.load('https://example.com/image.png')

      expect(fetch).toHaveBeenCalledWith('https://example.com/image.png', {
        signal: expect.any(AbortSignal),
      })
      expect(createImageBitmap).toHaveBeenCalledWith(mockBlob)
      expect(result).toBe(mockBitmap)
    })

    it('should return ImageBitmap directly if fetcher returns ImageBitmap', async () => {
      const bitmap = new MockImageBitmap(200, 200)
      const customFetcher = vi.fn().mockResolvedValue(bitmap)
      const loader = new ImageLoader({ fetcher: customFetcher })

      const { withTimeout } = await import('@supuwoerc/toolkit')
      vi.mocked(withTimeout).mockResolvedValueOnce(bitmap)

      const result = await loader.load('https://example.com/image.png')

      expect(result).toBe(bitmap)
      expect(createImageBitmap).not.toHaveBeenCalled()
    })

    it('should throw when fetch response is not ok', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)

      const loader = new ImageLoader()

      await expect(loader.load('https://example.com/404.png')).rejects.toThrow(
        'Failed to fetch image: 404',
      )
    })
  })

  describe('loadBatch', () => {
    it('should load multiple images and invoke callback for each', async () => {
      const onLoaded = vi.fn()
      const loader = new ImageLoader()

      const urls = [
        { url: 'https://example.com/1.png', index: 0 },
        { url: 'https://example.com/2.png', index: 1 },
      ]

      await loader.loadBatch(urls, onLoaded)

      expect(onLoaded).toHaveBeenCalledTimes(2)
      expect(onLoaded).toHaveBeenCalledWith(0, mockBitmap, 100, 100)
      expect(onLoaded).toHaveBeenCalledWith(1, mockBitmap, 100, 100)
    })

    it('should use provided width/height instead of bitmap dimensions', async () => {
      const onLoaded = vi.fn()
      const loader = new ImageLoader()

      const urls = [{ url: 'https://example.com/1.png', index: 0, width: 200, height: 300 }]

      await loader.loadBatch(urls, onLoaded)

      expect(onLoaded).toHaveBeenCalledWith(0, mockBitmap, 200, 300)
    })

    it('should silently skip failed items', async () => {
      const { retry } = await import('@supuwoerc/toolkit')
      vi.mocked(retry)
        .mockResolvedValueOnce(mockBitmap)
        .mockRejectedValueOnce(new Error('Network error'))

      const onLoaded = vi.fn()
      const loader = new ImageLoader()

      const urls = [
        { url: 'https://example.com/1.png', index: 0 },
        { url: 'https://example.com/fail.png', index: 1 },
      ]

      await expect(loader.loadBatch(urls, onLoaded)).resolves.toBeUndefined()
      expect(onLoaded).toHaveBeenCalledTimes(1)
      expect(onLoaded).toHaveBeenCalledWith(0, mockBitmap, 100, 100)
    })

    it('should handle empty urls array', async () => {
      const onLoaded = vi.fn()
      const loader = new ImageLoader()

      await loader.loadBatch([], onLoaded)

      expect(onLoaded).not.toHaveBeenCalled()
    })
  })

  describe('dispose', () => {
    it('should abort all pending requests', async () => {
      const loader = new ImageLoader()
      loader.dispose()

      vi.mocked(fetch).mockImplementation((_url, init) => {
        if ((init as RequestInit)?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'))
        }
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(mockBlob) } as Response)
      })

      await expect(loader.load('https://example.com/image.png')).rejects.toThrow()
    })

    it('should clear the concurrency queue', () => {
      const loader = new ImageLoader()
      loader.dispose()

      expect(mockClearQueue).toHaveBeenCalled()
    })
  })
})
