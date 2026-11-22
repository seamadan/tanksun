/**
 * TankSun — Gizwits GAgent v3 + var_len (0x00000004) Protocol Codec
 * Product: ASTRA_freshwate (product_key: 6cc581e630ba4e2297484a36967df36c)
 */

export const SERVICE_UUID_GATT = '0000abf0-0000-1000-8000-00805f9b34fb';
export const SERVICE_UUID_ADV = '0000f0ab-0000-1000-8000-00805f9b34fb';
export const CHAR_UUID_DATA = '0000abf7-0000-1000-8000-00805f9b34fb';

export const TOTAL_ATTRS = 34;
export const ATTR_FLAGS_BYTES = 5; // ceil(34 / 8)

export const ATTRS = [
  { id: 0, name: 'onOff', type: 'bool', len: 1 },
  { id: 1, name: 'mesh', type: 'bool', len: 1 },
  { id: 2, name: 'remark4', type: 'bool', len: 1 },
  { id: 3, name: 'haveColour', type: 'uint8', len: 1, addition: 0 },
  { id: 4, name: 'nodeNum', type: 'uint8', len: 1, addition: 0 },
  { id: 5, name: 'mode', type: 'uint8', len: 1, addition: 1 }, // 1=Auto, 2..7=Manual 1..6
  { id: 6, name: 'deviceType', type: 'uint8', len: 1, addition: 1 },
  { id: 7, name: 'remark1', type: 'uint8', len: 1, addition: 0 },
  { id: 8, name: 'remark2', type: 'uint8', len: 1, addition: 0 },
  { id: 9, name: 'remark5', type: 'uint8', len: 1, addition: 0 },
  { id: 10, name: 'remark6', type: 'uint8', len: 1, addition: 0 },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: 11 + i,
    name: `nodeTime${i + 1}`,
    type: 'uint16',
    len: 2,
    addition: 0,
  })),
  { id: 23, name: 'timestamp', type: 'uint32', len: 4, addition: 0 },
  ...Array.from({ length: 8 }, (_, i) => ({
    id: 24 + i,
    name: `colour${i + 1}`,
    type: 'binary',
    len: 18,
  })),
  { id: 32, name: 'cycleDate', type: 'binary', len: 7 },
  { id: 33, name: 'remark3', type: 'binary', len: 10 },
];

export const ATTR_BY_NAME = Object.fromEntries(ATTRS.map((a) => [a.name, a]));
export const ALL_ATTR_IDS = ATTRS.map((a) => a.id);

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function encodeVarint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return new Uint8Array(out);
}

export function decodeVarint(bytes, offset = 0) {
  let val = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: val, nextOffset: pos };
    shift += 7;
  }
  return null;
}

/**
 * Wrap a Gizwits GAgent v3 frame:
 *   00 00 00 03 | varint(len) | flag(1) | cmd(2 BE) | payload
 */
export function buildGAgentFrame(cmd, payload = new Uint8Array(0), flag = 0x00) {
  const bodyLen = 1 + 2 + payload.length;
  const lenBytes = encodeVarint(bodyLen);
  const frame = new Uint8Array(4 + lenBytes.length + bodyLen);
  frame[0] = 0x00;
  frame[1] = 0x00;
  frame[2] = 0x00;
  frame[3] = 0x03;
  frame.set(lenBytes, 4);
  const off = 4 + lenBytes.length;
  frame[off] = flag;
  frame[off + 1] = (cmd >> 8) & 0xff;
  frame[off + 2] = cmd & 0xff;
  frame.set(payload, off + 3);
  return frame;
}

/**
 * Parse a complete Gizwits GAgent v3 frame. Returns null if incomplete or invalid.
 */
export function parseGAgentFrame(bytes) {
  if (bytes.length < 7) return null;
  if (bytes[0] !== 0x00 || bytes[1] !== 0x00 || bytes[2] !== 0x00 || bytes[3] !== 0x03) {
    return null;
  }
  const vi = decodeVarint(bytes, 4);
  if (!vi) return null;
  const totalLen = vi.nextOffset + vi.value;
  if (bytes.length < totalLen) return null;
  const flag = bytes[vi.nextOffset];
  const cmd = (bytes[vi.nextOffset + 1] << 8) | bytes[vi.nextOffset + 2];
  const payload = bytes.slice(vi.nextOffset + 3, totalLen);
  return { flag, cmd, payload, totalLen };
}

