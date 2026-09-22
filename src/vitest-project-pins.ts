import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ResolvedProjectPin } from './browser-pins.ts'
import { resolveVitestPins, type VitestBrowserProjectLike, type VitestProjectPin } from './vitest-pins.ts'

/** Structural subset of Vitest's `Vitest` instance the reader consumes. */
export interface VitestConfigInstanceLike {
  readonly config: { readonly reporters?: readonly unknown[] }
  readonly projects?: readonly VitestBrowserProjectLike[]
  close(): Promise<void>
}

export interface ReadVitestProjectPinsOptions {
  /** Loads the project's evaluated Vitest instance; defaults to the project's own `vitest/node`. */
  load?: (cwd: string) => Promise<VitestConfigInstanceLike>
  /** Warning sink for load failures; defaults to console.warn. */
  warn?: (message: string) => void
}

interface PinDeclaringReporter {
  declaredPinOptions: () => unknown
}

function isPinDeclaringReporter(reporter: unknown): reporter is PinDeclaringReporter {
  if (typeof reporter !== 'object' || reporter === null) return false
  const method: unknown = Reflect.get(reporter, 'declaredPinOptions')
  return typeof method === 'function'
}

/**
 * Collects pin options off the evaluated reporters by duck-typing
 * `declaredPinOptions()` — class identity breaks across duplicate `@crvy/rprtr`
 * copies, and inline reporter instances survive config evaluation intact.
 */
function declaredPinOptions(reporters: readonly unknown[]): { browserPin?: unknown; browserPins?: unknown } {
  const declared: { browserPin?: unknown; browserPins?: unknown } = {}
  for (const reporter of reporters) {
    if (!isPinDeclaringReporter(reporter)) continue
    const options: unknown = Reflect.apply(reporter.declaredPinOptions, reporter, [])
    if (typeof options !== 'object' || options === null) continue
    const browserPin: unknown = Reflect.get(options, 'browserPin')
    const browserPins: unknown = Reflect.get(options, 'browserPins')
    if (declared.browserPin === undefined && browserPin !== undefined) declared.browserPin = browserPin
    if (declared.browserPins === undefined && browserPins !== undefined) declared.browserPins = browserPins
  }
  return declared
}

/**
 * Reader-side mapping: it carries only what `check`/preflight resolve against
 * the installed environment. Provider and endpoint facts collapse into the
 * unverifiable marker, which those surfaces never treat as drift.
 */
function toResolvedProjectPin(project: VitestProjectPin): ResolvedProjectPin {
  const unverifiable =
    (project.provider !== undefined && project.provider !== 'playwright') || project.wsEndpoint !== undefined
  return {
    projectName: project.projectName,
    browser: project.browser,
    ...(project.pin === undefined ? {} : { pin: project.pin }),
    ...(project.channel === undefined ? {} : { channel: project.channel }),
    ...(project.launchExecutablePath === undefined ? {} : { launchExecutablePath: project.launchExecutablePath }),
    ...(unverifiable ? { unverifiable: true } : {}),
  }
}

function mapInstance(instance: VitestConfigInstanceLike): ResolvedProjectPin[] {
  const declared = declaredPinOptions(instance.config?.reporters ?? [])
  const { projects, unmatchedPins } = resolveVitestPins({
    projects: instance.projects ?? [],
    browserPin: declared.browserPin,
    browserPins: declared.browserPins,
  })
  const pins = projects.map(toResolvedProjectPin)
  for (const { key, pin } of unmatchedPins) {
    pins.push({
      projectName: key,
      browser: pin.browser,
      pin,
      invalidReason: `browserPins key "${key}" matches no browser-enabled project in the Vitest config`,
    })
  }
  return pins
}

function isInstanceLike(value: unknown): value is VitestConfigInstanceLike {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'close') === 'function'
}

/**
 * Evaluates the project's own Vitest config and reads the pins its Crvy Rprtr
 * reporter declares. `createVitest` resolves the config and the instance
 * projects without `standalone()`/`init()`, so no browser starts; the instance
 * is always closed. Failures degrade to no pins and one diagnostic — an
 * unresolvable config must never block an unrelated run.
 */
async function loadVitestInstance(cwd: string): Promise<VitestConfigInstanceLike> {
  const req = createRequire(join(cwd, 'package.json'))
  const resolved = req.resolve('vitest/node')
  const module: unknown = await import(pathToFileURL(resolved).href)
  const createVitest: unknown =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'createVitest') : undefined
  if (typeof createVitest !== 'function') {
    throw new Error(`vitest/node at ${resolved} does not export createVitest`)
  }
  const instance: unknown = await Reflect.apply(createVitest, undefined, [
    'test',
    { root: cwd, watch: false, run: true },
  ])
  if (!isInstanceLike(instance)) throw new Error(`createVitest at ${resolved} returned no usable instance`)
  return instance
}

/** Reads the declared browser pins from a Vitest config; [] when unresolvable. */
export async function readVitestProjectPins(
  cwd: string,
  options: ReadVitestProjectPinsOptions = {},
): Promise<ResolvedProjectPin[]> {
  const load = options.load ?? loadVitestInstance
  const warn =
    options.warn ??
    ((message: string): void => {
      console.warn(message)
    })
  let instance: VitestConfigInstanceLike | null = null
  try {
    instance = await load(cwd)
    return mapInstance(instance)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`Could not read browser pins from the Vitest config: ${message}`)
    return []
  } finally {
    if (instance !== null) {
      try {
        await instance.close()
      } catch {
        // Closing is best-effort; pin reading has already settled.
      }
    }
  }
}
