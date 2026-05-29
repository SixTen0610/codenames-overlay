# Codenames Bot — Setup & Usage Guide

## What It Does
- Joins your codenames.game room as a headless spectator
- Reads team assignments (operatives + spymasters) as players join
- Auto-starts the correct team's turn timer in your v5 overlay via OBS WebSocket
- Tracks card reveals, assassin hits, and game end
- Writes win/loss and assassin stats directly to localStorage for accurate player stats
- Auto-adds new players to your roster

---

## One-Time Setup

### Step 1 — Edit config in bot.js
Open `bot.js` in Notepad and find the CONFIG block near the top:

```js
const CONFIG = {
  obsHost:     'ws://localhost:4455',
  obsPassword: '',   // ← paste your OBS websocket password here
  ...
}
```

To find your OBS password:
1. OBS → Tools → WebSocket Server Settings
2. Copy the password shown there

### Step 2 — Make sure Chromium is available
The bot uses your system Chrome browser. Set the path in bot.js:

```js
executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
```

Find this line in the `joinRoom` function and update it with your Chrome path.
Open a command prompt in your Stat Bot Folder

### Step 3 npm_install
Let the Node Modules install

### Step 4 — Run it
Double-click **START-BOT.bat**

The control panel will open automatically at http://localhost:7842

---

## Every Stream

1. Double-click **START-BOT.bat**
2. Control panel opens in your browser
3. Start your codenames.game room as normal
4. Paste the room URL into the control panel
5. Click **▶ Start**
6. Bot joins as spectator — teams, turns and stats all track automatically

---

## What Gets Automated

| Event | What Happens |
|---|---|
| Player joins Blue/Red | Name added to roster, shown in control panel |
| Turn changes | v5 overlay turn timer starts automatically |
| Clue given | Shown in control panel |
| Card revealed | Tracked internally |
| Assassin hit | Player stat updated in localStorage |
| Game ends | Win/loss written to cn_player_stats for all players |

---

## Troubleshooting

**OBS shows Disconnected**
- Make sure OBS is running and WebSocket server is enabled
- Check Tools → WebSocket Server Settings → Enable checkbox

**Bot can't join the room**
- Make sure the URL is in format: https://codenames.game/r/xxxx-xxxxx
- Try opening the URL in a regular Chrome window first to make sure it's valid

**Turn timer not auto-starting**
- The bot fires `startTurnTimer()` in your overlay via OBS WebSocket
- Make sure your Codenames overlay browser source is active and named something containing "codi", "codename", or "overlay"
- Check the bot log for "OBS not connected" messages

**Player names not showing**
- Names are parsed from the team panels as they appear
- Players must be in the room before the bot joins to be detected on first load
- Names update live as players join during the session

---

## Files
- `bot.js` — main bot logic
- `control.html` — control panel UI
- `START-BOT.bat` — double-click to run
- `package.json` — dependencies
