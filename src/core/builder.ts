import type { MasonryConfiguration } from './masonry'
import { merge } from 'lodash-es'
import { Validator } from '@/helper/validator'
import { MasonryError } from './error'
import { Masonry } from './masonry'
import { SpinPlaceholderRenderer } from './placeholder/spin-placeholder'
import { configurationRules } from './rules'

/**
 * Masonry 实例构建器，提供链式调用 API
 * Masonry instance builder, provides a fluent chainable API
 *
 * @example
 * ```ts
 * const masonry = new MasonryBuilder()
 *   .withCore({ canvas, style: { width: 200, height: 300 } })
 *   .withInteraction({ onClick: (e) => console.log(e) })
 *   .withLoader({ pageSize: 20, loadMore: fetchImages })
 *   .build()
 * ```
 */
export class MasonryBuilder {
  #config: Partial<MasonryConfiguration> = {}
  #validator = new Validator<MasonryConfiguration>(configurationRules)

  /**
   * 设置核心配置
   * Set core configuration
   * @param config - 核心配置项 | Core configuration options
   * @returns 当前 Builder 实例 | Current builder instance
   */
  withCore(config: MasonryConfiguration['core']) {
    this.#config.core = {
      backgroundColor: '#fff',
      ...(this.#config.core || {}),
      ...config,
    }
    return this
  }

  /**
   * 设置交互配置
   * Set interaction configuration
   * @param config - 交互配置项 | Interaction configuration options
   * @returns 当前 Builder 实例 | Current builder instance
   */
  withInteraction(config: MasonryConfiguration['interaction']) {
    this.#config.interaction = {
      scroll: {
        disabled: { horizontal: false, vertical: false },
        inertia: true,
      },
      ...(this.#config.interaction || {}),
      ...config,
    }
    return this
  }

  /**
   * 设置无限滚动加载配置
   * Set infinite scroll loader configuration
   * @param config - 加载配置项 | Loader configuration options
   * @returns 当前 Builder 实例 | Current builder instance
   */
  withLoader(config: MasonryConfiguration['loader']) {
    this.#config.loader = {
      pageSize: 10,
      loadMore: () => Promise.reject(new MasonryError('loadMore must be a function')),
      ...(this.#config.loader || {}),
      ...config,
    }
    return this
  }

  /**
   * 设置占位符渲染器
   * Set placeholder renderer
   * @param config - 占位符渲染器实例 | Placeholder renderer instance
   * @returns 当前 Builder 实例 | Current builder instance
   */
  withPlaceholder(config: MasonryConfiguration['placeholderRenderer']) {
    this.#config.placeholderRenderer = config ?? new SpinPlaceholderRenderer()
    return this
  }

  /**
   * 设置事件回调
   * Set event callbacks
   * @param config - 事件回调配置 | Event callback configuration
   * @returns 当前 Builder 实例 | Current builder instance
   */
  withEvents(config: MasonryConfiguration['events']) {
    this.#config.events = {
      onError: (e) => console.error(e),
      ...(this.#config.events || {}),
      ...config,
    }
    return this
  }

  /**
   * 构建并返回 Masonry 实例
   * Build and return a Masonry instance
   * @returns Masonry 实例 | Masonry instance
   * @throws {MasonryError} 配置验证失败时抛出 | Throws when configuration validation fails
   */
  build(): Masonry {
    const config = merge({ core: this.#config.core! }, this.#config)
    const { valid, errors } = this.#validator.validate(config)
    if (!valid) {
      throw new MasonryError(errors.join('\n'))
    }
    return new Masonry(config)
  }
}
