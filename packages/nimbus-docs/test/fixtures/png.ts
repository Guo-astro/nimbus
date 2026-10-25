// Minimal image bytes for tests.

/** A PNG with only the header chunk: enough for its dimensions to be read. */
export function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}
