/**
 * Byte-preserving mask over test-module sources: string/template contents and
 * comments are blanked so structural scanning (keywords, braces, call sites)
 * only ever sees code. Quote delimiters stay visible for argument parsing;
 * offsets stay aligned with the original source.
 */

function maskLineComment(source: string, out: string[], start: number): number {
  let index = start
  while (index < source.length && source[index] !== '\n') {
    out[index] = ' '
    index += 1
  }
  return index
}

function maskBlockComment(source: string, out: string[], start: number): number {
  let index = start + 2
  out[start] = ' '
  out[start + 1] = ' '
  while (index < source.length) {
    if (source[index] === '*' && source[index + 1] === '/') {
      out[index] = ' '
      out[index + 1] = ' '
      return index + 2
    }
    out[index] = ' '
    index += 1
  }
  return index
}

function maskQuotedSequence(source: string, out: string[], quoteIndex: number): number {
  const quote = source[quoteIndex]
  let index = quoteIndex + 1
  while (index < source.length) {
    const current = source[index]
    if (current === '\\') {
      out[index] = ' '
      if (index + 1 < source.length) out[index + 1] = ' '
      index += 2
      continue
    }
    out[index] = ' '
    index += 1
    if (current === quote) break
  }
  return index
}

export function maskLiteralsAndComments(source: string): string {
  const out = source.split('')
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      index = maskLineComment(source, out, index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = maskBlockComment(source, out, index)
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = maskQuotedSequence(source, out, index)
      continue
    }
    index += 1
  }
  return out.join('')
}
