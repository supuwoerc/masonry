export enum RenderStrategy {
  Offscreen,
  HiddenCanvas,
}

export enum WorkerMessageType {
  Init,
  InitResponse,
  Render,
  UpdatePosition,
  UpdatePositionResponse,
  Clear,
  ClearResponse,
  Error,
}

export const colorRegExp = {
  hex: /^#([0-9A-F]{3}){1,2}$/i,
  rgb: /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i,
  rgba: /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|1|0?\.\d+)\s*\)$/i,
}
