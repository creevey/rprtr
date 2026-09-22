import { join } from 'path'

import type { RunEnvironments } from '../browser-pins.ts'
import type { TestData } from '../types.ts'
import { handleApiApprove, handleApiApproveAll } from './approval.ts'
import { handleArtifactRoute } from './artifact-routes.ts'
import type { ContainerPathMapping } from './docker-support.ts'
import { respondWithFile } from './file-utils.ts'
import type { RunController, RunContext } from './run-controller.ts'
import { handleRunRoutes } from './run-routes.ts'

export interface RoutesContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
    environments: RunEnvironments
  }
  staticDir: string
  saveReport: () => Promise<void>
  artifactRoots?: string[]
  approvalRouting?: {
    configDir: string
    playwrightTestDir?: string
    playwrightSnapshotDir?: string
    playwrightSnapshotPathTemplate?: string
    playwrightToHaveScreenshotPathTemplate?: string
    containerPathMapping?: ContainerPathMapping
  }
  runContext?: RunContext
  runInfo?: { mode: 'local' | 'docker' }
  containerPathMapping?: ContainerPathMapping
  /** Invoked once a run stops being in progress; flushes queued discovery refreshes. */
  notifyRunSettled?: () => void
}

export { isPathWithinRoots, isWebSocketUpgradeRequest, LIVE_UPDATES_WEBSOCKET_PATH } from './utils.ts'

async function handleRoot(ctx: RoutesContext): Promise<Response> {
  const html = await respondWithFile(join(ctx.staticDir, 'index.html'), 'text/html')
  return html ?? new Response('Not Found', { status: 404 })
}

async function handleAppCss(): Promise<Response> {
  const css = await respondWithFile('./src/client/app.css', 'text/css')
  return css ?? new Response('Not Found', { status: 404 })
}

async function handleSrcFiles(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/src/'.length)
  const filePath = `./src/${path}`
  const contentType =
    filePath.endsWith('.ts') || filePath.endsWith('.tsx')
      ? 'application/javascript'
      : filePath.endsWith('.css')
        ? 'text/css'
        : 'text/plain'
  const file = await respondWithFile(filePath, contentType)
  return file ?? new Response('Not Found', { status: 404 })
}

function handleApiReport(ctx: RoutesContext): Response {
  return Response.json({
    ...ctx.reportData,
    runEnabled: ctx.runContext !== undefined,
    runMode: ctx.runInfo?.mode,
  })
}

async function handleApiImages(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/api/images/'.length)
  const imagePath = `./images/${path}`
  const file = await respondWithFile(imagePath)
  return file ?? Response.json({ error: 'Image not found' }, { status: 404 })
}

async function handleScreenshots(ctx: RoutesContext, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/screenshots/'.length)
  const screenshotPath = `${ctx.reportData.screenshotDir}/${path}`
  const file = await respondWithFile(screenshotPath)
  return file ?? Response.json({ error: 'Screenshot not found' }, { status: 404 })
}

async function handleDist(ctx: RoutesContext, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/dist/'.length)
  const filePath = join(ctx.staticDir, path)
  const contentType = filePath.endsWith('.css')
    ? 'text/css'
    : filePath.endsWith('.js')
      ? 'application/javascript'
      : filePath.endsWith('.svelte')
        ? 'text/plain'
        : 'application/octet-stream'
  const file = await respondWithFile(filePath, contentType)
  return file ?? new Response('Not Found', { status: 404 })
}

export function handleHttpRequest(ctx: RoutesContext, req: Request, runController: RunController): Promise<Response> {
  const pathname = new URL(req.url).pathname

  if (pathname === '/') {
    return handleRoot(ctx)
  }

  if (pathname === '/src/client/app.css') {
    return handleAppCss()
  }

  if (pathname.startsWith('/src/')) {
    return handleSrcFiles(req)
  }

  if (pathname === '/api/report') {
    return Promise.resolve(handleApiReport(ctx))
  }

  if (pathname === '/api/approve' && req.method === 'POST') {
    return handleApiApprove(ctx, req)
  }

  if (pathname === '/api/approve-all' && req.method === 'POST') {
    return handleApiApproveAll(ctx)
  }
  const runResponse = handleRunRoutes(pathname, req.method, runController, req)
  if (runResponse !== null) {
    return runResponse
  }

  if (pathname.startsWith('/api/images/')) {
    return handleApiImages(req)
  }

  const artifactResponse = handleArtifactRoute(ctx, req, pathname)
  if (artifactResponse !== null) {
    return artifactResponse
  }

  if (pathname.startsWith('/screenshots/')) {
    return handleScreenshots(ctx, req)
  }

  if (pathname.startsWith('/dist/')) {
    return handleDist(ctx, req)
  }

  return Promise.resolve(new Response('Not Found', { status: 404 }))
}
