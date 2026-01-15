import { SpinPlaceholderRenderer } from './placeholder/spin-placeholder'

export enum RenderStrategy {
  Offscreen,
  HiddenCanvas,
}

export const defaultPlaceholderRenderer = new SpinPlaceholderRenderer({
  backgroundColor: {
    type: 'linear',
    stops: [
      { offset: 0, color: 'hsla(230, 17%, 93%, 1.00)' },
      { offset: 1, color: 'hsla(224, 50%, 90%, 1.00)' },
    ],
  },
})
