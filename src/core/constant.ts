import { DefaultPlaceholderRenderer } from './placeholder/default-placeholder'

export enum RenderStrategy {
  Offscreen,
  HiddenCanvas,
}

export const defaultPlaceholderRenderer = new DefaultPlaceholderRenderer({
  backgroundColor: '#f5f5f5',
  borderColor: 'red',
  showIndex: false,
})
