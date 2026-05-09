/**
 * Masonry 布局相关错误类 | Masonry layout related error class
 * @class
 * @extends {Error}
 */
export class MasonryError extends Error {
  /**
   * 创建 Masonry 错误实例 | Create Masonry error instance
   * @param {string} message - 错误描述信息 | Error description message
   * @example
   * throw new MasonryError('Invalid column configuration');
   */
  constructor(message: string) {
    super(message)
    this.name = 'MasonryError'
    Object.setPrototypeOf(this, MasonryError.prototype)
  }
}
