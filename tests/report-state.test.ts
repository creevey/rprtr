import { describe, expect, test } from 'bun:test'

import { applyTestBeginEvent, applyTestEndEvent, createMutableReportState } from '../src/report-state'
import { ReportApiResponseSchema, TestEndDataSchema, safeParse } from '../src/schemas'

describe('report-state visual classification', () => {
  test('keeps skipped test and result statuses consistent', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-skipped',
      title: 'skipped test',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 20 },
    })

    applyTestEndEvent(state, {
      id: 'test-skipped',
      status: 'skipped',
      attachments: [],
      visualNames: [],
      duration: 5,
    })

    const testData = state.reportData.tests['test-skipped']

    expect(testData?.status).toBe('pending')
    expect(testData?.results?.[0]?.status).toBe('pending')
  })

  test('marks baseline-only and declared-only screenshot assertions explicitly', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-1',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(
      state,
      {
        id: 'test-1',
        status: 'passed',
        attachments: [
          {
            name: 'header-expected',
            path: 'test-1/header-expected',
            contentType: 'image/png',
          },
        ],
        visualNames: ['header', 'footer'],
      },
      { screenshotsBaseUrl: '/screenshots/' },
    )

    const images = state.reportData.tests['test-1']?.results?.[0]?.images ?? {}

    expect(images['header']?.source).toBe('baseline-only')
    expect(images['header']?.expect).toBe('/screenshots/test-1/header-expected')
    expect(images['footer']?.source).toBe('declared-only')
  })

  test('keeps carry-forward only for image names still present in a later passing run', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-1',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(
      state,
      {
        id: 'test-1',
        status: 'passed',
        attachments: [
          {
            name: 'header-expected',
            path: 'test-1/header-expected',
            contentType: 'image/png',
          },
          {
            name: 'footer-expected',
            path: 'test-1/footer-expected',
            contentType: 'image/png',
          },
        ],
        visualNames: ['header', 'footer'],
      },
      { screenshotsBaseUrl: '/screenshots/' },
    )

    applyTestBeginEvent(state, {
      id: 'test-1',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(
      state,
      {
        id: 'test-1',
        status: 'passed',
        attachments: [],
        visualNames: ['header'],
      },
      { screenshotsBaseUrl: '/screenshots/' },
    )

    const images = state.reportData.tests['test-1']?.results?.[0]?.images ?? {}

    expect(images['header']?.source).toBe('baseline-only')
    expect(images['header']?.expect).toBe('/screenshots/test-1/header-expected')
    expect(images['footer']).toBeUndefined()
  })

  test('does not carry a stale comparison actual URL into a later passing run', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 't-stale',
      title: 'visual',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(state, {
      id: 't-stale',
      status: 'failed',
      attachments: [
        {
          name: 'header-actual.png',
          path: '/tmp/test-results/t-stale/header-actual.png',
          contentType: 'image/png',
        },
      ],
      visualNames: ['header'],
      visualDeclarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
      ],
    })

    const firstRunActual = state.reportData.tests['t-stale']?.results?.[0]?.images?.['header']?.actual
    expect(firstRunActual).toBe('/file/%2Ftmp%2Ftest-results%2Ft-stale%2Fheader-actual.png')

    applyTestBeginEvent(state, {
      id: 't-stale',
      title: 'visual',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(state, {
      id: 't-stale',
      status: 'passed',
      attachments: [],
      visualNames: ['header'],
      visualDeclarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
      ],
    })

    const passedImage = state.reportData.tests['t-stale']?.results?.[0]?.images?.['header']
    expect(passedImage?.actual).toBeUndefined()
    expect(passedImage?.source).toBe('declared-only')
  })
})

