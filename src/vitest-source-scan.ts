/**
 * Structural scanner for Vitest test-module sources: locates
 * `describe`/`test`/`it` call sites with their titles and callback bodies, and
 * `toMatchScreenshot` call sites with their first argument. Regex-based by
 * design (mirrors the Playwright step-title extraction, not a full AST);
 * string literals and comments are masked (see vitest-source-mask) so scanning
 * only sees structural code while argument values are read from the original
 * source.
 */

export interface ScannedBlock {
  readonly kind: 'suite' | 'test'
  readonly title: string | null
  readonly start: number
  readonly spanEnd: number
  readonly bodyStart: number
  readonly bodyEnd: number
}

export type ScannedScreenshotArgument =
  | { readonly kind: 'named'; readonly raw: string }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'dynamic' }

export interface ScannedCall {
  readonly argument: ScannedScreenshotArgument
  readonly counter: number
}

const TEST_KEYWORDS = /\b(describe|test|it)\b/g
const SCREENSHOT_CALL = /\btoMatchScreenshot\s*\(/g
const WHITESPACE = ' \t\r\n'

export function skipWhitespace(masked: string, index: number): number {
  let cursor = index
  while (cursor < masked.length && WHITESPACE.includes(masked[cursor] ?? '')) cursor += 1
  return cursor
}

function skipBalanced(masked: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  let index = openIndex
  while (index < masked.length) {
    const char = masked[index]
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return masked.length
}

/**
 * Reads a quoted string literal from the ORIGINAL source starting at the open
 * quote, resolving the escapes a test author would plausibly write in a
 * screenshot name. Returns null for unterminated literals.
 */
function readStringLiteral(source: string, quoteIndex: number): { value: string; end: number } | null {
  const quote = source[quoteIndex]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  let index = quoteIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      if (next === undefined) return null
      if (next === quote || next === '\\') value += next
      else if (next === 'n') value += '\n'
      else if (next === 't') value += '\t'
      else value += next
      index += 2
      continue
    }
    if (char === quote) return { value, end: index + 1 }
    if (char === '\n') return null
    value += char
    index += 1
  }
  return null
}

/**
 * Reads a template literal from the ORIGINAL source starting at the backtick.
 * Interpolated (`${…}`) templates are dynamic by design; only plain literals
 * yield a usable name.
 */
function readTemplateLiteral(source: string, backtickIndex: number): { value: string; end: number; dynamic: boolean } {
  let value = ''
  let dynamic = false
  let index = backtickIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      const next = source[index + 1]
      if (next === '`' || next === '\\' || next === '$') value += next ?? ''
      else if (next === 'n') value += '\n'
      else if (next === 't') value += '\t'
      else value += next ?? ''
      index += 2
      continue
    }
    if (char === '`') return { value, end: index + 1, dynamic }
    if (char === '$' && source[index + 1] === '{') {
      dynamic = true
      index += 2
      continue
    }
    value += char
    index += 1
  }
  return { value, end: source.length, dynamic: true }
}

function readWord(masked: string, index: number): { word: string; end: number } | null {
  const match = /^[A-Za-z_$][\w$]*/.exec(masked.slice(index))
  if (match === null) return null
  return { word: match[0], end: index + match[0].length }
}

interface ParsedTitle {
  readonly title: string | null
  readonly afterTitle: number
}

/**
 * Parses the title argument of a test/describe call. Returns null when no
 * parenthesized argument list follows (e.g. a non-call match).
 */
function parseTitle(source: string, masked: string, afterChain: number): ParsedTitle | null {
  let index = skipWhitespace(masked, afterChain)
  if (masked[index] !== '(') return null
  index = skipWhitespace(masked, index + 1)

  const quote = masked[index]
  if (quote === "'" || quote === '"') {
    const literal = readStringLiteral(source, index)
    if (literal === null) return { title: null, afterTitle: skipBalanced(masked, index, '(', ')') }
    return { title: literal.value, afterTitle: literal.end }
  }
  if (quote === '`') {
    const literal = readTemplateLiteral(source, index)
    return {
      title: literal.dynamic ? null : literal.value,
      afterTitle: Math.min(literal.end, skipBalanced(masked, index, '(', ')')),
    }
  }

  // No string in the first argument group (test.each table, variables): fall
  // through to a trailing argument group if present.
  const afterGroup = skipBalanced(masked, index, '(', ')')
  const nextGroup = skipWhitespace(masked, afterGroup)
  if (masked[nextGroup] === '(') {
    return parseTitle(source, masked, afterGroup)
  }
  return { title: null, afterTitle: afterGroup }
}

