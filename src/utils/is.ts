import { isBoolean, isFunction, isNumber, isObject, isString } from '@supuwoerc/toolkit'
import { isArray, isDate, isNaN, isNull, isPlainObject, isRegExp, isUndefined } from 'lodash-es'

/**
 * 可检测的类型枚举
 * Checkable type enumeration
 */
export type CheckableType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'function'
  | 'date'
  | 'regexp'
  | 'null'
  | 'undefined'
  | 'plainObject'
  | 'map'
  | 'set'
  | 'symbol'
  | 'bigint'

/**
 * 增强的类型检查函数，支持多种 JavaScript 数据类型判断
 * Enhanced type checking function, supports various JavaScript data type detection
 *
 * @param value - 要检查的值 | Value to check
 * @param type - 目标类型 | Target type
 * @returns 是否匹配目标类型 | Whether value matches the target type
 * @throws 当传入不支持的类型时抛出错误 | Throws when unsupported type is provided
 *
 * @example
 * ```ts
 * isTargetType(42, 'number')        // true
 * isTargetType(NaN, 'number')       // false
 * isTargetType([1, 2], 'array')     // true
 * isTargetType({}, 'plainObject')   // true
 * ```
 */
export function isTargetType(value: any, type: CheckableType): boolean {
  switch (type) {
    case 'string':
      return isString(value)
    case 'number':
      return isNumber(value) && !isNaN(value)
    case 'boolean':
      return isBoolean(value)
    case 'function':
      return isFunction(value)
    case 'symbol':
      return typeof value === 'symbol'
    case 'bigint':
      return typeof value === 'bigint'
    case 'null':
      return isNull(value)
    case 'undefined':
      return isUndefined(value)
    case 'array':
      return isArray(value)
    case 'object':
      return isObject(value) && !isArray(value) && !isDate(value) && !isRegExp(value)
    case 'plainObject':
      return isPlainObject(value)
    case 'date':
      return isDate(value)
    case 'regexp':
      return isRegExp(value)
    case 'map':
      return value instanceof Map
    case 'set':
      return value instanceof Set
    default:
      throw new Error(`Unsupported type checking: ${type}`)
  }
}
