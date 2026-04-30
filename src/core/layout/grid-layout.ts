import type { LayoutInput, LayoutResult, LayoutStrategy } from '../types'
import type { GridItem } from '../worker/protocol'
import { nanoid } from 'nanoid'

/**
 * 等高网格布局策略
 * Equal-height grid layout strategy
 *
 * 将所有项按固定宽高排列为等间距网格，行列数由容器尺寸自动计算。
 * 当数据项不足以填满网格时，通过 modulo 循环复用。
 *
 * Arranges all items in a uniform grid with fixed width/height.
 * Row and column counts are derived from the container dimensions.
 * When items are fewer than slots, they are cycled via modulo.
 */
export class GridLayout implements LayoutStrategy {
  /**
   * 计算等高网格布局
   * Calculate equal-height grid layout
   * @param input - 布局输入参数 | Layout input parameters
   * @returns 布局结果 | Layout result
   */
  calculate(input: LayoutInput): LayoutResult {
    const { items, containerWidth, style } = input
    const { width: itemWidth, height: itemHeight, gap = 0 } = style

    const blockWidth = itemWidth + gap
    const blockHeight = itemHeight + gap
    const columns = Math.max(1, Math.ceil(containerWidth / blockWidth))

    const positioned: GridItem[] = []

    for (let i = 0; i < items.length; i++) {
      const column = i % columns
      const row = Math.floor(i / columns)
      const x = column * blockWidth
      const y = row * blockHeight
      const source = items[i]

      positioned.push({
        id: source?.id ?? nanoid(),
        image: source?.image ?? null,
        status: source?.status ?? 'loading',
        x,
        y,
        width: itemWidth,
        height: itemHeight,
        itemIndex: source?.itemIndex ?? i,
      })
    }

    const rows = Math.ceil(items.length / columns)
    return {
      items: positioned,
      contentWidth: columns * blockWidth - gap,
      contentHeight: rows * blockHeight - gap,
      columns,
    }
  }
}
