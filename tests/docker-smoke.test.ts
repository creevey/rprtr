import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'fs/promises'
import { createServer } from 'net'
import { join } from 'path'

const SMOKE_ENABLED = process.env.CRVY_DOCKER_SMOKE === '1'
const fixtureDir = join(import.meta.dir, 'fixtures', 'docker-smoke')
const distDir = join(import.meta.dir, '..', 'dist')

interface RunningProcess {
  process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  stdoutPromise: Promise<string>
  stderrPromise: Promise<string>
}

const runningProcesses: RunningProcess[] = []

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? Promise.resolve('') : new Response(stream).text()
}

function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a TCP port'))
        return
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })
}

function spawnProcess(command: string[], cwd: string): RunningProcess {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const subprocess = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd, env })
  const running = {
    process: subprocess,
    stdoutPromise: readStream(subprocess.stdout),
    stderrPromise: readStream(subprocess.stderr),
  }
  runningProcesses.push(running)
  return running
}

async function waitForServer(port: number, running: RunningProcess): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/report`
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  const [stdout, stderr] = await Promise.all([running.stdoutPromise, running.stderrPromise])
  throw new Error(`Server did not start on port ${port}\n${stdout.trim()}\n${stderr.trim()}`)
}

interface ReportShape {
  tests?: Record<string, { status?: string }>
  runMode?: string
}

async function dockerOutput(args: string[]): Promise<string> {
  const subprocess = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const stdout = await readStream(subprocess.stdout)
  await subprocess.exited
  return stdout
}

/** Removes every container debug mode retained, identified by its label. */
async function removeDebugContainers(): Promise<void> {
  const names = (
    await dockerOutput(['ps', '-a', '--filter', 'label=crvy-rprtr.debug=1', '--format', '{{.Names}}'])
  ).trim()
  if (names === '') return
  for (const name of names.split('\n')) {
    await dockerOutput(['rm', '-f', name.trim()])
  }
}

/** Stops the server and resolves its captured stdout, which carries the debug records. */
async function stopServerAndReadStdout(running: RunningProcess): Promise<string> {
  const index = runningProcesses.indexOf(running)
  if (index !== -1) runningProcesses.splice(index, 1)
  running.process.kill()
  await running.process.exited
  return running.stdoutPromise
}

async function postRun(port: number, body: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  expect(response.status).toBe(200)
}

async function waitForSettledRun(port: number): Promise<ReportShape> {
  // First run may include a docker pull — allow generous polling.
  const deadline = Date.now() + 240_000
  let report: ReportShape = {}
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/report`)
    report = (await response.json()) as ReportShape
    const tests = Object.values(report.tests ?? {})
    if (tests.length > 0 && tests.every((t) => t.status === 'success' || t.status === 'failed')) break
    await Bun.sleep(2000)
  }
  return report
}

afterEach(async () => {
  while (runningProcesses.length > 0) {
    const running = runningProcesses.pop()
    if (running !== undefined) {
      running.process.kill()
      await running.process.exited
    }
  }
  if (SMOKE_ENABLED) await removeDebugContainers()
})

describe('docker smoke', () => {
  test.skipIf(!SMOKE_ENABLED)(
    'a playwright run inside the container round-trips to the host server',
    async () => {
      const port = await reservePort()
      const server = spawnProcess(
        ['node', join(distDir, 'cli.js'), '--port', `${port}`, '--run-mode', 'docker'],
        fixtureDir,
      )
      await waitForServer(port, server)
      await postRun(port, '{}')
      const report = await waitForSettledRun(port)

      expect(report.runMode).toBe('docker')
      const tests = Object.values(report.tests ?? {})
      expect(tests.length).toBeGreaterThan(0)
      expect(tests.every((t) => t.status === 'success')).toBe(true)
    },
    300_000,
  )

  test.skipIf(!SMOKE_ENABLED)(
    'a debug-mode run records its launch vector',
    async () => {
      const port = await reservePort()
      const server = spawnProcess(
        ['node', join(distDir, 'cli.js'), '--port', `${port}`, '--run-mode', 'docker', '--debug'],
        fixtureDir,
      )
      await waitForServer(port, server)
      await postRun(port, '{}')
      const report = await waitForSettledRun(port)
      expect(report.runMode).toBe('docker')

      const stdout = await stopServerAndReadStdout(server)
      const lines = stdout.split('\n')
      const launch = lines.find((line) => line.includes('event=launch'))!
      expect(launch).toContain('cmd=docker')
      expect(launch).toContain('CRVY_RPRTR_DEBUG=1')
      expect(launch).not.toContain('--rm')
      const container = lines.find((line) => line.includes('event=container'))!
      expect(container).toContain('image=mcr.microsoft.com/playwright:v1.59.0-noble')
      expect(container).toContain('inspect="docker inspect ')
    },
    300_000,
  )

  test.skipIf(!SMOKE_ENABLED)(
    'an induced failure retains a labeled container with recorded inspect commands',
    async () => {
      // A deliberately failing spec, selected by title, makes the in-container run exit non-zero.
      const failingSpec = join(fixtureDir, 'tests', 'induced-failure.spec.ts')
      await writeFile(
        failingSpec,
        `import { expect, test } from '@playwright/test'\n\ntest('induced failure', () => {\n  expect(1).toBe(2)\n})\n`,
      )
      try {
        const port = await reservePort()
        const server = spawnProcess(
          ['node', join(distDir, 'cli.js'), '--port', `${port}`, '--run-mode', 'docker', '--debug'],
          fixtureDir,
        )
        await waitForServer(port, server)
        await postRun(
          port,
          JSON.stringify({
            tests: [
              {
                file: join(fixtureDir, 'tests', 'induced-failure.spec.ts'),
                line: 3,
                projectName: 'chromium',
                titlePath: ['induced failure'],
              },
            ],
          }),
        )

        const deadline = Date.now() + 240_000
        let retainedName: string | null = null
        while (Date.now() < deadline) {
          const listed = await dockerOutput([
            'ps',
            '-a',
            '--filter',
            'label=crvy-rprtr.debug=1',
            '--format',
            '{{.Names}} {{.State}}',
          ])
          const entry = listed.split('\n').find((line) => line.includes('exited'))
          if (entry !== undefined) {
            retainedName = entry.split(/\s+/)[0]!
            break
          }
          await Bun.sleep(2000)
        }
        expect(retainedName).not.toBeNull()
        expect(retainedName!.startsWith('crvy-rprtr-run-')).toBe(true)
        const exitCode = (await dockerOutput(['inspect', '--format', '{{.State.ExitCode}}', retainedName!])).trim()
        expect(exitCode).toBe('1')

        const stdout = await stopServerAndReadStdout(server)
        const container = stdout.split('\n').find((line) => line.includes('event=container'))!
        expect(container).toContain(`container=${retainedName}`)
        expect(container).toContain(`inspect="docker inspect ${retainedName}"`)
        expect(container).toContain(`logs="docker logs ${retainedName}"`)
      } finally {
        await rm(failingSpec, { force: true })
      }
    },
    300_000,
  )
})
