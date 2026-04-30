import type { MasonryConfiguration } from './masonry'
import type { Rule } from '@/helper/validator'
import { isDefined, isFunction } from '@supuwoerc/toolkit'

/**
 * Masonry 配置验证规则集合
 * Masonry configuration validation rules
 */
export const configurationRules: Rule<MasonryConfiguration>[] = [
  {
    key: 'core',
    required: true,
    message: 'core configuration missing',
  },
  {
    key: 'core',
    validate: (core, config) => {
      const hasItems = core.items && core.items.length > 0
      const hasLoader = !!config.loader
      return hasItems || hasLoader
    },
    message: 'either items or loader must be provided',
  },
  {
    key: 'core.canvas',
    required: true,
    validate: (canvas) => canvas instanceof HTMLCanvasElement,
    message: 'invalid canvas element',
  },
  {
    key: 'core.items',
    required: false,
    type: 'array',
    min: 1,
    message: 'items must be an array containing at least one element',
    allowEmpty: true,
  },
  {
    key: 'core.limit',
    required: false,
    type: 'number',
    min: 1,
    message: 'the limit must be a number greater than 0',
    allowEmpty: true,
  },
  {
    key: 'core.timeout',
    required: false,
    type: 'number',
    min: 1,
    message: 'the timeout must be a number greater than 0',
    allowEmpty: true,
  },
  {
    key: 'core.style.width',
    required: true,
    type: 'number',
    min: 1,
    message: 'the width must be a number greater than 0',
  },
  {
    key: 'core.style.height',
    required: true,
    type: 'number',
    min: 1,
    message: 'the height must be a number greater than 0',
  },
  {
    key: 'core.style.gap',
    type: 'number',
    min: 0,
    message: 'The spacing must be a non-negative number',
    allowEmpty: true,
  },
  {
    key: 'core.style.radius',
    type: 'number',
    min: 0,
    message: 'The radius of the fillet must be a non-negative number',
    allowEmpty: true,
  },
  {
    key: 'interaction.onClick',
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onClick must be a function',
    allowEmpty: true,
  },
  {
    key: 'interaction.scroll.disabled.horizontal',
    type: 'boolean',
    message: 'horizontal disabled must be a boolean value',
    allowEmpty: true,
  },
  {
    key: 'interaction.scroll.disabled.vertical',
    type: 'boolean',
    message: 'vertical disabled must be a boolean value',
    allowEmpty: true,
  },
  {
    key: 'loader.pageSize',
    type: 'number',
    min: 1,
    message: 'pageSize must be a positive integer',
  },
  {
    key: 'loader.loadMore',
    validate: (v) => isFunction(v),
    message: 'loadMore must be a function',
  },

  {
    key: 'events.onReady',
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onReady must be a function',
    allowEmpty: true,
  },
  {
    key: 'events.onError',
    validate: (v) => !isDefined(v) || isFunction(v),
    message: 'onError must be a function',
    allowEmpty: true,
  },
]