/**
 * Build 5-byte big-endian attr_flags mask for a list of attr IDs (0..33).
 * Bit 0 of byte 4 = attr id 0; bit 1 of byte 0 = attr id 33.
 */
export function buildAttrFlags(attrIds) {
  let mask = 0n;
  for (const id of attrIds) {
    mask |= 1n << BigInt(id);
  }
  const out = new Uint8Array(ATTR_FLAGS_BYTES);
  for (let i = ATTR_FLAGS_BYTES - 1; i >= 0; i--) {
    out[i] = Number(mask & 0xffn);
    mask >>= 8n;
  }
  return out;
}

export function decodeAttrFlags(flagBytes) {
  let mask = 0n;
  for (let i = 0; i < flagBytes.length; i++) {
    mask = (mask << 8n) | BigInt(flagBytes[i]);
  }
  const ids = [];
  for (let id = 0; id < TOTAL_ATTRS; id++) {
    if ((mask >> BigInt(id)) & 1n) ids.push(id);
  }
  return ids;
}

/**
 * Build P0 var_len READ packet (cmd=0x0093, action=0x12).
 */
export function buildReadAttrsPacket(sn, attrIds = ALL_ATTR_IDS) {
  const flags = buildAttrFlags(attrIds);
  const payload = new Uint8Array(4 + 1 + flags.length);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, sn >>> 0, false);
  payload[4] = 0x12;
  payload.set(flags, 5);
  return buildGAgentFrame(0x0093, payload);
}

/**
 * Build P0 var_len WRITE packet (cmd=0x0093, action=0x11).
 * `updates` is an object mapping attr names to JS values:
 *   bool -> boolean
 *   uint8/16/32 -> user-level number (addition is subtracted automatically)
 *   binary -> Uint8Array or number[] of exact attr.len
 */
export function buildWriteAttrsPacket(sn, updates) {
  const entries = Object.entries(updates).map(([name, value]) => {
    const attr = ATTR_BY_NAME[name];
    if (!attr) throw new Error(`Unknown attribute: ${name}`);
    return { attr, value };
  });
  entries.sort((a, b) => a.attr.id - b.attr.id);

  const flags = buildAttrFlags(entries.map((e) => e.attr.id));
  const boolEntries = entries.filter((e) => e.attr.type === 'bool');
  const nonBoolEntries = entries.filter((e) => e.attr.type !== 'bool');

  const chunks = [];

  if (boolEntries.length > 0) {
    const nBoolBytes = Math.ceil(boolEntries.length / 8);
    let bits = 0;
    boolEntries.forEach((e, idx) => {
      if (e.value) bits |= 1 << idx;
    });
    const bArr = new Uint8Array(nBoolBytes);
    for (let i = nBoolBytes - 1; i >= 0; i--) {
      bArr[i] = bits & 0xff;
      bits >>= 8;
    }
    chunks.push(bArr);
  }

  for (const { attr, value } of nonBoolEntries) {
    if (attr.type === 'uint8') {
      const raw = Math.max(0, Math.min(255, Math.round(value - (attr.addition || 0))));
      chunks.push(new Uint8Array([raw]));
    } else if (attr.type === 'uint16') {
      const raw = Math.max(0, Math.min(65535, Math.round(value - (attr.addition || 0))));
      const arr = new Uint8Array(2);
      new DataView(arr.buffer).setUint16(0, raw, false);
      chunks.push(arr);
    } else if (attr.type === 'uint32') {
      const raw = Math.max(0, Math.min(0xffffffff, Math.round(value - (attr.addition || 0))));
      const arr = new Uint8Array(4);
      new DataView(arr.buffer).setUint32(0, raw, false);
      chunks.push(arr);
    } else if (attr.type === 'binary') {
      const arr = new Uint8Array(attr.len);
      for (let i = 0; i < Math.min(attr.len, value.length); i++) {
        arr[i] = value[i] & 0xff;
      }
      chunks.push(arr);
    }
  }

  const valLen = chunks.reduce((s, c) => s + c.length, 0);
  const payload = new Uint8Array(4 + 1 + flags.length + valLen);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, sn >>> 0, false);
  payload[4] = 0x11;
  payload.set(flags, 5);
  let off = 5 + flags.length;
  for (const c of chunks) {
    payload.set(c, off);
    off += c.length;
  }
  return buildGAgentFrame(0x0093, payload);
}

