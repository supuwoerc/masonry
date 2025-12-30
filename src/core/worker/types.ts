import type { WorkerMessageType } from '../constant'
import type { GridItem, GridItemStyle } from '../types'

export type MessagePayload = InitPayload | RenderPayload | UpdatePositionPayload | Error | null

export interface WorkerMessage<T = MessagePayload> {
  id: string
  type: WorkerMessageType
  payload: T
  timestamp: number
}

export interface InitPayload {
  canvas: OffscreenCanvas
  style: GridItemStyle
  width: number
  height: number
  dpr: number
}

export interface RenderPayload {
  items: GridItem[][]
  clearBeforeRender?: boolean
}

export interface UpdatePositionPayload {
  deltaX: number
  deltaY: number
  disabled: {
    horizontal: boolean
    vertical: boolean
  }
}
