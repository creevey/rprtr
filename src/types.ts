// Core types used throughout the application
// These types serve as the single source of truth

import type { RunEnvironments } from './browser-pins.ts'
import type { ScreenshotDeclaration } from './reporter-utils.ts'

export type VisualSource = 'comparison' | 'baseline-only' | 'declared-only'

export interface Images {
  actual?: string
  expect?: string
  diff?: string
  error?: string
  source?: VisualSource
  /** Reporter-asserted baseline source file (metadata-carrying providers). */
  approveFromPath?: string
  /** Reporter-asserted baseline target path (metadata-carrying providers). */
  approveToPath?: string
}

export interface Attachment {
  name: string
  path: string
  contentType: string
}

export interface Location {
  file: string
  line: number
  column?: number
}

export type TestStatus = 'unknown' | 'pending' | 'running' | 'failed' | 'approved' | 'success' | 'retrying'

export type TestResultStatus = 'failed' | 'success' | 'pending'

export type Provider = 'playwright' | 'vitest'

export interface TestResult {
  status: TestResultStatus
  retries: number
  images?: Partial<Record<string, Images>>
  visualDeclarations?: readonly ScreenshotDeclaration[]
  error?: string
  duration?: number
}

export interface TestData {
  id: string
  titlePath: string[]
  /**
   * Root-relative file path tokens ('tests', 'button.test.ts') grouping tests
   * in the sidebar tree. Reporters and discovery populate it identically so
   * the tree keeps the same shape before, during, and after a run. Absent in
   * data from older reporters; those render flat under the title only.
   */
  fileTokens?: string[]
  browser: string
  /**
   * Raw Playwright project name. Used for snapshot path resolution so the
   * resolver matches what Playwright itself used when storing baselines
   * (empty string for the implicit default project). Undefined for data
   * produced by older reporters; consumers fall back to `browser`.
   */
  projectName?: string
  title: string
  skip?: boolean | string
  retries?: number
  status?: TestStatus
  results?: TestResult[]
  approved?: Partial<Record<string, number>> | null
  attachments?: Attachment[]
  location?: Location
  /** Reporting provider that produced this test's events; absent means playwright. */
  provider?: Provider
}

export interface CrvyRprtrTest extends TestData {
  checked: boolean
}

export interface CrvyRprtrSuite {
  path: string[]
  skip: boolean
  status?: TestStatus
  opened: boolean
  checked: boolean
  indeterminate: boolean
  children?: Partial<Record<string, CrvyRprtrSuite | CrvyRprtrTest>>
}

export type ImagesViewMode = 'side-by-side' | 'swap' | 'slide' | 'blend'

export interface WebSocketMessage {
  type: 'test-begin' | 'test-end' | 'run-end' | 'approve' | 'sync'
  data: unknown
}

export interface WebSocketRunEndData {
  status: 'passed' | 'failed' | 'skipped'
  removedTestIds: string[]
}

export interface WebSocketSyncData {
  tests: Record<string, TestData>
  isUpdateMode?: boolean
  environments?: RunEnvironments
}

export type ClientWebSocketMessage =
  | { type: 'test-begin'; data: TestData }
  | { type: 'test-update'; data: TestData }
  | { type: 'run-end'; data: WebSocketRunEndData }
  | { type: 'sync'; data: WebSocketSyncData }
  | { type: 'approve'; data: unknown }
  | { type: 'run-status'; data: { running: boolean; mode?: 'local' | 'docker'; phase?: string; notices?: string[] } }

export interface TestBeginMessage {
  type: 'test-begin'
  data: {
    id: string
    title: string
    titlePath: string[]
    browser: string
    projectName?: string
    location: Location
  }
}

export interface TestEndMessage {
  type: 'test-end'
  data: {
    id: string
    status: 'passed' | 'failed' | 'skipped'
    attachments: Attachment[]
    visualNames: string[]
    visualDeclarations?: readonly ScreenshotDeclaration[]
    approvalTargets?: Record<string, string>
    error?: string
    duration?: number
  }
}

export interface RunEndMessage {
  type: 'run-end'
  data: { status: 'passed' | 'failed' | 'skipped' }
}

export interface CrvyRprtrStatus {
  isRunning: boolean
  tests: Partial<Record<string, TestData>>
  browsers: string[]
  isUpdateMode: boolean
}

export interface CrvyRprtrViewFilter {
  status: TestStatus | null
  subStrings: string[]
}

export interface OfflineEvent {
  type: 'test-begin' | 'test-end' | 'run-end'
  data: TestBeginMessage['data'] | TestEndMessage['data'] | RunEndMessage['data']
  timestamp: number
  workerIndex: number
}

export interface OfflineReport {
  version: number
  generatedAt: string
  workers: number
  events: OfflineEvent[]
}

export interface ClientBootstrapData {
  report: {
    tests: Record<string, TestData>
    isUpdateMode: boolean
    environments?: RunEnvironments
  }
  liveUpdates: boolean
  approvalEnabled: boolean
  approvalMessage?: string
}

export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

export function isTest(x: unknown): x is CrvyRprtrTest {
  if (x === null || typeof x !== 'object') return false
  const hasId = 'id' in x
  const hasTitlePath = 'titlePath' in x
  return hasId && hasTitlePath && typeof x.id === 'string' && Array.isArray(x.titlePath)
}

// Helper functions to safely work with optional children records
export function getChildrenArray<T>(children: Partial<Record<string, T>> | undefined): T[] {
  if (children === undefined) return []
  return Object.values(children).filter(isDefined)
}

export function getChildrenEntries<T>(children: Partial<Record<string, T>> | undefined): [string, T][] {
  if (children === undefined) return []
  return Object.entries(children).filter((entry): entry is [string, T] => isDefined(entry[1]))
}

export function getChildrenKeys<T>(children: Partial<Record<string, T>> | undefined): string[] {
  if (children === undefined) return []
  return Object.keys(children)
}
