import { RunRequestBodySchema, safeParse } from '../schemas.ts'
import type { RunController } from './run-controller.ts'

export function handleRunRoutes(
  pathname: string,
  method: string,
  runController: RunController,
  req: Request,
): Promise<Response> | null {
  if (pathname === '/api/run' && method === 'POST') {
    return handleApiRun(runController, req)
  }

  if (pathname === '/api/stop' && method === 'POST') {
    return Promise.resolve(handleApiStop(runController))
  }

  return null
}

async function handleApiRun(runController: RunController, req: Request): Promise<Response> {
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Empty body is allowed; default to {}.
  }
  const parsed = safeParse(RunRequestBodySchema, body)
  if (parsed === null) {
    return Response.json({ ok: false, reason: 'no-config' }, { status: 400 })
  }
  const result = runController.start(parsed)
  if (result.ok) return Response.json(result)
  return Response.json(result, { status: 409 })
}

function handleApiStop(runController: RunController): Response {
  const result = runController.stop()
  if (result.ok) return Response.json(result)
  return Response.json(result, { status: 409 })
}
