export enum RenderStrategy {
  Offscreen,
  HiddenCanvas,
  Direct,
}

export enum WorkerMessageType {
  Init,
  InitResponse,
  Render,
  RenderResponse,
  UpdatePosition,
  UpdatePositionResponse,
  Clear,
  ClearResponse,
  Error,
  PerformanceReport,
}

export enum WorkerErrorCode {
  CanvasNotReady,
  RenderFailed,
  InvalidMessage,
  TransferFailed,
}
