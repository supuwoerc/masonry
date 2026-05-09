/**
 * @supuwoerc/masonry
 *
 * 基于 Canvas + Web Worker 的高性能图片网格/瀑布流布局库
 * High-performance image grid/masonry layout library based on Canvas + Web Worker
 *
 * @packageDocumentation
 */

export { MasonryBuilder } from '@/core/builder'
export { MasonryError } from '@/core/error'
export { Masonry } from '@/core/masonry'
export type { MasonryConfiguration } from '@/core/masonry'
export { BreathingPlaceholderRenderer } from '@/core/placeholder/breathing-placeholder'
export type { BreathingOptions } from '@/core/placeholder/breathing-placeholder'
export { SpinPlaceholderRenderer } from '@/core/placeholder/spin-placeholder'
export type { PlaceholderOptions } from '@/core/placeholder/spin-placeholder'
export type {
  ClickEvent,
  ColorStop,
  Core,
  GradientBackground,
  GridItemStyle,
  ImageFetcher,
  ImageLoadConfig,
  Interaction,
  ItemDescriptor,
  LayoutMode,
  LayoutUpdateEvent,
  LoadMoreConfig,
  PlaceholderRenderer,
  ScrollConfig,
} from '@/core/types'
export type { GridItem } from '@/core/worker/protocol'
export { StatsMonitor } from '@/helper/stats-monitor'
