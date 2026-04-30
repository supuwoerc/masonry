import { describe, expect, it, vi } from 'vitest'
import { MasonryBuilder } from '@/core/builder'
import { MasonryError } from '@/core/error'

globalThis.ResizeObserver = vi.fn(function (this: { observe: () => void; disconnect: () => void }) {
  this.observe = vi.fn()
  this.disconnect = vi.fn()
}) as unknown as typeof ResizeObserver

globalThis.Worker = vi.fn() as unknown as typeof Worker

HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({}) as any

describe('masonry builder', () => {
  it('should throw on missing core configuration', () => {
    expect(() => new MasonryBuilder().build()).toThrow(MasonryError)
    expect(() => new MasonryBuilder().build()).toThrow('core configuration missing')
  })

  it('should throw on invalid canvas', () => {
    const builder = new MasonryBuilder().withCore({
      canvas: null as unknown as HTMLCanvasElement,
      style: { width: 200, height: 300 },
    })
    expect(() => builder.build()).toThrow('invalid canvas element')
  })

  it('should throw when both items and loader are missing', () => {
    const canvas = document.createElement('canvas')
    const builder = new MasonryBuilder().withCore({
      canvas,
      style: { width: 200, height: 300 },
    })
    expect(() => builder.build()).toThrow('either items or loader must be provided')
  })

  it('should accept valid configuration with items', () => {
    const canvas = document.createElement('canvas')
    const bitmap = { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap

    expect(() =>
      new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 }, items: [bitmap] })
        .build(),
    ).not.toThrow()
  })

  it('should validate width and height', () => {
    const canvas = document.createElement('canvas')
    const bitmap = { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap

    expect(() =>
      new MasonryBuilder()
        .withCore({ canvas, style: { width: 0, height: 300 }, items: [bitmap] })
        .build(),
    ).toThrow('the width must be a number greater than 0')
  })

  it('should validate interaction onClick is a function', () => {
    const canvas = document.createElement('canvas')
    const bitmap = { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap

    expect(() =>
      new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 }, items: [bitmap] })
        .withInteraction({ onClick: 'not-a-function' } as any)
        .build(),
    ).toThrow('onClick must be a function')
  })

  it('should chain builder methods', () => {
    const canvas = document.createElement('canvas')
    const bitmap = { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap

    const builder = new MasonryBuilder()
      .withCore({ canvas, style: { width: 200, height: 300, gap: 10, radius: 5 }, items: [bitmap] })
      .withInteraction({ scroll: { disabled: { horizontal: true } } })
      .withEvents({ onError: () => {}, onReady: () => {} })

    expect(builder).toBeInstanceOf(MasonryBuilder)
    expect(() => builder.build()).not.toThrow()
  })
})
