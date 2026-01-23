import type { GridItem } from './worker/protocol'

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

export interface ColorStop {
  offset: number
  color: string
}

export interface GradientBackground {
  type: 'linear' | 'radial'
  stops: ColorStop[]
  linear?: {
    start: [number, number]
    end: [number, number]
  }
  radial?: {
    start: [number, number]
    end: [number, number]
    r0: number
    r1: number
  }
}

export interface Core {
  canvas: HTMLCanvasElement
  backgroundColor?: string | GradientBackground
  items?: ImageBitmap[]
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
  loadMore: (page: number, pageSize: number) => Promise<ImageBitmap[]>
}

export interface PlaceholderRenderer {
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  dispose: () => void
  remove: (id: string) => void
}
