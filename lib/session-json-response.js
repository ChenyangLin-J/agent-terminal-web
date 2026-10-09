import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);

/** Compress only selected conversation responses; authorization remains in their routes. */
export async function encodeSessionJson(req, res, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  res.type('json').vary('Accept-Encoding').set('X-Agent-Snapshot-Bytes', String(bytes));
  let body = serialized;
  if (bytes >= 1024 && req.acceptsEncodings('gzip')) {
    body = await compress(serialized);
    res.set('Content-Encoding', 'gzip');
  }
  res.set('X-Agent-Snapshot-Encoded-Bytes', String(Buffer.byteLength(body)));
  return body;
}
