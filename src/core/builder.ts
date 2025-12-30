import type { MasonryConfiguration } from './masonry'
import type { GridItemStyle } from './types'
import { merge } from 'lodash-es'
import { Validator } from '@/helper/validator'
import { MasonryError } from './error'
import { Masonry } from './masonry'
import { DefaultPlaceholderRenderer } from './placeholder/default-placeholder'
import { configurationRules } from './rules'

export class MasonryBuilder {
  #config: Partial<MasonryConfiguration> = {}
  #validator = new Validator<MasonryConfiguration>(configurationRules)

  withCore(canvas: HTMLCanvasElement, items: CanvasImageSource[], style: GridItemStyle) {
    this.#config.core = { canvas, items, style }
    return this
  }

  withInteraction(config: MasonryConfiguration['interaction']) {
    this.#config.interaction = {
      disabled: {
        horizontal: false,
        vertical: false,
      },
      ...(this.#config.interaction || {}),
      ...config,
    }
    return this
  }

  withLoader(config: MasonryConfiguration['loader']) {
    this.#config.loader = {
      pageSize: 10,
      loadMore: () => Promise.reject(new MasonryError('loadMore must be a function')),
      ...(this.#config.loader || {}),
      ...config,
    }
    return this
  }

  withPlaceholder(config: MasonryConfiguration['placeholder']) {
    this.#config.placeholder = {
      renderer: new DefaultPlaceholderRenderer({
        backgroundColor: '#f5f5f5',
        borderColor: '#d0d0d0',
        showIndex: false,
      }),
      ...(this.#config.placeholder || {}),
      ...config,
    }
    return this
  }

  withEvents(config: MasonryConfiguration['events']) {
    this.#config.events = {
      onError: (e) => console.error(e),
      ...(this.#config.events || {}),
      ...config,
    }
    return this
  }

  build(): Masonry {
    const config = merge({ core: this.#config.core! }, this.#config)
    const { valid, errors } = this.#validator.validate(config)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    return new Masonry(config)
  }
}
