/**
 * Unit tests verifying docs/js/protocol.js against real packets captured from XPG-GAgent-e0ec.
 */

import assert from 'node:assert/strict';
import {
  ALL_ATTR_IDS,
  buildAttrFlags,
  buildPreviewPayload,
  buildReadAttrsPacket,
  buildWriteAttrsPacket,
  computeSyncTimestamp,
  decodeVarLenPayload,
  interpolateSchedule,
  parseGAgentFrame,
  toHex,
} from '../docs/js/protocol.js';

function fromHex(hex) {
  return Uint8Array.from(hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
}

// 1. Verify read-all packet matches exact bytes we sent to XPG-GAgent-e0ec
const readAllPkt = buildReadAttrsPacket(1, ALL_ATTR_IDS);
assert.equal(
  toHex(readAllPkt),
  '00 00 00 03 0D 00 00 93 00 00 00 01 12 03 FF FF FF FF'
);

// 2. Verify decoding the REAL 217-byte live status packet captured from the user's light
const realRx = fromHex(
  '00 00 00 03 D3 01 00 00 94 00 00 00 01 13 03 FF FF FF FF 05 04 03 01 00 02 00 00 00 ' +
  '01 68 02 D0 04 38 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 50 00 14 14 14 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 0D 5F 00 14 28 14 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 50 00 14 14 14 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 50 00 14 14 14 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '01 01 01 01 01 01 01 ' +
  '00 00 00 00 00 00 00 00 00 00'
);

const parsed = parseGAgentFrame(realRx);
assert.ok(parsed, 'Failed to parse 217-byte GAgent frame');
assert.equal(parsed.cmd, 0x0094);
assert.equal(parsed.totalLen, 217);
assert.equal(parsed.payload[4], 0x13);

const state = decodeVarLenPayload(parsed.payload.slice(5, 10), parsed.payload.slice(10));
assert.equal(state.onOff, true);
assert.equal(state.mesh, false);
assert.equal(state.remark4, true);
assert.equal(state.haveColour, 4);
assert.equal(state.nodeNum, 3);
assert.equal(state.mode, 2); // raw 1 + addition 1 = 2 (Manual 1)
assert.equal(state.deviceType, 1); // raw 0 + addition 1 = 1
assert.equal(state.nodeTime1, 360);
assert.equal(state.nodeTime2, 720);
assert.equal(state.nodeTime3, 1080);
assert.equal(state.colour2[12], 13); // Manual 1 dim red!
assert.equal(state.colour2[13], 95); // Manual 2
assert.deepEqual(state.cycleDate, [1, 1, 1, 1, 1, 1, 1]);

// 3. Verify preview write packet matches exact bytes ACKed by hardware in channel_test.py
const previewPkt = buildWriteAttrsPacket(4, {
  remark3: buildPreviewPayload(true, [35, 0, 0, 0], 4),
});
assert.equal(
  toHex(previewPkt),
  '00 00 00 03 17 00 00 93 00 00 00 04 11 02 00 00 00 00 01 04 23 00 00 00 00 00 00 00'
);

// 4. Verify mode write subtracts addition=1 properly (mode=1 Auto -> raw 0x00)
const autoPkt = buildWriteAttrsPacket(9, { onOff: true, mode: 1 });
const autoFrame = parseGAgentFrame(autoPkt);
const autoDecoded = decodeVarLenPayload(autoFrame.payload.slice(5, 10), autoFrame.payload.slice(10));
assert.equal(autoDecoded.onOff, true);
assert.equal(autoDecoded.mode, 1);

// 5. Verify schedule interpolation
const nodes = [
  { time: 600, channels: [0, 0, 0, 0] },
  { time: 720, channels: [100, 80, 60, 40] },
];
assert.deepEqual(interpolateSchedule(nodes, 660, 4), [50, 40, 30, 20]);

// 6. Verify MCU UTC+8 compensated timestamp math
const fakeNow = new Date('2026-11-22T22:06:00Z'); // 16:06 CST (UTC-6)
const mcuTs = computeSyncTimestamp('beijing_local', fakeNow);
const mcuView = new Date((mcuTs + 8 * 3600) * 1000);
assert.equal(mcuView.getUTCHours(), fakeNow.getHours());
assert.equal(mcuView.getUTCMinutes(), fakeNow.getMinutes());
assert.equal(mcuView.getUTCDay(), fakeNow.getDay());

// 7. Verify single-packet atomic schedule round-trip
const atomicSchedPkt = buildWriteAttrsPacket(10, {
  onOff: true,
  nodeNum: 3,
  mode: 1,
  nodeTime1: 360,
  nodeTime2: 720,
  nodeTime3: 1080,
  timestamp: mcuTs,
  colour1: [0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 21, 80, 0, 20, 20, 20],
  colour2: [0, 70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 95, 0, 20, 40, 20],
  colour3: [0, 80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 80, 0, 20, 20, 20],
  colour4: [0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 80, 0, 20, 20, 20],
  cycleDate: [1, 1, 1, 1, 1, 1, 1],
});
const atomicParsed = parseGAgentFrame(atomicSchedPkt);
assert.ok(atomicParsed && atomicParsed.totalLen < 180);
const atomicDecoded = decodeVarLenPayload(
  atomicParsed.payload.slice(5, 10),
  atomicParsed.payload.slice(10)
);
assert.equal(atomicDecoded.onOff, true);
assert.equal(atomicDecoded.mode, 1);
assert.equal(atomicDecoded.nodeNum, 3);
assert.equal(atomicDecoded.nodeTime2, 720);
assert.equal(atomicDecoded.timestamp, mcuTs);
assert.equal(atomicDecoded.colour1[1], 60);
assert.equal(atomicDecoded.colour1[12], 21); // manual preset preserved!

console.log('ALL PROTOCOL UNIT TESTS PASSED!');
