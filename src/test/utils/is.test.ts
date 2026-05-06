import { describe, expect, it } from 'vitest'
import { isTargetType } from '@/utils/is'

describe('isTargetType', () => {
  it('should detect string', () => {
    expect(isTargetType('hello', 'string')).toBe(true)
    expect(isTargetType('', 'string')).toBe(true)
    expect(isTargetType(123, 'string')).toBe(false)
  })

  it('should detect number and exclude NaN', () => {
    expect(isTargetType(42, 'number')).toBe(true)
    expect(isTargetType(0, 'number')).toBe(true)
    expect(isTargetType(Number.NaN, 'number')).toBe(false)
    expect(isTargetType('1', 'number')).toBe(false)
  })

  it('should detect boolean', () => {
    expect(isTargetType(true, 'boolean')).toBe(true)
    expect(isTargetType(false, 'boolean')).toBe(true)
    expect(isTargetType(0, 'boolean')).toBe(false)
  })

  it('should detect function', () => {
    expect(isTargetType(() => {}, 'function')).toBe(true)
    // eslint-disable-next-line prefer-arrow-callback
    expect(isTargetType(function () {}, 'function')).toBe(true)
    expect(isTargetType({}, 'function')).toBe(false)
  })

  it('should detect symbol', () => {
    expect(isTargetType(Symbol('test'), 'symbol')).toBe(true)
    expect(isTargetType('symbol', 'symbol')).toBe(false)
  })

  it('should detect bigint', () => {
    expect(isTargetType(BigInt(1), 'bigint')).toBe(true)
    expect(isTargetType(1, 'bigint')).toBe(false)
  })

  it('should detect null', () => {
    expect(isTargetType(null, 'null')).toBe(true)
    expect(isTargetType(undefined, 'null')).toBe(false)
  })

  it('should detect undefined', () => {
    expect(isTargetType(undefined, 'undefined')).toBe(true)
    expect(isTargetType(null, 'undefined')).toBe(false)
  })

  it('should detect array', () => {
    expect(isTargetType([1, 2], 'array')).toBe(true)
    expect(isTargetType([], 'array')).toBe(true)
    expect(isTargetType({}, 'array')).toBe(false)
  })

  it('should detect object (excluding array, date, regexp)', () => {
    expect(isTargetType({}, 'object')).toBe(true)
    expect(isTargetType({ a: 1 }, 'object')).toBe(true)
    expect(isTargetType([], 'object')).toBe(false)
    expect(isTargetType(new Date(), 'object')).toBe(false)
    expect(isTargetType(/test/, 'object')).toBe(false)
  })

  it('should detect plainObject', () => {
    expect(isTargetType({}, 'plainObject')).toBe(true)
    expect(isTargetType(Object.create(null), 'plainObject')).toBe(true)
    expect(isTargetType(new Date(), 'plainObject')).toBe(false)
  })

  it('should detect date', () => {
    expect(isTargetType(new Date(), 'date')).toBe(true)
    expect(isTargetType('2024-01-01', 'date')).toBe(false)
  })

  it('should detect regexp', () => {
    expect(isTargetType(/test/, 'regexp')).toBe(true)
    // eslint-disable-next-line prefer-regex-literals
    expect(isTargetType(new RegExp(''), 'regexp')).toBe(true)
    expect(isTargetType('test', 'regexp')).toBe(false)
  })

  it('should detect map', () => {
    expect(isTargetType(new Map(), 'map')).toBe(true)
    expect(isTargetType({}, 'map')).toBe(false)
  })

  it('should detect set', () => {
    expect(isTargetType(new Set(), 'set')).toBe(true)
    expect(isTargetType([], 'set')).toBe(false)
  })

  it('should throw on unsupported type', () => {
    // @ts-expect-error - testing unsupported type
    expect(() => isTargetType(1, 'unknown')).toThrow('Unsupported type checking: unknown')
  })
})
