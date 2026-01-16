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

export interface Core {
  canvas: HTMLCanvasElement
  items?: string[] // TODO：扩展支持base64 blob等格式
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
  loadMore: (page: number, pageSize: number) => Promise<string[]> // TODO:扩展支持base64 blob等响应
}

export interface PlaceholderRenderer {
  render: (width: number, height: number, id: string) => ImageBitmap | Promise<ImageBitmap>
  dispose: () => void
  remove: (id: string) => void
}
