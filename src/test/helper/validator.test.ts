import type { Rule } from '@/helper/validator'
import { describe, expect, it } from 'vitest'
import { Validator } from '@/helper/validator'

interface TestObj {
  name?: string
  age?: number
  tags?: string[]
  email?: string
  role?: string
  nested?: { value: number }
}

describe('class Validator', () => {
  it('should pass when all rules are satisfied', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'name', required: true, type: 'string', message: 'name is required' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ name: 'test' })

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('should fail on required field with undefined value', () => {
    const rules: Rule<TestObj>[] = [{ key: 'name', required: true, message: 'name is required' }]
    const validator = new Validator(rules)
    const result = validator.validate({})

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.required:name is required')
  })

  it('should fail on required field with null value', () => {
    const rules: Rule<TestObj>[] = [{ key: 'name', required: true, message: 'name is required' }]
    const validator = new Validator(rules)
    const result = validator.validate({ name: null as unknown as string })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.required:name is required')
  })

  it('should skip validation when value is undefined and not required', () => {
    const rules: Rule<TestObj>[] = [{ key: 'name', type: 'string', message: 'name must be string' }]
    const validator = new Validator(rules)
    const result = validator.validate({})

    expect(result.valid).toBe(true)
  })

  it('should skip validation when allowEmpty is true and value is empty', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'name', allowEmpty: true, type: 'string', message: 'name must be string' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ name: '' })

    expect(result.valid).toBe(true)
  })

  it('should fail on type mismatch', () => {
    const rules: Rule<TestObj>[] = [{ key: 'age', type: 'string', message: 'age must be string' }]
    const validator = new Validator(rules)
    const result = validator.validate({ age: 18 })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.type:age must be string')
  })

  it('should fail when number is below min', () => {
    const rules: Rule<TestObj>[] = [{ key: 'age', min: 18, message: 'age must be >= 18' }]
    const validator = new Validator(rules)
    const result = validator.validate({ age: 10 })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.min:age must be >= 18')
  })

  it('should fail when array length is below min', () => {
    const rules: Rule<TestObj>[] = [{ key: 'tags', min: 2, message: 'tags need at least 2' }]
    const validator = new Validator(rules)
    const result = validator.validate({ tags: ['one'] })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.min:tags need at least 2')
  })

  it('should fail when number exceeds max', () => {
    const rules: Rule<TestObj>[] = [{ key: 'age', max: 100, message: 'age must be <= 100' }]
    const validator = new Validator(rules)
    const result = validator.validate({ age: 150 })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.max:age must be <= 100')
  })

  it('should fail when array length exceeds max', () => {
    const rules: Rule<TestObj>[] = [{ key: 'tags', max: 2, message: 'tags at most 2' }]
    const validator = new Validator(rules)
    const result = validator.validate({ tags: ['a', 'b', 'c'] })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.max:tags at most 2')
  })

  it('should fail when pattern does not match', () => {
    const rules: Rule<TestObj>[] = [
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      { key: 'email', pattern: /^.+@.+\..+$/, message: 'invalid email' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ email: 'invalid' })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.pattern:invalid email')
  })

  it('should pass when pattern matches', () => {
    const rules: Rule<TestObj>[] = [
      // eslint-disable-next-line regexp/no-super-linear-backtracking
      { key: 'email', pattern: /^.+@.+\..+$/, message: 'invalid email' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ email: 'a@b.com' })

    expect(result.valid).toBe(true)
  })

  it('should fail when value is not in enum', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'role', enum: ['admin', 'user'], message: 'invalid role' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ role: 'guest' })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.enum:invalid role')
  })

  it('should pass when value is in enum', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'role', enum: ['admin', 'user'], message: 'invalid role' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ role: 'admin' })

    expect(result.valid).toBe(true)
  })

  it('should fail on custom validate function', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'age', validate: (v) => v % 2 === 0, message: 'age must be even' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ age: 3 })

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('rule.validate:age must be even')
  })

  it('should support nested path via lodash get', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'nested.value', type: 'number', message: 'nested.value must be number' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({ nested: { value: 42 } })

    expect(result.valid).toBe(true)
  })

  it('should collect multiple errors', () => {
    const rules: Rule<TestObj>[] = [
      { key: 'name', required: true, message: 'name required' },
      { key: 'age', required: true, message: 'age required' },
    ]
    const validator = new Validator(rules)
    const result = validator.validate({})

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(2)
  })
})
