import type { CheckableType } from '@/utils/is'
import { isBoolean, isDefined, isNumber } from '@supuwoerc/toolkit'
import { get, isArray, isEmpty, isNull } from 'lodash-es'
import { isTargetType } from '@/utils/is'

/**
 * 验证规则接口
 * Interface for validation rules
 * @template T - 被验证对象的类型 - Type of the object to validate
 */
export interface Rule<T extends object> {
  /**
   * 属性路径（支持嵌套路径）
   * Property path (supports nested paths)
   */
  key: keyof T | (string & {})

  /**
   * 是否必填
   * Whether the field is required
   * @default false
   */
  required?: boolean

  /**
   * 期望的数据类型
   * Expected data type
   */
  type?: CheckableType

  /**
   * 自定义验证函数
   * Custom validation function
   * @param value - 当前属性值 - Current property value
   * @param obj - 完整对象 - Complete object
   * @returns 是否验证通过 - Whether validation passes
   */
  validate?: (value: any, obj: T) => boolean

  /**
   * 验证失败时的错误信息
   * Error message when validation fails
   */
  message: string

  /**
   * 是否允许空值（空字符串/空数组等）
   * Whether empty values are allowed (empty string/array etc.)
   * @default false
   */
  allowEmpty?: boolean

  /**
   * 最小值（对数字和数组长度有效）
   * Minimum value (for numbers and array length)
   */
  min?: number

  /**
   * 最大值（对数字和数组长度有效）
   * Maximum value (for numbers and array length)
   */
  max?: number

  /**
   * 正则表达式模式
   * Regular expression pattern
   */
  pattern?: RegExp

  /**
   * 允许的值枚举
   * Allowed value enumeration
   */
  enum?: any[]
}

/**
 * 验证结果接口
 * Validation result interface
 */
export interface ValidateResult {
  /**
   * 是否验证通过
   * Whether validation passed
   */
  valid: boolean

  /**
   * 错误信息列表
   * List of error messages
   */
  errors: string[]
}

/**
 * 通用验证器类
 * Generic validator class
 * @template T - 被验证对象的类型 - Type of the object to validate
 */
export class Validator<T extends object> {
  /**
   * 创建验证器实例
   * Create validator instance
   * @param rules 验证规则数组 - Array of validation rules
   */
  constructor(private rules: Rule<T>[]) {}

  /**
   * 类型检查私有方法
   * Private type checking method
   * @param value 要检查的值 - Value to check
   * @param type 期望的类型 - Expected type
   * @returns 是否类型匹配 - Whether type matches
   */
  #checkType(value: any, type: CheckableType) {
    return isTargetType(value, type)
  }

  /**
   * 执行验证
   * Perform validation
   * @param target 需要验证的对象 - Object to validate
   * @returns 验证结果 - Validation result
   */
  validate(target: T): ValidateResult {
    const errors: string[] = []
    for (const rule of this.rules) {
      const value = get(target, rule.key)
      if (rule.required && (!isDefined(value) || isNull(value))) {
        errors.push(`rule.required:${rule.message}`)
        continue
      }
      if (
        !isDefined(value) ||
        isNull(value) ||
        (rule.allowEmpty && !isNumber(value) && !isBoolean(value) && isEmpty(value))
      ) {
        continue
      }
      if (rule.type && !this.#checkType(value, rule.type)) {
        errors.push(`rule.type:${rule.message}`)
        continue
      }
      if (rule.min !== undefined) {
        if (isNumber(value) && value < rule.min) {
          errors.push(`rule.min:${rule.message}`)
          continue
        }
        if (isArray(value) && value.length < rule.min) {
          errors.push(`rule.min:${rule.message}`)
          continue
        }
      }
      if (rule.max !== undefined) {
        if (isNumber(value) && value > rule.max) {
          errors.push(`rule.max:${rule.message}`)
          continue
        }
        if (isArray(value) && value.length > rule.max) {
          errors.push(`rule.max:${rule.message}`)
          continue
        }
      }
      if (rule.pattern && !rule.pattern.test(String(value))) {
        errors.push(`rule.pattern:${rule.message}`)
        continue
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`rule.enum:${rule.message}`)
        continue
      }
      if (rule.validate && !rule.validate(value, target)) {
        errors.push(`rule.validate:${rule.message}`)
      }
    }
    return { valid: errors.length === 0, errors }
  }
}
