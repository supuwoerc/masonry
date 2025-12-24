import {
  isArray,
  isBoolean,
  isDate,
  isFunction,
  isNaN,
  isNull,
  isNumber,
  isObject,
  isPlainObject,
  isRegExp,
  isString,
  isUndefined,
} from 'lodash-es'

// eslint-disable-next-line style/operator-linebreak
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
 * 增强的类型检查函数
 * @param value 要检查的值
 * @param type 目标类型
 * @returns boolean 是否匹配
 */
export function isTargetType(value: any, type: CheckableType): boolean {
  switch (type) {
    // 基础类型
    case 'string':
      return isString(value)
    case 'number':
      return isNumber(value) && !isNaN(value) // 排除 NaN
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
      throw new Error(`不支持的类型检查: ${type}`)
  }
}
