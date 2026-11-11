/**
 * Text codec used on the wire. Everything that travels through a Minecraft
 * command (chat or /scriptevent) is restricted to plain ASCII so that no layer
 * (command parser, chat filter, JSON event encoder) can damage it. Unicode math
 * (∫, √, x², λ ...) therefore travels as base64url(UTF-8(JSON)).
 *
 * Hand-written on purpose: the Bedrock script runtime has no TextEncoder,
 * Buffer, btoa or atob.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i] as string] = i;

export function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

export function utf8Decode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++] as number;
    let cp: number;
    if (b0 < 0x80) cp = b0;
    else if (b0 >= 0xc0 && b0 < 0xe0) cp = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    else if (b0 >= 0xe0 && b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else if (b0 >= 0xf0) {
      cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i++] ?? 0) & 0x3f) << 12) |
        (((bytes[i++] ?? 0) & 0x3f) << 6) |
        ((bytes[i++] ?? 0) & 0x3f);
    } else cp = 0xfffd;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else out += String.fromCharCode(cp);
  }
  return out;
}

export function base64UrlEncode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += B64[b2 & 63];
  }
  return out;
}

export function base64UrlDecode(text: string): number[] {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = B64_REV[text[i] as string];
    if (v === undefined) throw new Error(`Invalid base64url character at ${i}`);
    buffer = ((buffer << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/** JSON value -> ASCII-only wire text. */
export function encodePayload(value: unknown): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(value)));
}

/** ASCII wire text -> JSON value. Throws on damage. */
export function decodePayload<T = unknown>(text: string): T {
  return JSON.parse(utf8Decode(base64UrlDecode(text))) as T;
}
