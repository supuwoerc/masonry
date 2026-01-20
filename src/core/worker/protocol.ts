import type { WorkerConfiguration } from './offscreen-canvas'

export interface GridItem {
  id: string
  image: ImageBitmap | null
  status: 'loading' | 'loaded'
  x: number
  y: number
}

export enum MessageType {
  Setup,
  SetupResponse,
  LoadMore,
  LoadMoreResponse,
  Render,
  RenderLoading,
  RenderLoadingResponse,
  Resize,
  RemoveLoading,
  Error,
}

export type RequestPayload = SetupPayload | ResizePayload | Array<string> | string

export type ResponsePayload = RenderLoadingResponsePayload | Error | null | LoadMoreResponsePayload

export type MessagePayload = RequestPayload | ResponsePayload

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

export interface LoadMoreResponsePayload {
  page: number
  hasMore: boolean
  data: Array<ImageBitmap>
}

export interface ResizePayload {
  clientWidth: number
  clientHeight: number
  dpr: number
}

export interface RenderLoadingResponsePayload {
  id: string
  bitmap: ImageBitmap
}