describe('report-state approval metadata', () => {
  test('falls back to visualNames for older parsed payloads without visualDeclarations', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-legacy-visual-names',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    const parsedEvent = safeParse(TestEndDataSchema, {
      id: 'test-legacy-visual-names',
      status: 'passed',
      attachments: [],
      visualNames: ['header'],
      duration: 5,
    })

    expect(parsedEvent).not.toBeNull()
    if (parsedEvent === null) {
      return
    }

    applyTestEndEvent(state, parsedEvent, { screenshotsBaseUrl: '/screenshots/' })

    const result = state.reportData.tests['test-legacy-visual-names']?.results?.[0]

    expect(result?.images?.['header']?.source).toBe('declared-only')
    expect(result?.visualDeclarations).toBeUndefined()
  })

  test('stores resolver metadata for named and unnamed screenshots', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-approval-meta',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    applyTestEndEvent(
      state,
      {
        id: 'test-approval-meta',
        status: 'passed',
        attachments: [],
        visualNames: ['header', '__unnamed-screenshot-1'],
        visualDeclarations: [
          {
            visualName: 'header',
            kind: 'named',
            declaredName: 'header',
            snapshotBaseName: 'header',
            occurrenceIndex: 1,
          },
          {
            visualName: '__unnamed-screenshot-1',
            kind: 'unnamed',
            occurrenceIndex: 1,
          },
        ],
        duration: 5,
      },
      { screenshotsBaseUrl: '/screenshots/' },
    )

    const result = state.reportData.tests['test-approval-meta']?.results?.[0]

    expect(result?.visualDeclarations).toEqual([
      {
        visualName: 'header',
        kind: 'named',
        declaredName: 'header',
        snapshotBaseName: 'header',
        occurrenceIndex: 1,
      },
      {
        visualName: '__unnamed-screenshot-1',
        kind: 'unnamed',
        occurrenceIndex: 1,
      },
    ])
  })

  test('does not emit a phantom declared-only entry for a finalized unnamed screenshot', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 't1',
      title: 'visual',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'example.spec.ts', line: 1 },
    })

    applyTestEndEvent(state, {
      id: 't1',
      status: 'failed',
      attachments: [
        { name: 'Suite-visual-1-actual.png', path: 't1/Suite-visual-1-actual.png', contentType: 'image/png' },
        { name: 'Suite-visual-1-expected.png', path: 't1/Suite-visual-1-expected.png', contentType: 'image/png' },
        { name: 'Suite-visual-1-diff.png', path: 't1/Suite-visual-1-diff.png', contentType: 'image/png' },
      ],
      // Intentionally divergent: visualNames carries the stale synthetic name while
      // visualDeclarations carries the finalized name. This proves image keys derive
      // from visualDeclarations (getDeclaredVisualNames prefers it); using the finalized
      // name in both would make this test pass even if visualDeclarations were ignored.
      visualNames: ['__unnamed-screenshot-1'],
      visualDeclarations: [{ visualName: 'Suite-visual-1', kind: 'unnamed', occurrenceIndex: 1 }],
    })

    const images = state.reportData.tests['t1']?.results?.[0]?.images ?? {}
    expect(Object.keys(images)).toEqual(['Suite-visual-1'])
    expect(Object.keys(images)).not.toContain('__unnamed-screenshot-1')
    expect(images['Suite-visual-1']?.source).toBe('comparison')
  })

  test('preserves approval metadata through event and report schema boundaries', () => {
    const state = createMutableReportState('./screenshots')

    applyTestBeginEvent(state, {
      id: 'test-approval-boundary',
      title: 'visual pass',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 12 },
    })

    const parsedEvent = safeParse(TestEndDataSchema, {
      id: 'test-approval-boundary',
      status: 'passed',
      attachments: [],
      visualNames: ['header', '__unnamed-screenshot-1'],
      visualDeclarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      duration: 5,
    })

    expect(parsedEvent).not.toBeNull()
    if (parsedEvent === null) {
      return
    }

    applyTestEndEvent(state, parsedEvent, { screenshotsBaseUrl: '/screenshots/' })

    const parsedReport = safeParse(ReportApiResponseSchema, {
      tests: state.reportData.tests,
      isUpdateMode: state.reportData.isUpdateMode,
    })

    expect(parsedReport).not.toBeNull()
    expect(parsedReport?.tests['test-approval-boundary']?.results?.[0]?.visualDeclarations).toEqual([
      {
        visualName: 'header',
        kind: 'named',
        declaredName: 'header',
        snapshotBaseName: 'header',
        occurrenceIndex: 1,
      },
      {
        visualName: '__unnamed-screenshot-1',
        kind: 'unnamed',
        occurrenceIndex: 1,
      },
    ])
  })
})
