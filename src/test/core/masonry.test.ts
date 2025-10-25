import { describe, expect, it } from 'vitest'
import Masonry from '@/core/masonry'

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

(globalThis as any).Image = class {
  onload: ((ev: Event) => any) | null = null
  onerror: ((ev: Event) => any) | null = null
  private _src = ''
  set src(val: string) {
    this._src = val
    setTimeout(() => {
      if (this.onload) {
        this.onload(new Event('load'))
      }
    }, 0)
  }

  get src() {
    return this._src
  }
} as unknown as { new (): HTMLImageElement }

function createCanvas(width = 200, height = 200) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  Object.defineProperty(canvas, 'clientWidth', { value: width })
  Object.defineProperty(canvas, 'clientHeight', { value: height });
  (canvas as any).getContext = (type: string) => {
    if (type !== '2d') {
      return null
    }
    const ctx: unknown = {
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
      fillRect: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      measureText: () => ({ width: 0 }),
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
      rotate: () => {},
    }
    return ctx as Partial<CanvasRenderingContext2D>
  }
  return canvas
}

const tinyPng
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AApMBg6m7XHsAAAAASUVORK5CYII='

describe('masonry constructor', () => {
  it('initializes and calls onReady', async () => {
    const canvas = createCanvas(300, 300)

    const ready = new Promise<void>((resolve, reject) => {
      try {
        let instance: Masonry | null = null
        instance = new Masonry({
          canvas,
          items: [tinyPng, tinyPng, tinyPng],
          itemWidth: 50,
          itemHeight: 50,
          style: { width: 50, height: 50 },
          onReady: () => {
            // ensure instance is cleaned up and satisfy eslint no-new
            instance?.destroy()
            resolve()
          },
          onError: (e) => {
            instance?.destroy()
            reject(e)
          },
        })
      } catch (e) {
        reject(e)
      }
    })

    await expect(ready).resolves.toBeUndefined()
  })
})
