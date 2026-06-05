const isDebug = (): boolean => process.env.DEBUG !== undefined && process.env.DEBUG !== ''
export const log = (...args: unknown[]): void => {
  if (isDebug()) console.log(...args)
}
export const logError = (...args: unknown[]): void => {
  if (isDebug()) console.error(...args)
}
