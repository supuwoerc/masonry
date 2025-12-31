import type { WorkerConfiguration } from './offscreen-canvas'

export enum MessageType {
  Ready = 'ready',
  Setup = 'setup',
  SetupResponse = 'setup-response',
  Render = 'render',
  RenderResponse = 'render-response',
  Update = 'update',
  UpdateResponse = 'update-response',
  Clear = 'clear',
  ClearResponse = 'clear-reponse',
  Error = 'error',
}

export type MessagePayload = SetupPayload | RenderPayload | UpdatePayload | Error | null

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

export interface GridItem {
  id: string
  url: string
  image: HTMLImageElement | null
  status: 'loading' | 'failed' | 'loaded'
  x: number
  y: number
}

export interface RenderPayload {
  clearBeforeRender?: boolean
}

export interface UpdatePayload {
  deltaX: number
  deltaY: number
  disabled: {
    horizontal: boolean
    vertical: boolean
  }
}
