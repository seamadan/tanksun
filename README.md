# TankSun

Personal Web Bluetooth controller and 24-hour scheduler for the **Erreloda / OceanTech** Bluetooth LED aquarium light (`ASTRA_freshwate`, `XPG-GAgent-*`).

Works natively in:
- **Bluefy** (free iOS Web Bluetooth browser on iPhone/iPad)
- **Chrome / Edge** on Windows & macOS

## Features

- **24-Hour Automated Schedule Editor** — interactive curve chart with up to 12 time nodes, day-of-week selector (Mon–Sun), quick templates, live time-of-day preview scrubber, and automatic clock sync.
- **Manual Control + 6 Onboard Saved Presets** — real-time 4-channel sliders, master brightness scaler, and direct read/write to all 6 onboard preset slots (without overwriting your schedule!).
- **Channel Tester & Customizer** — flash any individual channel to confirm its physical color, rename channels & presets, and export/import JSON backups.
- **Zero-build static site** — lives in `docs/`, ready for instant GitHub Pages deployment.

## Test Locally on Windows (Chrome / Edge)

```powershell
npx serve docs -l 8080
# or
uv run python -m http.server 8080 --directory docs
```

Then open `http://localhost:8080` in Chrome or Edge and click **Connect via Bluetooth** (make sure the OceanTech app is closed on your phone).

## Publish to GitHub Pages (for Bluefy on iPhone)

1. Create a new repository on GitHub (e.g. `tanksun`).
2. Upload the `docs/` folder (or push this whole repo).
3. Go to **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: `main` / Folder: `/docs` → **Save**
4. Open `https://<your-username>.github.io/tanksun/` in **Bluefy** on your iPhone and bookmark it!

## Hardware & Protocol Notes

- **Device:** `XPG-GAgent-*` (LinkedSemi LE501x BLE SoC running Gizwits GAgent `LEGIZ308`)
- **Advertised Service UUID:** `0000f0ab-0000-1000-8000-00805f9b34fb`
- **GATT Service / Characteristic:** `0000abf0-...` / `0000abf7-...` (`notify`, `write-without-response`)
- **Protocol:** Gizwits GAgent v3 (`00 00 00 03`) + `var_len` (`0x00000004`, 34 datapoints, `captures/datapoint_schema.json`)
- **Verified Power Polarity:** `onOff = true (1)` is ON, `false (0)` is OFF.
