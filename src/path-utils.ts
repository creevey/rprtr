const posixAbsolutePattern = /^\//u
const windowsDrivePattern = /^[A-Za-z]:[\\/]/u
const windowsUncPattern = /^[\\/][\\/]/u

function isPosixAbsolutePath(p: string): boolean {
  return posixAbsolutePattern.test(p)
}

function isWindowsAbsolutePath(p: string): boolean {
  return windowsDrivePattern.test(p) || windowsUncPattern.test(p)
}

export function isAnyAbsolutePath(p: string): boolean {
  return isPosixAbsolutePath(p) || isWindowsAbsolutePath(p)
}

export function isForeignAbsolutePath(p: string, hostPlatform: NodeJS.Platform): boolean {
  if (!isAnyAbsolutePath(p)) return false
  if (hostPlatform === 'win32') return !isWindowsAbsolutePath(p)
  return !isPosixAbsolutePath(p)
}
