export function isCI(env: Record<string, string | undefined> = process.env): boolean {
  const ci = env.CI
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0'
}
