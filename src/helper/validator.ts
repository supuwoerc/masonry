import type { CheckableType } from '@/utils/is'
import { get, isEmpty, isNull, isUndefined } from 'lodash-es'
import { isTargetType } from '@/utils/is'

export interface Rule<T extends object> {
  key: keyof T | (string & {})
  required?: boolean
  type?: CheckableType
  validate?: (value: any, obj: T) => boolean
  message: string
  allowEmpty?: boolean
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
        errors.push(rule.message)
        continue
      }

      if (rule.type && !this.#checkType(value, rule.type)) {
        errors.push(rule.message)
        continue
      }

      if (!rule.allowEmpty && isEmpty(value)) {
        errors.push(rule.message)
        continue
      }

      if (rule.validate && !rule.validate(value, target)) {
        errors.push(rule.message)
      }
    }

    return { valid: errors.length === 0, errors }
  }
}
