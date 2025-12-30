import type { CheckableType } from '@/utils/is'
import { get, isArray, isEmpty, isNull, isNumber, isUndefined } from 'lodash-es'
import { colorRegExp } from '@/core/constant'
import { isTargetType } from '@/utils/is'

export interface Rule<T extends object> {
  key: keyof T | (string & {})
  required?: boolean
  type?: CheckableType
  validate?: (value: any, obj: T) => boolean
  message: string
  allowEmpty?: boolean
  min?: number // number array
  max?: number // number array
  pattern?: RegExp
  enum?: any[]
  colorFormat?: 'hex' | 'rgb' | 'rgba'
}

export interface ValidateResult {
  valid: boolean
  errors: string[]
}

export class Validator<T extends object> {
  constructor(private rules: Rule<T>[]) {}

  #checkType(value: any, type: CheckableType) {
    return isTargetType(value, type)
  }

  /**
   * 执行校验
   * @param target 待校验对象
   */
  validate(target: T): ValidateResult {
    const errors: string[] = []

    for (const rule of this.rules) {
      const value = get(target, rule.key)
      if (rule.required && (isUndefined(value) || isNull(value))) {
        errors.push(`rule.required:${rule.message}`)
        continue
      }
      if (isUndefined(value) || isNull(value) || (rule.allowEmpty && isEmpty(value))) {
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
      if (rule.colorFormat) {
        if (!colorRegExp[rule.colorFormat].test(String(value))) {
          errors.push(`rule.colorFormat:${rule.message}`)
          continue
        }
      }
      if (rule.validate && !rule.validate(value, target)) {
        errors.push(`rule.validate:${rule.message}`)
      }
    }
    return { valid: errors.length === 0, errors }
  }
}
