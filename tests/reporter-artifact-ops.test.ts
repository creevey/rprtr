import { expect, test } from 'bun:test'

import { rewriteTestEndAttachments, type RunEvent } from '../src/reporter-artifact-ops'

test('rewriteTestEndAttachments replaces attachments on the matching test-end event', () => {
  const events: RunEvent[] = [
    { type: 'test-begin', data: { id: 't1' } },
    {
      type: 'test-end',
      data: { id: 't1', attachments: [{ name: 'old', path: '/abs/old.png', contentType: 'image/png' }] },
    },
    { type: 'test-end', data: { id: 't2', attachments: [] } },
  ]

  rewriteTestEndAttachments(events, 't1', [{ name: 'new', path: 't1/new.png', contentType: 'image/png' }])

  expect((events[1]!.data as { attachments: unknown[] }).attachments).toEqual([
    { name: 'new', path: 't1/new.png', contentType: 'image/png' },
  ])
  expect((events[2]!.data as { attachments: unknown[] }).attachments).toEqual([])
})
