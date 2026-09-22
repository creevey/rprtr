import { watch } from 'fs'
import { dirname, resolve, sep } from 'path'

import type { RunContext } from './run-controller.ts'

/** Handle returned by the watch seam; closing it stops events for that root. */
export interface WatchHandle {
  close(): void
}

export type WatchListener = (eventType: string, filename: string | null) => void

/** Minimal `fs.watch` surface; unit tests inject a fake without touching the filesystem. */
export type WatchFn = (path: string, options: { recursive?: boolean }, listener: WatchListener) => WatchHandle

/** Trailing debounce for filesystem change bursts. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 300

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function isIgnoredSegment(segment: string): boolean {
  return IGNORED_SEGMENTS.has(segment) || segment.endsWith('-snapshots') || segment === '__screenshots__'
}

/**
 * Generated-artifact locations never schedule a re-enumeration: dependency,
 * VCS, and build output; runner snapshot directories; and the configured
 * report/screenshot outputs.
 */
function isIgnoredChange(path: string, ignoredPaths: readonly string[]): boolean {
  for (const ignored of ignoredPaths) {
    if (path === ignored || path.startsWith(ignored + sep)) return true
  }
  return path.split(sep).some(isIgnoredSegment)
}

function createRealWatch(): WatchFn {
  return (path, options, listener) => {
    const watcher = watch(path, { recursive: options.recursive === true }, (eventType, filename) => {
      listener(eventType, filename === null ? null : String(filename))
    })
    return {
      close: (): void => {
        watcher.close()
      },
    }
  }
}

interface RootHandle {
  path: string
  recursive: boolean
  handle: WatchHandle
}

export interface TestFileWatcherOptions {
  runContext: RunContext
  /** Called once per debounced change burst under a watched root. */
  onChange: () => void
  /** Absolute files or directories whose changes never schedule a refresh. */
  ignore?: readonly string[]
  debounceMs?: number
  /** Injectable watch seam; defaults to the real `fs.watch`. */
  watch?: WatchFn
  /** Sink for fallback and degradation log lines; defaults to console.warn. */
  log?: (message: string) => void
}

export interface TestFileWatcher {
  /** Replaces the watched directory set with the directories of the latest listing. */
  updateListedFiles(files: readonly string[]): void
  /** Closes every watch handle and cancels scheduled change work. */
  dispose(): void
}

function pathDepth(path: string): number {
  return path.split(sep).length
}

function listDirectories(files: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const dir = dirname(file)
    if (dir !== '' && dir !== '.') dirs.add(dir)
  }
  // Ancestors first, so one pass lets a recursive root cover its descendants.
  return [...dirs].sort((a, b) => pathDepth(a) - pathDepth(b) || a.localeCompare(b))
}

function isCoveredByRecursiveRoot(dir: string, roots: ReadonlyMap<string, RootHandle>): boolean {
  for (const root of roots.values()) {
    if (root.recursive && (dir === root.path || dir.startsWith(root.path + sep))) return true
  }
  return false
}

class FileWatcher implements TestFileWatcher {
  private roots = new Map<string, RootHandle>()
  private readonly ignoredPaths: readonly string[]
  private readonly debounceMs: number
  private readonly watchFn: WatchFn
  private readonly log: (message: string) => void
  private readonly onChange: () => void
  private readonly fixedPaths: ReadonlySet<string>
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private loggedFallback = false
  private loggedUnavailable = false

  constructor(options: TestFileWatcherOptions) {
    this.ignoredPaths = (options.ignore ?? []).map((path) => resolve(path))
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.watchFn = options.watch ?? createRealWatch()
    this.log =
      options.log ??
      ((message): void => {
        console.warn(message)
      })
    this.onChange = options.onChange
    this.fixedPaths = new Set([resolve(options.runContext.configFile), resolve(options.runContext.cwd)])
    this.startFixedRoot(resolve(options.runContext.configFile), 'file')
    this.startFixedRoot(resolve(options.runContext.cwd), 'dir')
  }

  updateListedFiles(files: readonly string[]): void {
    if (this.disposed) return
    const next = new Map<string, RootHandle>()
    for (const [path, root] of this.roots) {
      if (this.fixedPaths.has(path)) next.set(path, root)
    }
    for (const dir of listDirectories(files)) {
      if (isCoveredByRecursiveRoot(dir, next)) continue
      const root = this.roots.get(dir) ?? this.startRoot(dir, true, 'dir')
      if (root !== null) next.set(dir, root)
    }
    for (const [path, root] of this.roots) {
      if (!next.has(path)) root.handle.close()
    }
    this.roots = next
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const root of this.roots.values()) root.handle.close()
    this.roots.clear()
  }

  private startFixedRoot(path: string, kind: 'file' | 'dir'): void {
    const root = this.startRoot(path, false, kind)
    if (root !== null) this.roots.set(path, root)
  }

  private startRoot(path: string, recursive: boolean, kind: 'file' | 'dir'): RootHandle | null {
    const listener: WatchListener = (_eventType, filename) => {
      const changed = kind === 'file' || filename === null ? path : resolve(path, filename)
      if (isIgnoredChange(changed, this.ignoredPaths)) return
      this.schedule()
    }
    if (recursive) {
      try {
        return { path, recursive: true, handle: this.watchFn(path, { recursive: true }, listener) }
      } catch {
        if (!this.loggedFallback) {
          this.loggedFallback = true
          this.log(`[TestFileWatcher] recursive watching unavailable; watching ${path} non-recursively`)
        }
      }
    }
    try {
      return { path, recursive: false, handle: this.watchFn(path, { recursive: false }, listener) }
    } catch {
      if (!this.loggedUnavailable) {
        this.loggedUnavailable = true
        this.log(`[TestFileWatcher] cannot watch ${path}; live discovery stays at its startup state until restart`)
      }
      return null
    }
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onChange()
    }, this.debounceMs)
  }
}

export function createTestFileWatcher(options: TestFileWatcherOptions): TestFileWatcher {
  return new FileWatcher(options)
}
