import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ProjectEnvironment } from '../src/browser-pins'
import { loadOfflineReports } from '../src/offline-reports'
import { writeReportArtifact } from '../src/report-artifact'
import { createMutableReportState } from '../src/report-state'
import { LoadedReportDataSchema, ReportApiResponseSchema } from '../src/schemas'
import { handleRegister, handleRunEnd, handleSync, type HandlerContext } from '../src/server/handlers'
import { loadReport } from '../src/server/report-bootstrap'
import type { RuntimeWebSocket } from '../src/server/ws'

const PINNED: ProjectEnvironment = {
  playwrightVersion: '1.59.0',
  browser: 'chromium',
  browserVersion: '147.0.7727.15',
  revision: '1217',
  pin: { browser: 'chromium', version: '147' },
  status: 'pinned',
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

class MockWebSocket implements RuntimeWebSocket {
  sent: string[] = []
  send(message: string): void {
    this.sent.push(message)
  }
}

function createHandlerContext(): { ctx: HandlerContext; clients: Set<MockWebSocket> } {
  const state = createMutableReportState('./screenshots')
  const clients = new Set<MockWebSocket>()
  const ctx: HandlerContext = {
    reportData: state.reportData,
    wsClients: clients as unknown as Set<RuntimeWebSocket>,
    currentRunIds: state.currentRunIds,
    isFilteredRun: false,
    saveReport: () => Promise.resolve(),
    scheduleReportSave: () => undefined,
    routesContext: {
      reportData: state.reportData,
      staticDir: './dist',
      saveReport: async () => {},
    },
    runController: null as unknown as HandlerContext['runController'],
  }
  return { ctx, clients }
}

describe('environments in schemas and report state', () => {
  test('environments is optional in the loaded report schema', () => {
    expect(LoadedReportDataSchema.safeParse({ tests: {}, isUpdateMode: false }).success).toBe(true)
  })

  test('environments is optional in the report API response schema', () => {
    expect(ReportApiResponseSchema.safeParse({ tests: {} }).success).toBe(true)
  })

  test('report state starts with an empty environments map', () => {
    expect(createMutableReportState().reportData.environments).toEqual({})
  })

  test('artifacts without environments load as empty (status unknown, not drift)', async () => {
    const dir = await tempDir('crvy-pins-legacy-')
    const reportPath = join(dir, 'report.json')
    await writeFile(reportPath, JSON.stringify({ tests: {}, isUpdateMode: false }))

    const { createReportData } = await import('../src/server/report-bootstrap')
    const reportData = createReportData('./screenshots')
    await loadReport(reportPath, reportData)

    expect(reportData.environments).toEqual({})
    expect(Object.values(reportData.environments)).toHaveLength(0)
  })

  test('offline reports carry environments from run-end', async () => {
    const dir = await tempDir('crvy-pins-offline-')
    const offlineReportDir = join(dir, 'artifacts')
    await mkdir(offlineReportDir, { recursive: true })
    const reportData = { tests: {}, screenshotDir: join(dir, 'screenshots'), environments: {} }
    await writeFile(
      join(offlineReportDir, 'crvy-rprtr-0.json'),
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        workers: 1,
        events: [
          {
            type: 'run-end',
            data: { status: 'passed', environments: { chromium: PINNED } },
            timestamp: 0,
            workerIndex: 0,
          },
        ],
      }),
    )

    await loadOfflineReports(reportData, offlineReportDir)
    expect(reportData.environments).toEqual({ chromium: PINNED })
  })

  test('the static artifact carries environments in its bootstrap data', async () => {
    const dir = await tempDir('crvy-pins-static-')
    const htmlPath = join(dir, 'crvy-rprtr.html')
    await writeReportArtifact({
      events: [{ type: 'run-end', data: { status: 'passed', environments: { chromium: PINNED } } }],
      screenshotDir: join(dir, 'screenshots'),
      reportHtmlPath: htmlPath,
    })

    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('"environments"')
    expect(html).toContain('"browserVersion":"147.0.7727.15"')
    expect(html).toContain('"status":"pinned"')
  })
})

describe('server environments plumbing', () => {
  test('register carries environments into the sync payload', () => {
    const { ctx, clients } = createHandlerContext()
    const client = new MockWebSocket()
    clients.add(client)

    handleRegister(ctx, { environments: { chromium: PINNED } })
    handleSync(ctx)

    const sync = client.sent
      .map((message) => JSON.parse(message) as { type: string; data: { environments?: unknown } })
      .find((message) => message.type === 'sync')
    expect(sync?.data.environments).toEqual({ chromium: PINNED })
  })

  test('run-end merges environments into the report state', async () => {
    const { ctx } = createHandlerContext()
    await handleRunEnd(ctx, { status: 'passed', environments: { chromium: PINNED } })

    expect(ctx.reportData.environments).toEqual({ chromium: PINNED })
  })

  test('the report API re-serves environments', async () => {
    const { ctx } = createHandlerContext()
    ctx.reportData.environments = { chromium: PINNED }

    const { handleHttpRequest } = await import('../src/server/routes')
    const response = await handleHttpRequest(ctx.routesContext, new Request('http://localhost/api/report'), {
      start: () => ({ ok: false, reason: 'no-config' }),
    } as never)
    const body = (await response.json()) as { environments?: unknown }

    expect(body.environments).toEqual({ chromium: PINNED })
  })
})
