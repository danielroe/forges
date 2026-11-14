import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decode, encode } from '../../src/wire.ts'

describe('wire', () => {
  it('round-trips dates and bytes through JSON', () => {
    const value = {
      createdAt: new Date('2026-11-14T10:00:00.000Z'),
      content: new Uint8Array([0, 1, 2, 255]),
      nested: [
        {
          updatedAt: new Date(0),
        },
      ],
    }

    expect(decode(JSON.parse(JSON.stringify(encode(value))))).toEqual(value)
  })

  it('encodes buffers as bytes', () => {
    const value = {
      content: Buffer.from([1, 2, 3]),
    }

    expect(decode(JSON.parse(JSON.stringify(encode(value))))).toEqual({
      content: new Uint8Array([1, 2, 3]),
    })
  })

  it('leaves plain ISO strings alone', () => {
    const value = { before: '0000000000000000000000000000000000000000', since: '2026-11-14' }

    expect(decode(encode(value))).toEqual(value)
  })

  it('rejects malformed tags', () => {
    expect(() => decode({ $date: 'not a date' })).toThrow('Invalid $date')
    expect(() => decode({ $bytes: 'not base64' })).toThrow('Invalid $bytes')
  })

  it('rejects invalid dates', () => {
    expect(() => encode(new Date(Number.NaN))).toThrow('Cannot encode an invalid Date')
  })
})
