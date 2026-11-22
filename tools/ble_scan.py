"""TankSun BLE Scanner & GATT Inspector.

Usage:
    uv run python tools/ble_scan.py
    uv run python tools/ble_scan.py --timeout 10
    uv run python tools/ble_scan.py --connect <ADDRESS_OR_NAME_SUBSTRING>
    uv run python tools/ble_scan.py --monitor <ADDRESS_OR_NAME_SUBSTRING> --duration 15
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from bleak import BleakClient, BleakScanner


def format_hex(data: bytes | bytearray) -> str:
    return " ".join(f"{b:02X}" for b in data)


async def scan_devices(timeout: float = 8.0, show_unnamed: bool = False) -> list[dict[str, Any]]:
    print(f"Scanning for BLE devices ({timeout:.0f}s)...")
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)

    rows: list[dict[str, Any]] = []
    for address, (device, adv) in discovered.items():
        name = adv.local_name or device.name or ""
        if not name and not show_unnamed:
            continue
        mfg = {f"0x{k:04X}": format_hex(v) for k, v in (adv.manufacturer_data or {}).items()}
        svc_data = {k: format_hex(v) for k, v in (adv.service_data or {}).items()}
        rows.append(
            {
                "name": name or "<unnamed>",
                "address": address,
                "rssi": adv.rssi,
                "service_uuids": list(adv.service_uuids or []),
                "manufacturer_data": mfg,
                "service_data": svc_data,
            }
        )

    rows.sort(key=lambda r: r["rssi"] if r["rssi"] is not None else -999, reverse=True)

    print(f"\nFound {len(rows)} {'' if show_unnamed else 'named '}BLE device(s) (total discovered: {len(discovered)}):\n")
    print(f"{'RSSI':>5}  {'ADDRESS':<20}  {'NAME':<28}  DETAILS")
    print("-" * 100)
    for r in rows:
        details = []
        if r["service_uuids"]:
            details.append(f"svcs={r['service_uuids']}")
        if r["manufacturer_data"]:
            details.append(f"mfg={r['manufacturer_data']}")
        if r["service_data"]:
            details.append(f"svc_data={r['service_data']}")
        print(f"{str(r['rssi']):>5}  {r['address']:<20}  {r['name']:<28}  {'; '.join(details)}")

    return rows


async def resolve_target(target: str, timeout: float = 8.0):
    print(f"Looking for BLE device matching '{target}'...")
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    target_lower = target.lower()

    for address, (device, adv) in discovered.items():
        name = (adv.local_name or device.name or "").lower()
        if address.lower() == target_lower or (name and target_lower in name):
            print(f"Matched: {adv.local_name or device.name or '<unnamed>'} [{address}] (RSSI {adv.rssi})")
            return device, adv

    raise SystemExit(f"Could not find a BLE device matching '{target}'. Is it powered on and disconnected from your phone?")


async def inspect_gatt(target: str, timeout: float = 8.0, save_json: Path | None = None) -> None:
    device, adv = await resolve_target(target, timeout=timeout)

    dump: dict[str, Any] = {
        "captured_at": datetime.now().isoformat(),
        "name": adv.local_name or device.name,
        "address": device.address,
        "rssi": adv.rssi,
        "advertised_services": list(adv.service_uuids or []),
        "manufacturer_data": {f"0x{k:04X}": format_hex(v) for k, v in (adv.manufacturer_data or {}).items()},
        "services": [],
    }

    print(f"\nConnecting to {device.address}...")
    async with BleakClient(device, timeout=15.0) as client:
        print(f"Connected! MTU={getattr(client, 'mtu_size', 'unknown')}\n")
        for service in client.services:
            svc_entry: dict[str, Any] = {
                "uuid": service.uuid,
                "handle": service.handle,
                "description": service.description,
                "characteristics": [],
            }
            print(f"[Service] {service.uuid} (handle=0x{service.handle:04X}) — {service.description}")
            for char in service.characteristics:
                props = list(char.properties)
                value_hex = None
                value_ascii = None
                read_err = None
                if "read" in props:
                    try:
                        raw = await client.read_gatt_char(char.uuid)
                        value_hex = format_hex(raw)
                        try:
                            decoded = raw.decode("utf-8").strip("\x00")
                            if decoded and all(32 <= ord(c) < 127 for c in decoded):
                                value_ascii = decoded
                        except UnicodeDecodeError:
                            pass
                    except Exception as exc:
                        read_err = str(exc)

                char_entry: dict[str, Any] = {
                    "uuid": char.uuid,
                    "handle": char.handle,
                    "description": char.description,
                    "properties": props,
                    "value_hex": value_hex,
                    "value_ascii": value_ascii,
                    "read_error": read_err,
                    "descriptors": [
                        {"uuid": d.uuid, "handle": d.handle, "description": d.description}
                        for d in char.descriptors
                    ],
                }
                svc_entry["characteristics"].append(char_entry)

                val_str = ""
                if value_hex is not None:
                    val_str = f" | val=[{value_hex}]" + (f' ("{value_ascii}")' if value_ascii else "")
                elif read_err:
                    val_str = f" | read_err={read_err}"

                print(
                    f"  [Char] {char.uuid} (handle=0x{char.handle:04X}) "
                    f"props={props}{val_str}"
                )
                for d in char.descriptors:
                    print(f"    [Desc] {d.uuid} (handle=0x{d.handle:04X}) — {d.description}")

            dump["services"].append(svc_entry)

    if save_json:
        save_json.parent.mkdir(parents=True, exist_ok=True)
        save_json.write_text(json.dumps(dump, indent=2), encoding="utf-8")
        print(f"\nSaved GATT profile to {save_json}")


async def monitor_notifications(target: str, duration: float = 15.0, timeout: float = 8.0) -> None:
    device, _ = await resolve_target(target, timeout=timeout)

    print(f"\nConnecting to {device.address} to monitor notifications for {duration:.0f}s...")
    async with BleakClient(device, timeout=15.0) as client:
        subscribed = []
        for service in client.services:
            for char in service.characteristics:
                if "notify" in char.properties or "indicate" in char.properties:
                    def make_cb(uuid: str):
                        def _cb(_sender, data: bytearray) -> None:
                            ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                            print(f"[{ts}] NOTIFY {uuid}: {format_hex(data)}  (len={len(data)})")
                        return _cb

                    try:
                        await client.start_notify(char.uuid, make_cb(char.uuid))
                        subscribed.append(char.uuid)
                        print(f"Subscribed to {char.uuid} ({char.properties})")
                    except Exception as exc:
                        print(f"Failed to subscribe to {char.uuid}: {exc}")

        if not subscribed:
            print("No notify/indicate characteristics found.")
            return

        print(f"\nListening for {duration:.0f}s...")
        await asyncio.sleep(duration)


def main() -> None:
    parser = argparse.ArgumentParser(description="TankSun BLE scanner & GATT inspector")
    parser.add_argument("--timeout", type=float, default=8.0, help="BLE scan duration in seconds")
    parser.add_argument("--all", action="store_true", help="Include unnamed BLE devices in scan output")
    parser.add_argument("--connect", type=str, help="Connect and dump GATT services for matching address or name")
    parser.add_argument("--save", type=Path, help="Optional JSON path to save the GATT dump")
    parser.add_argument("--monitor", type=str, help="Subscribe to notify characteristics and print packets")
    parser.add_argument("--duration", type=float, default=15.0, help="Monitor duration in seconds")
    args = parser.parse_args()

    if args.connect:
        asyncio.run(inspect_gatt(args.connect, timeout=args.timeout, save_json=args.save))
    elif args.monitor:
        asyncio.run(monitor_notifications(args.monitor, duration=args.duration, timeout=args.timeout))
    else:
        asyncio.run(scan_devices(timeout=args.timeout, show_unnamed=args.all))


if __name__ == "__main__":
    main()