function callbackBraceIndex(masked: string, index: number): number | null {
  let cursor = skipWhitespace(masked, index)
  if (masked.startsWith('async', cursor) && WHITESPACE.includes(masked[cursor + 5] ?? '')) {
    cursor = skipWhitespace(masked, cursor + 5)
  }
  const word = readWord(masked, cursor)
  if (word?.word === 'function') {
    cursor = skipWhitespace(masked, word.end)
    const name = readWord(masked, cursor)
    if (name !== null && masked[skipWhitespace(masked, name.end)] === '(') {
      cursor = skipWhitespace(masked, name.end)
    }
  }
  if (masked[cursor] === '(') {
    cursor = skipWhitespace(masked, skipBalanced(masked, cursor, '(', ')'))
    if (masked[cursor] === '=' && masked[cursor + 1] === '>') {
      cursor = skipWhitespace(masked, cursor + 2)
    }
  }
  return masked[cursor] === '{' ? cursor : null
}

/** Modifier chain before the argument list: test.only / it.each / describe.skip … */
function modifierChainEnd(masked: string, keywordEnd: number): number {
  let cursor = keywordEnd
  while (true) {
    const next = skipWhitespace(masked, cursor)
    if (masked[next] !== '.') return next
    const word = readWord(masked, next + 1)
    if (word === null) return next
    cursor = word.end
  }
}

function parseBlock(
  source: string,
  masked: string,
  keywordStart: number,
  keywordEnd: number,
  kind: 'suite' | 'test',
): ScannedBlock | null {
  const cursor = modifierChainEnd(masked, keywordEnd)
  const parsedTitle = parseTitle(source, masked, cursor)
  if (parsedTitle === null) return null

  let index = skipWhitespace(masked, parsedTitle.afterTitle)
  if (masked[index] === ',') {
    index = skipWhitespace(masked, index + 1)
    if (masked[index] === '{') {
      // Options object (e.g. { timeout }): skip, then expect the callback.
      index = skipWhitespace(masked, skipBalanced(masked, index, '{', '}'))
      if (masked[index] === ',') index = skipWhitespace(masked, index + 1)
    }
  }

  const callbackBrace = callbackBraceIndex(masked, index)
  if (callbackBrace === null) {
    // No usable callback body (brace-less arrow, .each table form, stub): the
    // block still counts for attribution ranges but holds no call sites.
    return {
      kind,
      title: parsedTitle.title,
      start: keywordStart,
      spanEnd: skipBalanced(masked, cursor, '(', ')'),
      bodyStart: keywordStart,
      bodyEnd: keywordStart,
    }
  }
  const bodyEnd = skipBalanced(masked, callbackBrace, '{', '}')
  return {
    kind,
    title: parsedTitle.title,
    start: keywordStart,
    spanEnd: bodyEnd,
    bodyStart: callbackBrace + 1,
    bodyEnd,
  }
}

export function scanTestBlocks(source: string, masked: string): ScannedBlock[] {
  const blocks: ScannedBlock[] = []
  TEST_KEYWORDS.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TEST_KEYWORDS.exec(masked)) !== null) {
    const keyword = match[1] ?? ''
    const previous = match.index > 0 ? (masked[match.index - 1] ?? '') : ''
    if (previous === '.' || previous === '$') continue
    const block = parseBlock(
      source,
      masked,
      match.index,
      match.index + match[0].length,
      keyword === 'describe' ? 'suite' : 'test',
    )
    if (block !== null) blocks.push(block)
  }
  return blocks
}

function parseFirstArgument(source: string, masked: string, afterOpenParen: number): ScannedScreenshotArgument {
  const index = skipWhitespace(masked, afterOpenParen)
  const quote = masked[index]
  if (quote === ')' || quote === ',') return { kind: 'unnamed' }
  if (quote === "'" || quote === '"') {
    const literal = readStringLiteral(source, index)
    return literal === null ? { kind: 'dynamic' } : { kind: 'named', raw: literal.value }
  }
  if (quote === '`') {
    const literal = readTemplateLiteral(source, index)
    return literal.dynamic ? { kind: 'dynamic' } : { kind: 'named', raw: literal.value }
  }
  const word = readWord(masked, index)
  if (word?.word === 'undefined') return { kind: 'unnamed' }
  return { kind: 'dynamic' }
}

export function extractScreenshotCallSites(
  source: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
): ScannedCall[] {
  const calls: ScannedCall[] = []
  SCREENSHOT_CALL.lastIndex = bodyStart
  let match: RegExpExecArray | null
  while ((match = SCREENSHOT_CALL.exec(masked)) !== null) {
    if (match.index >= bodyEnd) break
    const argument = parseFirstArgument(source, masked, match.index + match[0].length)
    calls.push({ argument, counter: calls.length + 1 })
  }
  return calls
}
