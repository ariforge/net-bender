// Helpers for moving HTTP bodies and headers between the Chrome DevTools
// Protocol (base64 bodies, header arrays/objects) and the editor (plain text).

const CHUNK = 0x8000;

export function bytesFromBase64(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function base64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function utf8ToBase64(text) {
  return base64FromBytes(new TextEncoder().encode(text));
}

export function concatBase64(parts) {
  const chunks = parts.map(bytesFromBase64);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return base64FromBytes(out);
}

// Decodes a base64 body into editable text. Bodies that are not valid UTF-8
// (images, fonts, protobuf...) stay as base64 so they round-trip losslessly.
export function decodeBody(b64) {
  if (!b64) return { body: '', bodyEncoding: 'utf8' };
  const bytes = bytesFromBase64(b64);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.includes('\u0000')) return { body: text, bodyEncoding: 'utf8' };
  } catch {
    // not UTF-8, fall through
  }
  return { body: b64, bodyEncoding: 'base64' };
}

export function encodeBody(body, bodyEncoding) {
  if (bodyEncoding === 'base64') return (body || '').replace(/\s+/g, '');
  return utf8ToBase64(body || '');
}

export function headerObjectToArray(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

export function headersToText(headers) {
  return (headers || []).map((h) => `${h.name}: ${h.value}`).join('\n');
}

export function textToHeaders(text) {
  const headers = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Skip the leading colon of HTTP/2 pseudo headers when splitting.
    const sep = line.indexOf(':', line.startsWith(':') ? 1 : 0);
    if (sep <= 0) {
      headers.push({ name: line, value: '' });
      continue;
    }
    headers.push({ name: line.slice(0, sep).trim(), value: line.slice(sep + 1).trim() });
  }
  return headers;
}

export function sameHeaders(a, b) {
  if (a.length !== b.length) return false;
  return a.every((h, i) => h.name === b[i].name && h.value === b[i].value);
}

export function withoutHeaders(headers, names) {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return headers.filter((h) => !drop.has(h.name.toLowerCase()));
}
