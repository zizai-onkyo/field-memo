# Field Memo

A stopwatch-style web app for taking timed notes on "good" and "noisy" sections while recording outdoor ambient sound.
It records times only (the audio itself is recorded on a separate recorder). It makes no sound.

## How to use

1. **Start**: press the app's REC button at the same time as the recorder's record button, and keep holding for 0.8 s until the ring completes.
   The moment your finger **touches** the screen becomes 0 s, so it stays in sync with the recorder (a short tap won't start it).
2. While recording, press the buttons at the bottom of the screen:
   - **OK** … marks everything up to now as an OK section
   - **区切る (Split)** … just ends the section here (decide OK/NG later)
   - **NG** … marks everything up to now as an NG section
   - Time is recorded the moment your finger touches. A different button pressed within 1.5 s of a split counts as a correction of the previous section's verdict.
   - Tapping a badge (OK / NG / 未判定 "Undecided") in the list cycles its verdict.
   - "直前の区切りを取消" (Undo last split) only takes effect when **tapped twice**.
3. **Stop**: slide the red knob at the top all the way to the right (a tap or a half slide won't stop it).
4. The edit screen opens after stopping. Tap a section to change OK / NG or add a note, or merge it with the next section.
5. Export with "CSVをダウンロード" (Download CSV) or "共有…" (Share…: AirDrop, Save to Files, etc.). The list screen has "全件CSV" (export all).

### If the page reloads during recording
The state is saved continuously, so if Safari reloads the page the app **automatically returns to the recording**.
Elapsed time is computed from the start time, so time stays correct even if the screen goes off.

## CSV format

UTF-8 (with BOM, so it opens in Excel without garbled text). One row per section.

| Column | Example |
|---|---|
| 記録名 (Recording name) | 2026-10-08 14:23:05 (can be renamed on the edit screen) |
| 区間 (Section) | 1, 2, 3 … |
| 判定 (Verdict) | OK / NG / 未判定 (Undecided) |
| 開始 / 終了 / 長さ (Start / End / Length) | 00:01:23.456 |
| 開始(秒) / 終了(秒) / 長さ(秒) (Start / End / Length in seconds) | 83.456 |
| 開始時刻 / 終了時刻 (Start / End clock time) | 2026-10-08 14:24:28 (for matching against the recorder's file timestamps) |
| メモ (Note) | free text |

## Using it on an iPhone

It must be served over HTTPS (it won't work if you open the files directly). For example:

- **GitHub Pages**: put this folder in a repository and enable Pages
- **Netlify Drop** (https://app.netlify.com/drop): just drag this folder in

Once you open the URL in Safari, **use Share → Add to Home Screen**.
- It then opens without signal (offline) and full screen
- Safari may delete data from sites that haven't been used for a while, but this does not happen for apps added to the Home Screen
- Note: data in Safari and data in the Home Screen app are stored separately

Records live only inside the browser on that device. Export them as CSV regularly.

While recording, the app tries to keep the screen on (shown as "画面ON維持中" (keeping screen on) at the top right).
If it shows "自動ロック注意" (auto-lock warning), setting Settings > Display & Brightness > Auto-Lock to "Never" is the safe choice.

## Updating

When you change the app's files, bump the version of `CACHE` in `sw.js` (e.g. `fieldmemo-v2`).
Otherwise phones may keep showing the old cached version.

## Files

- `index.html` / `style.css` / `app.js` … the app itself
- `sw.js` … offline cache
- `manifest.webmanifest` / `icons/` … for Add to Home Screen
