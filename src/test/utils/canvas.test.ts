import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCanvasSupported, isOffscreenCanvasSupported, isWorkerSupported } from '@/utils/canvas'

describe('isCanvasSupported', () => {
  let originalHTMLCanvasElement: typeof HTMLCanvasElement

  beforeEach(() => {
    originalHTMLCanvasElement = globalThis.HTMLCanvasElement
  })

  afterEach(() => {
    globalThis.HTMLCanvasElement = originalHTMLCanvasElement
    vi.restoreAllMocks()
  })

  it('should return true when Canvas is supported', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockReturnValue({}),
    } as unknown as HTMLCanvasElement)

    expect(isCanvasSupported()).toBe(true)
  })

  it('should return false when HTMLCanvasElement is undefined', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement')
    // @ts-expect-error - simulating environment without Canvas
    globalThis.HTMLCanvasElement = undefined

    expect(isCanvasSupported()).toBe(false)

    if (descriptor) {
      Object.defineProperty(globalThis, 'HTMLCanvasElement', descriptor)
    }
  })

  it('should return false when getContext returns null', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockReturnValue(null),
    } as unknown as HTMLCanvasElement)

    expect(isCanvasSupported()).toBe(false)
  })
})

describe('isWorkerSupported', () => {
  let originalWorker: typeof Worker
  let originalWindow: typeof window

  beforeEach(() => {
    originalWorker = globalThis.Worker
    originalWindow = globalThis.window
  })

  afterEach(() => {
    globalThis.Worker = originalWorker
    globalThis.window = originalWindow
    vi.restoreAllMocks()
  })

  it('should return true when Worker is supported', () => {
    // eslint-disable-next-line prefer-arrow-callback
    globalThis.Worker = vi.fn(function () {
      return { terminate: vi.fn() }
    }) as unknown as typeof Worker
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    expect(isWorkerSupported()).toBe(true)
  })

  it('should return false when window is undefined', () => {
    // @ts-expect-error - simulating environment without window
    globalThis.window = undefined

    expect(isWorkerSupported()).toBe(false)
  })

  it('should return false when Worker is undefined', () => {
    // @ts-expect-error - simulating environment without Worker
    globalThis.Worker = undefined

    expect(isWorkerSupported()).toBe(false)
  })

  it('should return false when Worker constructor throws', () => {
    globalThis.Worker = vi.fn(() => {
      throw new Error('Worker not supported')
    }) as unknown as typeof Worker

    expect(isWorkerSupported()).toBe(false)
  })
})

describe('isOffscreenCanvasSupported', () => {
  let originalHTMLCanvasElement: typeof HTMLCanvasElement
  let originalOffscreenCanvas: typeof OffscreenCanvas

  beforeEach(() => {
    originalHTMLCanvasElement = globalThis.HTMLCanvasElement
    originalOffscreenCanvas = globalThis.OffscreenCanvas
  })

  afterEach(() => {
    globalThis.HTMLCanvasElement = originalHTMLCanvasElement
    globalThis.OffscreenCanvas = originalOffscreenCanvas
    vi.restoreAllMocks()
  })

  it('should return true when OffscreenCanvas is supported', () => {
    const mockOffscreen = {}
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn().mockReturnValue(mockOffscreen)
    globalThis.OffscreenCanvas = vi.fn() as unknown as typeof OffscreenCanvas
    vi.spyOn(document, 'createElement').mockReturnValue({
      transferControlToOffscreen: vi.fn().mockReturnValue(mockOffscreen),
    } as unknown as HTMLCanvasElement)

    expect(isOffscreenCanvasSupported()).toBe(true)
  })

  it('should return false when HTMLCanvasElement is undefined', () => {
    // @ts-expect-error - simulating environment without Canvas
    globalThis.HTMLCanvasElement = undefined

    expect(isOffscreenCanvasSupported()).toBe(false)
  })

  it('should return false when transferControlToOffscreen is not a function', () => {
    // @ts-expect-error - simulating missing method
    HTMLCanvasElement.prototype.transferControlToOffscreen = undefined

    expect(isOffscreenCanvasSupported()).toBe(false)
  })

  it('should return false when transferControlToOffscreen throws', () => {
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn()
    vi.spyOn(document, 'createElement').mockReturnValue({
      transferControlToOffscreen: vi.fn(() => {
        throw new Error('not supported')
      }),
    } as unknown as HTMLCanvasElement)

    expect(isOffscreenCanvasSupported()).toBe(false)
  })

  it('should return false when OffscreenCanvas is undefined', () => {
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn()
    vi.spyOn(document, 'createElement').mockReturnValue({
      transferControlToOffscreen: vi.fn().mockReturnValue({}),
    } as unknown as HTMLCanvasElement)
    // @ts-expect-error - simulating environment without OffscreenCanvas
    globalThis.OffscreenCanvas = undefined

    expect(isOffscreenCanvasSupported()).toBe(false)
  })
})
