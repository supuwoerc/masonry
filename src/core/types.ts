export interface GridItemStyle {
  width: number
  height: number
  radius?: number
  gap?: number
}

export interface GridItem {
  source: CanvasImageSource
  x: number
  y: number
}

export interface ClickEvent {
  item: GridItem
  index: number
  row: number
  column: number
  event: MouseEvent
}

export interface LoadMoreConfig {
  pageSize: number
  loadMore: (page: number, pageSize: number) => Promise<CanvasImageSource[]>
}

export interface PlaceholderRenderer {
  render: (width: number, height: number, index: number) => CanvasImageSource
  dispose?: () => void
}

export interface PlaceholderOptions {
  backgroundColor?: string
  borderColor?: string
  borderWidth?: number
  showIndex?: boolean
  gradient?: boolean
}
