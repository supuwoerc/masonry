import type { WorkerConfiguration } from './offscreen-canvas'

export interface GridItem {
  id: string
  url: string
  image: ImageBitmap
  x: number
  y: number
}

export enum MessageType {
  Setup,
  SetupResponse,
  // Modify,
  // ModifyResponse,
  LoadMore,
  LoadMoreResponse,
  Render,
  RenderResponse,
  Resize,
  // Update,
  // UpdateResponse,
  // Clear,
  // ClearResponse,
  Error,
}

export type MessagePayload =
  | SetupPayload
  | RenderPayload
  | ResizePayload
  | UpdatePayload
  | LoadMorePayload
  | Error
  | null

export interface Message<T = MessagePayload> {
  id: string
  from?: string
  type: MessageType
  payload: T
  timestamp: number
}

export interface SetupPayload {
  offscreenCanvas: OffscreenCanvas
  clientWidth: number
  clientHeight: number
  config: WorkerConfiguration
  dpr: number
}

export interface RenderPayload {
  clearBeforeRender?: boolean
}

export interface ResizePayload {
  clientWidth: number
  clientHeight: number
  dpr: number
}

export interface UpdatePayload {
  deltaX: number
  deltaY: number
  disabled: {
    horizontal: boolean
    vertical: boolean
  }
}

export interface LoadMorePayload {
  page: number
}
