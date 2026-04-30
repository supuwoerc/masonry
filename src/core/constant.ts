import { BreathingPlaceholderRenderer } from './placeholder/breathing-placeholder'

/**
 * 渲染策略枚举
 * Render strategy enum
 */
export enum RenderStrategy {
  /** 使用 OffscreenCanvas（Web Worker）渲染 | Render using OffscreenCanvas (Web Worker) */
  Offscreen,
  /** 使用隐藏 Canvas 渲染 | Render using hidden Canvas */
  HiddenCanvas,
}

/**
 * 默认占位符渲染器实例（呼吸渐变动画）
 * Default placeholder renderer instance (breathing gradient animation)
 */
export const defaultPlaceholderRenderer = new BreathingPlaceholderRenderer({
  backgroundColor: {
    type: 'linear',
    stops: [
      { offset: 0, color: 'hsla(230, 17%, 93%, 1.00)' },
      { offset: 1, color: 'hsla(224, 50%, 90%, 1.00)' },
    ],
  },
})
