import { describe, expect, it } from 'vitest'
import { isFunction } from '@/utils'

describe('isFunction', () => {
  it('returns true for regular, arrow, async, generator and class functions', () => {
    function regular() {}
    const arrow = () => {}
    async function asyncFn() {}
    function* gen() {
      yield 1
    }
    class C {}

    expect(isFunction(regular)).toBe(true)
    expect(isFunction(arrow)).toBe(true)
    expect(isFunction(asyncFn)).toBe(true)
    expect(isFunction(gen)).toBe(true)
    expect(isFunction(C)).toBe(true)
    expect(isFunction(Math.max)).toBe(true)
  })

  it('returns false for primitives and non-callable objects', () => {
    const values = [
      undefined,
      null,
      0,
      123,
      '',
      'str',
      true,
      false,
      Symbol('s'),
      10n,
      {},
      { a: 1 },
      [],
      /a/,
      new Date(),
    ] as unknown[]

    for (const v of values) {
      expect(isFunction(v)).toBe(false)
    }
  })

  it('acts as a type guard allowing calls on the narrowed value', () => {
    const maybeFn: unknown = (x: string) => `hello ${x}`

    if (isFunction(maybeFn)) {
      // compile-time: maybeFn is narrowed to callable type, runtime: works as expected
      const res = maybeFn('world')
      expect(res).toBe('hello world')
    } else {
      throw new Error('Expected maybeFn to be recognized as function')
    }
  })
})
