import type { WorkerErrorCode, WorkerMessageType } from '../constant'
import type { GridItem, GridItemStyle } from '../masonry'

export interface WorkerMessage<T = unknown> {
  type: WorkerMessageType
  payload: T
  id?: string
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

export type ErrorDetails = string | Error | Record<string, unknown>

export interface ErrorPayload {
  code: WorkerErrorCode
  message: string
  details?: ErrorDetails
}

interface PerformanceMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

export interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory
}

export interface PerformanceReport {
  renderTime: number
  fps: number
  memoryUsage?: number
  timestamp: number
}
