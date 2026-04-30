import type { LayoutInput, LayoutResult, LayoutStrategy } from '../types'
import type { GridItem } from '../worker/protocol'
import { nanoid } from 'nanoid'

/**
 * 瀑布流布局策略
 * Masonry (waterfall) layout strategy
 *
 * 将项目放入最短列，实现不等高瀑布流排列。
 * 项目高度根据图片宽高比自动计算，未知尺寸时回退为配置的默认高度。
 *
 * Places items into the shortest column, achieving a variable-height waterfall layout.
 * Item height is calculated from image aspect ratio; falls back to configured default height when unknown.
 */
export class MasonryLayout implements LayoutStrategy {
  /**
   * 计算瀑布流布局
   * Calculate masonry (waterfall) layout
   * @param input - 布局输入参数 | Layout input parameters
   * @returns 布局结果 | Layout result
   */
  calculate(input: LayoutInput): LayoutResult {
    const { items, containerWidth, style } = input
    const { width: itemWidth, gap = 0 } = style

    const blockWidth = itemWidth + gap
    const columns = Math.max(1, Math.floor(containerWidth / blockWidth))
    const columnHeights = Array.from<number>({ length: columns }).fill(0)

    const positioned: GridItem[] = items.map((item, index) => {
      const shortestCol = columnHeights.indexOf(Math.min(...columnHeights))
      const x = shortestCol * blockWidth
      const y = columnHeights[shortestCol]

      const itemHeight = this.#resolveItemHeight(item, itemWidth, style.height)
      columnHeights[shortestCol] += itemHeight + gap

      return {
        id: item.id ?? nanoid(),
        image: item.image,
        status: item.status,
        x,
        y,
        width: itemWidth,
        height: itemHeight,
        itemIndex: item.itemIndex ?? index,
      }
    })

    const contentHeight = Math.max(0, Math.max(...columnHeights) - gap)
    const contentWidth = Math.max(0, columns * blockWidth - gap)

    return {
      items: positioned,
      contentWidth,
      contentHeight,
      columns,
    }
  }

  /**
   * 解析项目高度（优先使用宽高比，回退为默认值）
   * Resolve item height (prefer aspect ratio, fallback to default)
   */
  #resolveItemHeight(item: GridItem, targetWidth: number, fallbackHeight: number): number {
    if (item.width && item.height && item.width > 0 && item.height > 0) {
      return Math.round(targetWidth * (item.height / item.width))
    }
    if (item.image && item.image.width > 0 && item.image.height > 0) {
      return Math.round(targetWidth * (item.image.height / item.image.width))
    }
    return fallbackHeight
  }
}
