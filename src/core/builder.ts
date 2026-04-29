import type { MasonryConfiguration } from './masonry'
import { merge } from 'lodash-es'
import { Validator } from '@/helper/validator'
import { MasonryError } from './error'
import { Masonry } from './masonry'
import { SpinPlaceholderRenderer } from './placeholder/spin-placeholder'
import { configurationRules } from './rules'

export class MasonryBuilder {
  #config: Partial<MasonryConfiguration> = {}
  #validator = new Validator<MasonryConfiguration>(configurationRules)

  withCore(config: MasonryConfiguration['core']) {
    this.#config.core = {
      backgroundColor: '#fff',
      ...(this.#config.core || {}),
      ...config,
    }
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

  withPlaceholder(config: MasonryConfiguration['placeholderRenderer']) {
    this.#config.placeholderRenderer = config ?? new SpinPlaceholderRenderer()
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
