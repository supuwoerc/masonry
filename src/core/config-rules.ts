import type { Config } from './masonry'
import type { Rule } from '@/helper/validator'
import { isFunction } from 'lodash-es'

export const configRules: Rule<Config>[] = [
  {
    key: 'canvas',
    required: true,
    validate: (canvas) => !!canvas.getContext('2d'),
    message: 'invalid canvas element',
  },
  {
    key: 'items',
    required: true,
    type: 'array',
    message: 'items must be an array',
  },
  {
    key: 'style.width',
    required: true,
    type: 'number',
    validate: (v) => v > 0,
    message: 'width must be > 0',
  },
  {
    key: 'style.height',
    required: true,
    type: 'number',
    validate: (v) => v > 0,
    message: 'height must be > 0',
  },
  {
    key: 'style.gap',
    type: 'number',
    validate: (v) => v >= 0,
    message: 'gap must be >= 0',
    allowEmpty: true,
  },
  {
    key: 'onReady',
    validate: (v) => isFunction(v),
    message: 'onReady must be a function',
    allowEmpty: true,
  },
  {
    key: 'onError',
    validate: (v) => isFunction(v),
    message: 'onError must be a function',
    allowEmpty: true,
  },
]