/**
 * Decode P0 var_len values from action=0x13 (read response) or action=0x14 (write ACK/report).
 */
export function decodeVarLenPayload(flagBytes, valueBytes) {
  const ids = decodeAttrFlags(flagBytes);
  const selected = ids.map((id) => ATTRS[id]);
  const boolAttrs = selected.filter((a) => a.type === 'bool');
  const nonBoolAttrs = selected.filter((a) => a.type !== 'bool');

  const result = {};
  let pos = 0;

  if (boolAttrs.length > 0) {
    const nBoolBytes = Math.ceil(boolAttrs.length / 8);
    let bits = 0;
    for (let i = 0; i < nBoolBytes; i++) {
      bits = (bits << 8) | valueBytes[pos++];
    }
    boolAttrs.forEach((a, idx) => {
      result[a.name] = Boolean((bits >> idx) & 1);
    });
  }

  const dv = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
  for (const a of nonBoolAttrs) {
    if (pos + a.len > valueBytes.length) break;
    if (a.type === 'uint8') {
      result[a.name] = valueBytes[pos] + (a.addition || 0);
    } else if (a.type === 'uint16') {
      result[a.name] = dv.getUint16(pos, false) + (a.addition || 0);
    } else if (a.type === 'uint32') {
      result[a.name] = dv.getUint32(pos, false) + (a.addition || 0);
    } else if (a.type === 'binary') {
      result[a.name] = Array.from(valueBytes.slice(pos, pos + a.len));
    }
    pos += a.len;
  }

  return result;
}

export function buildGetPasscodePacket() {
  return buildGAgentFrame(0x0006);
}

export function buildLoginPacket(passcodeBytes) {
  const payload = new Uint8Array(2 + passcodeBytes.length);
  payload[0] = (passcodeBytes.length >> 8) & 0xff;
  payload[1] = passcodeBytes.length & 0xff;
  payload.set(passcodeBytes, 2);
  return buildGAgentFrame(0x0008, payload);
}

/**
 * Build a remark3 live preview payload (10 bytes):
 *   [enable(0|1), numChannels, ch1..ch8]
 */
export function buildPreviewPayload(enabled, channels, numChannels = 4) {
  const arr = new Uint8Array(10);
  arr[0] = enabled ? 1 : 0;
  arr[1] = numChannels;
  for (let i = 0; i < Math.min(8, channels.length); i++) {
    arr[2 + i] = Math.max(0, Math.min(100, Math.round(channels[i])));
  }
  return arr;
}

/**
 * Compute timestamp for clock sync.
 * Verified on ASTRA_freshwate (LEGIZ308): the MCU adds a hardcoded +8h (China Standard Time)
 * offset to whatever uint32 timestamp it receives.
 * - 'beijing_local' (default): localWallSec - 8h -> MCU (+8h) equals exact local wall time & weekday!
 * - 'local': raw local wall-clock seconds
 * - 'utc': standard Unix UTC seconds
 */
export function computeSyncTimestamp(clockMode = 'beijing_local', now = new Date()) {
  const utcSec = Math.floor(now.getTime() / 1000);
  if (clockMode === 'utc') return utcSec;
  const localWallSec = utcSec - now.getTimezoneOffset() * 60;
  if (clockMode === 'local') return localWallSec;
  return localWallSec - 8 * 3600;
}

/**
 * Interpolate channel intensities at any minute of day (0..1439) for a sorted schedule.
 */
export function interpolateSchedule(nodes, minuteOfDay, numChannels = 4) {
  if (!nodes || nodes.length === 0) return Array(numChannels).fill(0);
  const sorted = [...nodes].sort((a, b) => a.time - b.time);
  if (minuteOfDay <= sorted[0].time) return [...sorted[0].channels.slice(0, numChannels)];
  const last = sorted[sorted.length - 1];
  if (minuteOfDay >= last.time) return [...last.channels.slice(0, numChannels)];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (minuteOfDay >= a.time && minuteOfDay <= b.time) {
      const span = b.time - a.time;
      const t = span === 0 ? 0 : (minuteOfDay - a.time) / span;
      return Array.from({ length: numChannels }, (_, c) =>
        Math.round(a.channels[c] + (b.channels[c] - a.channels[c]) * t)
      );
    }
  }
  return Array(numChannels).fill(0);
}
