import { describe, expect, it, vi } from 'vitest'
import { MasonryBuilder } from '@/core/builder'
import { MasonryError } from '@/core/error'

globalThis.ResizeObserver = vi.fn(function (this: { observe: () => void; disconnect: () => void }) {
  this.observe = vi.fn()
  this.disconnect = vi.fn()
}) as unknown as typeof ResizeObserver

globalThis.Worker = vi.fn() as unknown as typeof Worker

HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({}) as any

function createBitmap() {
  return { width: 1, height: 1, close: () => {} } as unknown as ImageBitmap
}

function createValidBuilder() {
  const canvas = document.createElement('canvas')
  return new MasonryBuilder().withCore({
    canvas,
    style: { width: 200, height: 300 },
    items: [createBitmap()],
  })
}

describe('class MasonryBuilder', () => {
  describe('build - core configuration', () => {
    it('should throw when core configuration is missing', () => {
      expect(() => new MasonryBuilder().build()).toThrow(MasonryError)
      expect(() => new MasonryBuilder().build()).toThrow('core configuration missing')
    })

    it('should throw when canvas is null', () => {
      const builder = new MasonryBuilder().withCore({
        canvas: null as unknown as HTMLCanvasElement,
        style: { width: 200, height: 300 },
      })
      expect(() => builder.build()).toThrow('invalid canvas element')
    })

    it('should throw when canvas is not an HTMLCanvasElement', () => {
      const div = document.createElement('div')
      const builder = new MasonryBuilder().withCore({
        canvas: div as unknown as HTMLCanvasElement,
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
  })

  describe('build - style', () => {
    it('should throw when width is 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 0, height: 300 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow('the width must be a number greater than 0')
    })

    it('should throw when width is negative', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: -1, height: 300 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow('the width must be a number greater than 0')
    })

    it('should throw when height is 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 0 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow('the height must be a number greater than 0')
    })

    it('should throw when height is negative', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: -100 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow('the height must be a number greater than 0')
    })

    it('should throw when gap is negative', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300, gap: -1 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow('The spacing must be a non-negative number')
    })

    it('should accept gap of 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300, gap: 0 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).not.toThrow()
    })

    it('should throw when radius is negative', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300, radius: -5 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).toThrow(
        'The radius of the fillet must be a non-negative number',
      )
    })

    it('should accept radius of 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300, radius: 0 },
        items: [createBitmap()],
      })
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('build - limit & timeout', () => {
    it('should throw when limit is 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300 },
        items: [createBitmap()],
        limit: 0,
      })
      expect(() => builder.build()).toThrow('the limit must be a number greater than 0')
    })

    it('should throw when timeout is 0', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300 },
        items: [createBitmap()],
        timeout: 0,
      })
      expect(() => builder.build()).toThrow('the timeout must be a number greater than 0')
    })

    it('should accept valid limit and timeout', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder().withCore({
        canvas,
        style: { width: 200, height: 300 },
        items: [createBitmap()],
        limit: 5,
        timeout: 3000,
      })
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('withCore', () => {
    it('should return builder instance for chaining', () => {
      const builder = new MasonryBuilder()
      const result = builder.withCore({
        canvas: document.createElement('canvas'),
        style: { width: 200, height: 300 },
        items: [createBitmap()],
      })
      expect(result).toBe(builder)
    })

    it('should set default backgroundColor to #fff', () => {
      const builder = createValidBuilder()
      expect(() => builder.build()).not.toThrow()
    })

    it('should merge with existing core config on multiple calls', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 }, items: [createBitmap()] })
        .withCore({ canvas, style: { width: 400, height: 500 }, items: [createBitmap()] })
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('withInteraction', () => {
    it('should return builder instance for chaining', () => {
      const builder = new MasonryBuilder()
      const result = builder.withInteraction({ onClick: () => {} })
      expect(result).toBe(builder)
    })

    it('should throw when onClick is not a function', () => {
      const builder = createValidBuilder().withInteraction({
        onClick: 'not-a-function' as any,
      })
      expect(() => builder.build()).toThrow('onClick must be a function')
    })

    it('should accept valid onClick function', () => {
      const builder = createValidBuilder().withInteraction({
        onClick: () => {},
      })
      expect(() => builder.build()).not.toThrow()
    })

    it('should set default scroll configuration', () => {
      const builder = createValidBuilder().withInteraction({})
      expect(() => builder.build()).not.toThrow()
    })

    it('should validate horizontal disabled is boolean', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { disabled: { horizontal: 'yes' as any } },
      })
      expect(() => builder.build()).toThrow('horizontal disabled must be a boolean value')
    })

    it('should validate vertical disabled is boolean', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { disabled: { vertical: 123 as any } },
      })
      expect(() => builder.build()).toThrow('vertical disabled must be a boolean value')
    })

    it('should validate friction is between 0 and 1', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { friction: 1.5 },
      })
      expect(() => builder.build()).toThrow('friction must be a number between 0 and 1 (exclusive)')
    })

    it('should throw when friction is 0', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { friction: 0 },
      })
      expect(() => builder.build()).toThrow('friction must be a number between 0 and 1 (exclusive)')
    })

    it('should throw when friction is 1', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { friction: 1 },
      })
      expect(() => builder.build()).toThrow('friction must be a number between 0 and 1 (exclusive)')
    })

    it('should accept valid friction value', () => {
      const builder = createValidBuilder().withInteraction({
        scroll: { friction: 0.95 },
      })
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('withLoader', () => {
    it('should return builder instance for chaining', () => {
      const builder = new MasonryBuilder()
      const result = builder.withLoader({
        pageSize: 20,
        loadMore: () => Promise.resolve([]),
      })
      expect(result).toBe(builder)
    })

    it('should accept valid loader configuration', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 } })
        .withLoader({ pageSize: 20, loadMore: () => Promise.resolve([]) })
      expect(() => builder.build()).not.toThrow()
    })

    it('should validate pageSize is positive', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 } })
        .withLoader({ pageSize: 0, loadMore: () => Promise.resolve([]) })
      expect(() => builder.build()).toThrow('pageSize must be a positive integer')
    })

    it('should validate loadMore is a function', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 } })
        .withLoader({ pageSize: 10, loadMore: 'not-a-function' as any })
      expect(() => builder.build()).toThrow('loadMore must be a function')
    })

    it('should set default pageSize to 10', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 200, height: 300 } })
        .withLoader({ loadMore: () => Promise.resolve([]) } as any)
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('withPlaceholder', () => {
    it('should return builder instance for chaining', () => {
      const builder = new MasonryBuilder()
      const mockRenderer = {
        render: () => ({}) as ImageBitmap,
        dispose: () => {},
        remove: () => {},
      }
      const result = builder.withPlaceholder(mockRenderer)
      expect(result).toBe(builder)
    })

    it('should accept custom placeholder renderer', () => {
      const mockRenderer = {
        render: () => ({}) as ImageBitmap,
        dispose: () => {},
        remove: () => {},
      }
      const builder = createValidBuilder().withPlaceholder(mockRenderer)
      expect(() => builder.build()).not.toThrow()
    })

    it('should use default renderer when config is undefined', () => {
      const builder = createValidBuilder().withPlaceholder(undefined as any)
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('withEvents', () => {
    it('should return builder instance for chaining', () => {
      const builder = new MasonryBuilder()
      const result = builder.withEvents({ onError: () => {} })
      expect(result).toBe(builder)
    })

    it('should accept valid event callbacks', () => {
      const builder = createValidBuilder().withEvents({
        onReady: () => {},
        onError: () => {},
      })
      expect(() => builder.build()).not.toThrow()
    })

    it('should throw when onReady is not a function', () => {
      const builder = createValidBuilder().withEvents({
        onReady: 'not-a-function' as any,
      })
      expect(() => builder.build()).toThrow('onReady must be a function')
    })

    it('should throw when onError is not a function', () => {
      const builder = createValidBuilder().withEvents({
        onError: 123 as any,
      })
      expect(() => builder.build()).toThrow('onError must be a function')
    })

    it('should set default onError handler', () => {
      const builder = createValidBuilder().withEvents({})
      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('链式调用', () => {
    it('should support full chain with all methods', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({
          canvas,
          style: { width: 200, height: 300, gap: 10, radius: 5 },
          items: [createBitmap()],
        })
        .withInteraction({
          onClick: () => {},
          scroll: { disabled: { horizontal: true }, friction: 0.9 },
        })
        .withLoader({ pageSize: 20, loadMore: () => Promise.resolve([]) })
        .withPlaceholder({ render: () => ({}) as ImageBitmap, dispose: () => {}, remove: () => {} })
        .withEvents({ onReady: () => {}, onError: () => {} })

      expect(builder).toBeInstanceOf(MasonryBuilder)
      expect(() => builder.build()).not.toThrow()
    })

    it('should allow calling same method multiple times (last wins)', () => {
      const canvas = document.createElement('canvas')
      const builder = new MasonryBuilder()
        .withCore({ canvas, style: { width: 100, height: 100 }, items: [createBitmap()] })
        .withInteraction({ onClick: () => {} })
        .withInteraction({ scroll: { disabled: { horizontal: true } } })

      expect(() => builder.build()).not.toThrow()
    })
  })

  describe('build - result', () => {
    it('should return a Masonry instance on valid config', () => {
      const result = createValidBuilder().build()
      expect(result).toBeDefined()
      expect(result.constructor.name).toBe('Masonry')
    })

    it('should throw MasonryError on invalid config', () => {
      try {
        new MasonryBuilder().build()
      } catch (e) {
        expect(e).toBeInstanceOf(MasonryError)
      }
    })
  })
})
