# 🎬 GOING LIVE — Pre-Stream Checklist

**Streamer:** SixTen | **Stream:** twitch.tv/61osixten | **Server:** The Syndicate

---

## 🎧 STAGE 1 — Audio Foundation (do first!)

- [ ] **Headset powered on** and Bluetooth-paired to PC
- [ ] **Open Voicemeeter Potato**
  - [ ] A1 = SteelSeries Arctis 9X
  - [ ] A2 = Desktop Speakers (no mic)
  - [ ] All input strips loaded with the "Streaming" preset (Menu → Load Settings → Streaming)
- [ ] **Open Discord**
  - [ ] Verify Input: Voicemeeter Out B2
  - [ ] Verify Output: Voicemeeter AUX Input
  - [ ] Join your Voice Channel
  - [ ] Test: speak — see your VC bubble pulse + see your Microphone strip bouncing in Voicemeeter
  - [ ] Have someone speak (or play test audio in another tab) — verify the **Discord Out** strip in Voicemeeter bounces (NOT the Spotify strip)

> 🔥 **Audio quick test:** play Spotify briefly → confirm you hear it AND your "My Mic" meter bounces in OBS. If both ✅ — audio chain is good.

---

## 💻 STAGE 2 — Browser & Bot Setup

- [ ] **Open MS Edge** — codenames.game (this becomes your **Stream View**)
- [ ] **Open Chrome** — codenames.game (this becomes your **Spymaster View** — for your secret card colors)
- [ ] Create a new game in one of the windows → grab the room URL
- [ ] **Open Codenames Bot** (`C:\Codenames-bot\codenames-bot\START-BOT.bat`)
  - [ ] Verify cmd window shows `✅ OBS Connected`
  - [ ] Verify `📺 Overlay connected (1 total)` after OBS Codies scene is active
  - [ ] Open control panel: http://localhost:7842
  - [ ] Paste game URL into the bot → click **▶ Start**
  - [ ] Verify `🔁 Resumed prior session` (if rejoining) OR fresh `✅ Joined room`
  - [ ] Verify `📨 Discord (game-links) notified (HTTP 204)` (game URL posted)
  - [ ] Verify `📨 Discord (announcement) notified (HTTP 204)` (announcement posted)

---

## 🎮 STAGE 3 — OBS Scenes & Sources

- [ ] **Open OBS Studio**
- [ ] **Switch to Codies scene**
  - [ ] Codenames overlay loads (turn timers visible, scoreboard at top)
  - [ ] VS Panel hidden until spymasters assigned (expected)
  - [ ] Discord VC panel visible on left edge
- [ ] **Prep Gaming scene** if you'll switch to it
- [ ] **Check audio mixer**:
  - [ ] My Mic meter shows activity when you talk
  - [ ] Rollin Sound / SWED Sound / etc. listed as Active
  - [ ] OWN3D Pro browser source: Active
  - [ ] Discord VC browser source: visible (if you use it for bubbles)

---

## 🎵 STAGE 4 — Music & Soundboard

- [ ] **Spotify** — open and verify
  - [ ] Output device = Voicemeeter Input (check Volume Mixer if unsure)
  - [ ] Stream playlist queued
  - [ ] Test play — Spotify strip bounces in Voicemeeter
- [ ] **Songify** — open
  - [ ] Verify current Spotify song appears
  - [ ] Verify "now playing" widget shows on stream overlay
- [ ] **Fifine D6 Soundboard**
  - [ ] D6 control app open
  - [ ] Press a test pad → triggers !rollin in Twitch chat → alert fires in OBS

---

## 🚨 STAGE 5 — Alerts & Integrations

- [ ] **OWN3D Pro dashboard** open
  - [ ] Click "Test alert" → alert appears in OBS preview + sound plays
- [ ] **Mix It Up** open
  - [ ] Connected to Twitch (top-right shows green checkmark)
  - [ ] Send `!rollin` from chat (or self-test) → alert fires
  - [ ] Verify other commands you use are loaded

---

## 🌐 STAGE 6 — Stream Settings & Promo

- [ ] **Twitch dashboard** open in a browser tab
  - [ ] **Stream title** set (e.g., "Codenames with The Syndicate")
  - [ ] **Category:** Codenames
  - [ ] **Tags:** updated if needed
- [ ] **Discord status** — set custom status: "🎮 Live on Twitch"
- [ ] Take a moment — water nearby ☕, lighting good, camera framed

---

## ▶️ STAGE 7 — GO LIVE

- [ ] **OBS → Start Streaming**
- [ ] First 30 seconds: verify on Twitch player
  - [ ] Audio levels good (not clipping, not too quiet)
  - [ ] Webcam visible
  - [ ] Overlay rendering correctly
- [ ] **Wait for OWN3D alert chime when first viewer joins** — confirms alerts working live

---

## 🎯 IN-STREAM SANITY CHECKS (every 30-60 min)

- [ ] Codenames Bot still running (cmd window not closed)
- [ ] OBS streaming (not dropped frames red)
- [ ] Spotify still playing (Discord doesn't grab it)
- [ ] Discord VC strip bouncing when friends talk

---

## 🛑 ENDING THE STREAM

- [ ] **Switch to End Credits scene** (lets it loop for late viewers)
- [ ] **OBS → Stop Streaming**
- [ ] **Codenames Bot:** click **■ Stop** in control panel, then close cmd window
- [ ] Close: Spotify, Songify, Mix It Up, OWN3D, D6 app
- [ ] **Discord:** leave VC, update status away from "Live"

---

## 🆘 QUICK TROUBLESHOOTING REFERENCE

| Issue | Fix |
|---|---|
| **No mic on stream** | Voicemeeter — verify Mic strip B1 is ON; OBS Mic/Aux = Voicemeeter Out B1 |
| **Discord can't hear me** | Voicemeeter Mic strip — B2 must be ON |
| **Stream can't hear Spotify** | Volume Mixer → Spotify Output = Voicemeeter Input |
| **Codenames Bot disconnected** | Click ▶ Start again with same URL — it resumes the game |
| **Overlay not updating** | OBS → right-click Codies Overlay → Refresh cache |
| **OWN3D alerts silent** | OBS → browser source properties → uncheck "Control audio via OBS" |
| **Spotify keeps pausing** | Discord → User Settings → Voice & Video → Attenuation 0% |
| **Feedback / echo** | Voicemeeter Mic strip — A2 must be OFF |
