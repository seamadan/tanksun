/**
 * TankSun — Web Bluetooth Client for Gizwits GAgent BLE (0xABF0 / 0xABF7)
 * Compatible with Chrome/Edge (Desktop/Android) and Bluefy / WebBLE (iOS).
 */

import {
  ALL_ATTR_IDS,
  CHAR_UUID_DATA,
  SERVICE_UUID_ADV,
  SERVICE_UUID_GATT,
  buildGetPasscodePacket,
  buildLoginPacket,
  buildPreviewPayload,
  buildReadAttrsPacket,
  buildWriteAttrsPacket,
  computeSyncTimestamp,
  decodeVarLenPayload,
  parseGAgentFrame,
  toHex,
} from './protocol.js';

export class TankSunBLE extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.char = null;
    this.sn = 1;
    this.rxBuffer = new Uint8Array(0);
    this.pending = new Map(); // key -> { resolve, reject, timer }
    this.txQueue = Promise.resolve();
    this._onNotifyBound = (e) => this._handleNotify(e);
    this._onDisconnectBound = () => this._handleDisconnect();
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.char);
  }

  get deviceName() {
    return this.device?.name || 'TankSun Light';
  }

  _log(dir, msg) {
    this.dispatchEvent(new CustomEvent('log', { detail: { ts: new Date(), dir, msg } }));
  }

  async connect({ acceptAll = false } = {}) {
    if (!navigator.bluetooth) {
      throw new Error(
        'Web Bluetooth is not available in this browser. On iPhone, open TankSun in the Bluefy app; on Windows, use Chrome or Edge.'
      );
    }

    const options = acceptAll
      ? {
          acceptAllDevices: true,
          optionalServices: [SERVICE_UUID_GATT, SERVICE_UUID_ADV],
        }
      : {
          filters: [
            { namePrefix: 'XPG-GAgent' },
            { services: [SERVICE_UUID_ADV] },
            { services: [SERVICE_UUID_GATT] },
          ],
          optionalServices: [SERVICE_UUID_GATT, SERVICE_UUID_ADV],
        };

    this._log('INFO', acceptAll ? 'Scanning (all BLE devices)...' : 'Scanning for XPG-GAgent light...');
    const device = await navigator.bluetooth.requestDevice(options);

    if (this.device && this.device !== device) {
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnectBound);
    }
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', this._onDisconnectBound);

    return this._openAndLogin();
  }

  async reconnect() {
    if (!this.device) throw new Error('No previously paired device');
    return this._openAndLogin();
  }

  async _openAndLogin() {
    this._log('INFO', `Connecting to ${this.device.name || this.device.id}...`);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID_GATT);
    this.char = await service.getCharacteristic(CHAR_UUID_DATA);

    this.rxBuffer = new Uint8Array(0);
    this.char.removeEventListener('characteristicvaluechanged', this._onNotifyBound);
    this.char.addEventListener('characteristicvaluechanged', this._onNotifyBound);
    await this.char.startNotifications();
    this._log('INFO', 'Subscribed to 0xABF7 notifications');

    // Step 1: Request passcode (cmd=0x0006 -> reply cmd=0x0007)
    const passFrame = await this._sendAndWait(buildGetPasscodePacket(), 'cmd:0007', 4000);
    if (passFrame.payload.length < 3) {
      throw new Error('Invalid passcode reply from light');
    }
    const plen = (passFrame.payload[0] << 8) | passFrame.payload[1];
    const passcode = passFrame.payload.slice(2, 2 + plen);
    const passStr = new TextDecoder().decode(passcode);
    this._log('INFO', `Passcode received: ${passStr}`);

    // Step 2: Login (cmd=0x0008 -> reply cmd=0x0009, payload[0] === 0)
    const loginFrame = await this._sendAndWait(buildLoginPacket(passcode), 'cmd:0009', 4000);
    if (loginFrame.payload[0] !== 0x00) {
      throw new Error(`Device rejected login (code 0x${loginFrame.payload[0].toString(16)})`);
    }
    this._log('INFO', 'Logged in to light!');

    // Short settle delay for the 0x0062 online notifications
    await new Promise((r) => setTimeout(r, 150));

    // Step 3: Read full state (all 34 datapoints)
    const state = await this.readAllState();
    this.dispatchEvent(new CustomEvent('connected', { detail: { name: this.deviceName, state } }));
    return state;
  }

  disconnect() {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this._handleDisconnect();
  }

  _handleDisconnect() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Device disconnected'));
    }
    this.pending.clear();
    this.char = null;
    this._log('INFO', 'Disconnected');
    this.dispatchEvent(new CustomEvent('disconnected'));
  }

  _nextSn() {
    const current = this.sn;
    this.sn = (this.sn % 0x7fffffff) + 1;
    return current;
  }

  _handleNotify(event) {
    const dv = event.target.value;
    const chunk = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this._log('RX', `(${chunk.length}B) ${toHex(chunk)}`);

    // Append chunk to reassembly buffer
    const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
    merged.set(this.rxBuffer, 0);
    merged.set(chunk, this.rxBuffer.length);
    this.rxBuffer = merged;

    // Drain all complete frames
    while (this.rxBuffer.length >= 7) {
      // Align to magic header 00 00 00 03
      let start = -1;
      for (let i = 0; i <= this.rxBuffer.length - 4; i++) {
        if (
          this.rxBuffer[i] === 0x00 &&
          this.rxBuffer[i + 1] === 0x00 &&
          this.rxBuffer[i + 2] === 0x00 &&
          this.rxBuffer[i + 3] === 0x03
        ) {
          start = i;
          break;
        }
      }
      if (start === -1) {
        this.rxBuffer = new Uint8Array(0);
        break;
      }
      if (start > 0) {
        this.rxBuffer = this.rxBuffer.slice(start);
      }

      const frame = parseGAgentFrame(this.rxBuffer);
      if (!frame) break; // wait for more chunks

      this.rxBuffer = this.rxBuffer.slice(frame.totalLen);
      this._dispatchFrame(frame);
    }
  }

  _dispatchFrame(frame) {
    const cmdHex = frame.cmd.toString(16).padStart(4, '0');
    const cmdKey = `cmd:${cmdHex}`;

    if (frame.cmd === 0x0094 && frame.payload.length >= 4) {
      const dv = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      const sn = dv.getUint32(0, false);
      const snKey = `sn:${sn}`;
      if (this.pending.has(snKey)) {
        const p = this.pending.get(snKey);
        clearTimeout(p.timer);
        this.pending.delete(snKey);
        p.resolve(frame);
      }
      // Also emit state updates if action=0x13 or 0x14
      if (frame.payload.length >= 10) {
        const action = frame.payload[4];
        if (action === 0x13 || action === 0x14) {
          const flags = frame.payload.slice(5, 10);
          const vals = frame.payload.slice(10);
          const decoded = decodeVarLenPayload(flags, vals);
          this.dispatchEvent(new CustomEvent('state', { detail: decoded }));
        }
      }
      return;
    }

    if (this.pending.has(cmdKey)) {
      const p = this.pending.get(cmdKey);
      clearTimeout(p.timer);
      this.pending.delete(cmdKey);
      p.resolve(frame);
    }
  }

  _enqueueWrite(fn) {
    const run = this.txQueue.then(fn, fn);
    this.txQueue = run.catch(() => {});
    return run;
  }

  async _writeRaw(packet) {
    if (!this.char) throw new Error('Not connected');
    this._log('TX', `(${packet.length}B) ${toHex(packet)}`);
    if (typeof this.char.writeValueWithoutResponse === 'function') {
      try {
        await this.char.writeValueWithoutResponse(packet);
        return;
      } catch {
        // Fallback for Web Bluetooth bridges that only implement writeValue
      }
    }
    await this.char.writeValue(packet);
  }

  _sendAndWait(packet, waitKey, timeoutMs = 4000) {
    return this._enqueueWrite(
      () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(waitKey);
            reject(new Error(`Timeout waiting for ${waitKey}`));
          }, timeoutMs);
          this.pending.set(waitKey, { resolve, reject, timer });
          this._writeRaw(packet).catch((err) => {
            clearTimeout(timer);
            this.pending.delete(waitKey);
            reject(err);
          });
        })
    );
  }

  async readAllState() {
    const sn = this._nextSn();
    const pkt = buildReadAttrsPacket(sn, ALL_ATTR_IDS);
    const frame = await this._sendAndWait(pkt, `sn:${sn}`, 5000);
    if (frame.payload.length < 10) {
      throw new Error('Empty status response from light');
    }
    const flags = frame.payload.slice(5, 10);
    const vals = frame.payload.slice(10);
    return decodeVarLenPayload(flags, vals);
  }

  async writeAttrs(updates) {
    const sn = this._nextSn();
    const pkt = buildWriteAttrsPacket(sn, updates);
    const frame = await this._sendAndWait(pkt, `sn:${sn}`, 4000);
    if (frame.payload.length >= 10) {
      const flags = frame.payload.slice(5, 10);
      const vals = frame.payload.slice(10);
      return decodeVarLenPayload(flags, vals);
    }
    return {};
  }

  async setPower(isOn) {
    // Verified live on hardware: onOff=true (1) = ON, onOff=false (0) = OFF
    return this.writeAttrs({ onOff: Boolean(isOn) });
  }

  async setMode(mode) {
    // 1 = Auto Schedule, 2..7 = Manual 1..6
    return this.writeAttrs({ mode });
  }

  async setPreview(enabled, channels, numChannels = 4) {
    return this.writeAttrs({
      remark3: buildPreviewPayload(enabled, channels, numChannels),
    });
  }

  async syncClock(clockMode = 'beijing_local') {
    const ts = computeSyncTimestamp(clockMode);
    return this.writeAttrs({ timestamp: ts });
  }

  /**
   * Save a manual preset slot (slotIndex 0..5 -> Manual 1..6 -> mode 2..7).
   * Preserves bytes 0..11 (auto schedule) in each colour register.
   */
  async saveManualSlot(slotIndex, channels, currentState, activate = true) {
    const numCh = currentState.haveColour || 4;
    const updates = {};
    for (let c = 0; c < numCh; c++) {
      const name = `colour${c + 1}`;
      const existing = currentState[name] ? [...currentState[name]] : Array(18).fill(0);
      existing[12 + slotIndex] = Math.max(0, Math.min(100, Math.round(channels[c] ?? 0)));
      updates[name] = existing;
    }
    if (activate) {
      updates.onOff = true;
      updates.mode = 2 + slotIndex;
    }
    // Exit preview mode first, then commit manual preset atomically
    await this.setPreview(false, [0, 0, 0, 0], numCh);
    await this.writeAttrs(updates);
    return this.readAllState();
  }

  /**
   * Save full automated schedule (up to 12 nodes, weekday repeat, clock sync)
   * in ONE single atomic BLE packet (prevents multi-flash flicker on the light).
   * Preserves bytes 12..17 (manual presets) in each colour register.
   */
  async saveSchedule(
    nodes,
    cycleDate,
    currentState,
    { clockMode = 'beijing_local', activate = true, wasPreviewing = false } = {}
  ) {
    const numCh = currentState.haveColour || 4;
    const sorted = [...nodes].sort((a, b) => a.time - b.time).slice(0, 12);

    if (wasPreviewing) {
      await this.setPreview(false, [0, 0, 0, 0], numCh);
    }

    const updates = {
      nodeNum: sorted.length,
      cycleDate: cycleDate.map((v) => (v ? 1 : 0)),
      timestamp: computeSyncTimestamp(clockMode),
    };

    if (activate) {
      updates.onOff = true;
      updates.mode = 1;
    }

    for (let i = 0; i < 12; i++) {
      updates[`nodeTime${i + 1}`] = i < sorted.length ? sorted[i].time : 0;
    }

    for (let c = 0; c < numCh; c++) {
      const name = `colour${c + 1}`;
      const existing = currentState[name] ? [...currentState[name]] : Array(18).fill(0);
      for (let i = 0; i < 12; i++) {
        existing[i] =
          i < sorted.length ? Math.max(0, Math.min(100, Math.round(sorted[i].channels[c] ?? 0))) : 0;
      }
      updates[name] = existing;
    }

    await this.writeAttrs(updates);
    return this.readAllState();
  }
}
