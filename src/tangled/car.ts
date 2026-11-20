const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

interface Reader {
  bytes: Uint8Array
  view: DataView
  offset: number
}

function next(reader: Reader): number {
  if (reader.offset >= reader.bytes.length) {
    throw new RangeError('The CAR file ends early')
  }
  return reader.bytes[reader.offset++]!
}

function varint(reader: Reader): number {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = next(reader)
    value += (byte & 0x7F) * 2 ** shift
    if (byte < 0x80) {
      return value
    }
    shift += 7
  }
}

/** A CID as atproto writes it: multibase base32, lower case, unpadded. */
function cidString(bytes: Uint8Array): string {
  let text = 'b'
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += BASE32[(buffer >> bits) & 31]
    }
  }
  return bits
    ? text + BASE32[(buffer << (5 - bits)) & 31]
    : text
}

function argument(reader: Reader, info: number): number {
  const { view } = reader
  const at = reader.offset
  switch (info) {
    case 24:
      reader.offset += 1
      return view.getUint8(at)
    case 25:
      reader.offset += 2
      return view.getUint16(at)
    case 26:
      reader.offset += 4
      return view.getUint32(at)
    case 27:
      reader.offset += 8
      return Number(view.getBigUint64(at))
    default:
      return info
  }
}

/** One DAG-CBOR value. A link reads as `{ $link }` and bytes as a `Uint8Array`, as atproto's JSON has them. */
function decode(reader: Reader): unknown {
  const head = next(reader)
  const major = head >> 5
  const info = head & 31
  if (major === 7) {
    switch (info) {
      case 20:
        return false
      case 21:
        return true
      case 22:
        return null
      case 27:
        reader.offset += 8
        return reader.view.getFloat64(reader.offset - 8)
      default:
        throw new TypeError(`Unsupported CBOR value ${head}`)
    }
  }
  const value = argument(reader, info)
  switch (major) {
    case 0:
      return value
    case 1:
      return -1 - value
    case 2:
    case 3: {
      const slice = reader.bytes.subarray(reader.offset, reader.offset += value)
      return major === 2
        ? slice
        : new TextDecoder().decode(slice)
    }
    case 4:
      return Array.from({ length: value }, () => decode(reader))
    case 5: {
      const map: Record<string, unknown> = {}
      for (let index = 0; index < value; index++) {
        map[decode(reader) as string] = decode(reader)
      }
      return map
    }
    default: {
      const link = decode(reader) as Uint8Array
      return {
        $link: cidString(link.subarray(1)),
      }
    }
  }
}

function reader(bytes: Uint8Array): Reader {
  return {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  }
}

/** The DAG-CBOR blocks of a CAR file, decoded, by CID. */
export function decodeCar(bytes: Uint8Array): Map<string, unknown> {
  const car = reader(bytes)
  const header = varint(car)
  car.offset += header
  const blocks = new Map<string, unknown>()
  while (car.offset < bytes.length) {
    const length = varint(car)
    const end = car.offset + length
    const start = car.offset
    // A CID is its version, its codec, then a multihash: the hash function, the digest's length and the digest.
    varint(car)
    varint(car)
    varint(car)
    const digest = varint(car)
    car.offset += digest
    blocks.set(cidString(bytes.subarray(start, car.offset)), decode(reader(bytes.subarray(car.offset, end))))
    car.offset = end
  }
  return blocks
}
