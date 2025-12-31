import type { GridItem } from './worker/types'

export interface GridItemStyle {
  width: number
  height: number
  radius?: number
  gap?: number
}

export interface ClickEvent {
  item: GridItem
  index: number
  row: number
  column: number
  event: MouseEvent
}

export interface Core {
  canvas: HTMLCanvasElement
  items?: string[]
  style: GridItemStyle
  limit?: number
  timeout?: number
}

export interface Interaction {
  onClick?: (event: ClickEvent) => void
  disabled?: {
    horizontal?: boolean
    vertical?: boolean
  }
}

export interface LoadMoreConfig {
  pageSize: number
  loadMore: (page: number, pageSize: number) => Promise<string[]>
}

export interface PlaceholderRenderer {
  render: (width: number, height: number, index: number) => CanvasImageSource
  dispose?: () => void
}
