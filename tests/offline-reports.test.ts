import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { findOfflineReportPaths, mergeOfflineReports } from '../src/offline-reports'
import type { OfflineReport, TestData } from '../src/types'

describe('Offline report loading', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-tests-'))
  })

  afterEach(async () => {
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('finds every offline report file in the configured directory', async () => {
    await Promise.all([
      writeFile(join(tempDir, 'crvy-rprtr-0.json'), '{}'),
      writeFile(join(tempDir, 'crvy-rprtr-1.json'), '{}'),
      writeFile(join(tempDir, 'crvy-rprtr.json'), '{}'),
      writeFile(join(tempDir, 'notes.json'), '{}'),
    ])

    const paths = await findOfflineReportPaths(tempDir)

    expect(paths.map((path) => basename(path)).sort()).toEqual([
      'crvy-rprtr-0.json',
      'crvy-rprtr-1.json',
      'crvy-rprtr.json',
    ])
  })

  test('merges multiple offline reports without dropping earlier worker tests', () => {
    const existingTests: Record<string, TestData> = {
      existing: {
        id: 'existing',
        titlePath: ['Existing suite'],
        browser: 'chromium',
        title: 'Existing test',
        status: 'success',
      },
    }

    const firstWorkerReport: OfflineReport = {
      version: 1,
      generatedAt: '2026-04-08T00:00:00.000Z',
      workers: 1,
      events: [
        {
          type: 'test-begin',
          data: {
            id: 'test-1',
            title: 'First test',
            titlePath: ['Suite'],
            browser: 'chromium',
            location: { file: 'tests/example.spec.ts', line: 10 },
          },
          timestamp: 1,
          workerIndex: 0,
        },
        {
          type: 'test-end',
          data: {
            id: 'test-1',
            status: 'failed',
            attachments: [],
            duration: 10,
          },
          timestamp: 2,
          workerIndex: 0,
        },
        {
          type: 'run-end',
          data: { status: 'failed' },
          timestamp: 3,
          workerIndex: 0,
        },
      ],
    }

    const secondWorkerReport: OfflineReport = {
      version: 1,
      generatedAt: '2026-04-08T00:00:00.000Z',
      workers: 1,
      events: [
        {
          type: 'test-begin',
          data: {
            id: 'test-2',
            title: 'Second test',
            titlePath: ['Suite'],
            browser: 'chromium',
            location: { file: 'tests/example.spec.ts', line: 20 },
          },
          timestamp: 1,
          workerIndex: 1,
        },
        {
          type: 'test-end',
          data: {
            id: 'test-2',
            status: 'failed',
            attachments: [],
            duration: 12,
          },
          timestamp: 2,
          workerIndex: 1,
        },
        {
          type: 'run-end',
          data: { status: 'failed' },
          timestamp: 3,
          workerIndex: 1,
        },
      ],
    }

    const mergedTests = mergeOfflineReports(existingTests, [firstWorkerReport, secondWorkerReport], {
      screenshotDir: './screenshots',
      screenshotsBaseUrl: '/screenshots/',
    }).tests

    expect(Object.keys(mergedTests).sort()).toEqual(['existing', 'test-1', 'test-2'])
    expect(mergedTests['test-1']?.title).toBe('First test')
    expect(mergedTests['test-2']?.title).toBe('Second test')
    expect(mergedTests['existing']?.title).toBe('Existing test')
  })
})
