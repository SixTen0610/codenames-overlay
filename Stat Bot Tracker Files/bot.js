/**
 * CODENAMES BOT v060726.auto
 * Joins your codenames.game room as spectator and:
 *   - Reads team assignments (operatives + spymasters)
 *   - Detects turn changes and auto-starts timers in v5 overlay
 *   - Tracks card reveals, assassin hits, and game end
 *   - Syncs all data to OBS browser source localStorage via WebSocket
 *   - Auto-reconnects when the room empties between games (reuses resume path)
 *   - Mirrors every log line to disk (CONFIG.logFile) so logs survive restarts
 *
 * Run: node bot.js
 */

const puppeteer  = require('puppeteer');
const { OBSWebSocket } = require('obs-websocket-js');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const WebSocket = require('ws');

// ─────────────────────────────────────────────────────────
// CONFIG — edit these to match your OBS websocket settings
// ─────────────────────────────────────────────────────────
const CONFIG = {
  obsHost:     'ws://localhost:4455',
  obsPassword: 'Riddick610',           // your OBS websocket password
  pollInterval: 1200,        // ms between game state checks
  controlPort:  7842,        // local web server port for control panel
  botName: '🤖 StatBot©',   // ← the spectator name shown in-game (rename as you like)
  // Card color map from DOM analysis
  colors: {
    '#FF9159': 'red',
    '#3DD1EE': 'blue',
    '#FFD6B0': 'neutral',
    '#8C8D8D': 'assassin',
  },
  // ── Discord integration ──
  // Webhook posts game URL + Twitch URL to a Discord channel with role pings.
  // Get webhook URL: Discord → channel → Edit Channel → Integrations → Webhooks → New Webhook
  // Get role IDs:   enable Developer Mode → right-click role → Copy Role ID
  // Treat webhookUrl like a password — anyone with it can post in that channel.
  discord: {
    enabled:     true,
    // Primary post — full rich embed in the game-links channel
    webhookUrl:  'https://discord.com/api/webhooks/1504779447482585238/NcTL0hnv6lYUpBkZXUcHmkhwxzAtKD3-SPATlNrCQ6ckyPBUhZwoRpgRIGx9ccBKFoYR',
    roleIds:     ['984543365049757827', '1496329942672085013'],
    twitchUrl:   'https://twitch.tv/61osixten',
    hostName:    'SixTen',
    serverName:  'The Syndicate',
    // Announcement post — shorter notification in a general channel pointing to game-links
    announcement: {
      enabled:    true,
      webhookUrl: 'https://discord.com/api/webhooks/1504788547662512188/7CkJlhCnh_CRsffGXnJNdKR8BL0XsbtZK6s0G8n2wQFn-jHIFOsgomFttfvxtOyqwxrd',
      gameLinksChannelId: '804879502018478102',  // renders as clickable #channel link
    },
    // ── #stats channel ──
    // Per-game posts (the AI story + a factual recap) fire as each game ends.
    // A session summary posts when you Stop the bot (control panel) or Ctrl+C.
    // Use a SEPARATE webhook here, pointed at your #stats channel.
    stats: {
      enabled:         true,
      webhookUrl:      'https://discord.com/api/webhooks/1513093853195014144/WrwfpLdCD9FFGlX7oyXCJyXlxJdj7X9-RLbkrYqyIS9TfRUM1yhXzHxJ2fFazN-07cPZ',     // ← paste your #stats channel webhook URL here
      postEachGame:    true,   // post each game's story + recap as it finishes
      postOnSessionEnd:true,   // post a session summary on Stop / Ctrl+C
    },
  },

  // ── AI Game Story (comedic recap) ──
  // After each game, the bot sends the winning team's cards + player names to
  // Claude and gets back a short comedic spy story. Written to the overlay via
  // the WebSocket bridge, displayed in the end-credits scroll.
  // Get an API key: https://console.anthropic.com → Settings → API Keys → Create Key
  // Treat apiKey like a password. Cost is ~$0.0003 per story (basically free).
  story: {
    enabled:  true,
    apiKey:   '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',                          // ← paste your Anthropic API key here (starts with sk-ant-)
    model:    'claude-haiku-4-5-20251001', // cheap + fast; good enough for short comedic recaps
    maxGames: 8,                           // cap stored stories so the end-credits scroll isn't endless
  },

  // ── Auto-reconnect ──
  // When the room empties between games, codenames.game drops the spectator and
  // the page frame detaches. Instead of pausing until a manual Start, the bot
  // re-runs joinRoom() automatically (which reuses the resume path: it restores
  // firstTeam / roleHistory / card state and skips the duplicate Discord post).
  reconnect: {
    enabled:     true,
    maxAttempts: 10,     // give up after this many consecutive failed rejoins
    baseDelayMs: 4000,   // first retry delay; doubles each attempt (exponential backoff)
    maxDelayMs:  30000,  // cap on the backoff delay so it never waits longer than this
  },

  // ── Logging ──
  // Every line printed to the console is also appended here so logs survive
  // crashes, restarts, and the console window being closed. Written next to
  // bot.js. Rotates to <logFile>.1 once it passes logMaxBytes.
  logFile:     'bot.log',
  logMaxBytes: 5 * 1024 * 1024,  // 5 MB
};

// ─────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────
let browser    = null;
let page       = null;
let obs        = new OBSWebSocket();
let obsConnected = false;
let polling    = false;
let pollTimer  = null;
let roomUrl    = null;
let discordPostOnStart = false;  // default OFF at launch; flip via control panel or the Post button

// The bot's identity token for codenames.game, generated ONCE per launch so
// the bot keeps one stable identity all session and never collides with a
// real player's credentials.
const BOT_CREDENTIALS = 'statbot-' + Math.random().toString(36).slice(2, 10)
                                   + '-' + Math.random().toString(36).slice(2, 10)
                                   + '-' + Date.now().toString(36);

let prevState  = {
  activeTurn:  null,   // 'blue' | 'red' | null
  players:     { blueOp:[], blueSpy:[], redOp:[], redSpy:[] },
  cards:       {},     // word -> { color, revealed }
  clue:        null,
  gameActive:  false,
  gameEnded:   false,
};

// Per-game role history — accumulates every (player, team, role) combo
// observed during the current game. Reset on new game.
// Shape: { 'PlayerName': Set('blue:OP', 'blue:SM', ...) }
let roleHistory = {};

// Which team went first this game (has 9 cards). null until detected.
let firstTeam = null;

// Accumulated comedic game recaps for this stream session.
// Each entry: { gameNum, winner, story, ts }. Capped at CONFIG.story.maxGames.
let sessionStories = [];
let storyGameCounter = 0;

// ── Factual per-game recaps for the #stats channel ──
// One entry per finished game this session. Each: { gameNum, winner, reason,
// firstTeam, assassin, revealed, players, durationSec, story, ts }.
// Drives both the per-game #stats post and the end-of-session summary.
let sessionGames     = [];
let sessionStartTs   = null;   // when the current session began (set on fresh join)
let gameStartTs      = null;   // when the current game began (first clue); for duration
let sessionStatsPosted = false; // guard so Stop + Ctrl+C don't double-post

// Counters for stability — prevents false-positive game-end and new-game detection
let consecutiveAllNeutralPolls = 0;  // increments while board has zero revealed cards
let consecutivePollErrors = 0;       // counts detached-frame errors before pause
let lastBroadcastTurn = null;        // dedupe turn-change broadcasts

// ── Auto-reconnect bookkeeping ──
let reconnecting      = false;  // true while an auto-reconnect attempt is in flight
let reconnectAttempts = 0;      // consecutive failed auto-rejoins; reset by a good poll
let reconnectTimer    = null;   // handle for the pending scheduled reconnect (setTimeout)
let manualStop        = false;  // set by /stop & SIGINT so a late detach won't auto-reconnect

// Pending game-end check — when the board flips at game end and the win
   // banner hasn't rendered yet, wait one extra poll for it instead of guessing.
   let pendingGameEndCheck = null;  // { timestamp }

   // Most recent poll in which EXACTLY ONE new card flipped — the "decisive
   // move" (the click that ended a turn or the game). Lets us tell a genuine
   // assassin click (single reveal) from the end-of-game board flip (many at once).
   let lastSingleReveal = null;     // { word, color, ts }

   // Guards against counting a game we joined too late to witness.
   let pollsSinceJoin = 0;
   let sessionIsFresh = false;      // true = brand-new session (not a resume)

// State persistence path — survives bot restarts
const STATE_FILE = path.join(__dirname, '.bot-state.json');

function saveStateToDisk() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      roomUrl,
      firstTeam,
      roleHistory: Object.fromEntries(
        Object.entries(roleHistory).map(([k, v]) => [k, [...v]])
      ),
      prevCards: prevState.cards,
      gameEnded: prevState.gameEnded,
      sessionStories,
      storyGameCounter,
      sessionGames,
      sessionStartTs,
      gameStartTs,
      savedAt: Date.now(),
    }, null, 2));
  } catch (e) {
    // non-fatal — disk write issues shouldn't kill the bot
  }
}

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Only restore if recent (within last 30 minutes)
    if (Date.now() - (data.savedAt || 0) > 30 * 60 * 1000) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// OBS CONNECTION
// ─────────────────────────────────────────────────────────
async function connectOBS() {
  try {
    await obs.connect(CONFIG.obsHost, CONFIG.obsPassword || undefined);
    obsConnected = true;
    log('✅ OBS Connected');
  } catch(e) {
    obsConnected = false;
    log('⚠️  OBS not connected — overlay updates disabled. (' + e.message + ')');
  }
}

// Execute JS in the v5 overlay browser source
async function obsExec(js) {
  if (!obsConnected) return;
  try {
    // Find the Codenames overlay browser source
    const { sources } = await obs.call('GetInputList');
    const cnSource = sources.find(s =>
      s.inputName?.toLowerCase().includes('codi') ||
      s.inputName?.toLowerCase().includes('codename') ||
      s.inputName?.toLowerCase().includes('overlay')
    );
    if (!cnSource) return;
    await obs.call('CallVendorRequest', {
      vendorName:    'obs-browser',
      requestType:   'emit_event',
      requestData:   { event_name: 'cn_bot_update', event_data: { js } }
    });
  } catch(e) { /* silent */ }
}

// Direct localStorage write via browser source execute
async function writeToOverlay(key, value) {
  const js = `try { localStorage.setItem('${key}', JSON.stringify(${JSON.stringify(value)})); } catch(e) {}`;
  await obsExec(js);
}

// ─────────────────────────────────────────────────────────
// PUPPETEER — join the game room
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// DISCORD WEBHOOKS — posts game info to Discord channels
// ─────────────────────────────────────────────────────────

// Generic webhook poster — returns a promise that resolves on completion
// regardless of success/failure (errors are logged, not thrown).
function postWebhook(webhookUrl, body, label) {
  return new Promise((resolve) => {
    try {
      const u = new URL(webhookUrl);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? require('https') : require('http');
      const payload = JSON.stringify(body);

      const req = lib.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            log(`📨 ${label} notified (HTTP ${res.statusCode})`);
          } else {
            log(`⚠️  ${label} webhook returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          }
          resolve();
        });
      });
      req.on('error', (e) => {
        log(`⚠️  ${label} webhook error: ${e.message}`);
        resolve();
      });
      req.write(payload);
      req.end();
    } catch (e) {
      log(`⚠️  ${label} post failed: ${e.message}`);
      resolve();
    }
  });
}

// Primary Discord post — rich embed with full game info
async function postToDiscord(roomUrl) {
  const cfg = CONFIG.discord;
  if (!cfg || !cfg.enabled || !cfg.webhookUrl) {
    log('📨 Discord post skipped (disabled or no webhook URL)');
    return;
  }

  // Build role mention string. Discord uses <@&ROLE_ID> for role pings.
  const roleMentions = (cfg.roleIds || [])
    .map(id => `<@&${id}>`)
    .join(' ');

  const embed = {
    title: '🎮 CODENAMES — Game Starting!',
    description: 'Join the fun! Click below to play or watch live.',
    color: 0xf0c040, // gold accent
    fields: [
      {
        name: '🚪 Join the Room',
        value: roomUrl,
        inline: false,
      },
      {
        name: '📺 Watch on Twitch',
        value: cfg.twitchUrl || '',
        inline: false,
      },
    ],
    footer: {
      text: `Hosted by ${cfg.hostName || 'Streamer'} • ${cfg.serverName || ''}`,
    },
    timestamp: new Date().toISOString(),
  };

  const body = {
    content: roleMentions,
    allowed_mentions: { parse: ['roles'] },
    embeds: [embed],
  };

  await postWebhook(cfg.webhookUrl, body, 'Discord (game-links)');
}

// Announcement post — shorter notification pointing to game-links channel
async function postDiscordAnnouncement() {
  const cfg = CONFIG.discord;
  if (!cfg || !cfg.announcement || !cfg.announcement.enabled || !cfg.announcement.webhookUrl) {
    return;
  }

  const ann = cfg.announcement;
  const roleMentions = (cfg.roleIds || [])
    .map(id => `<@&${id}>`)
    .join(' ');

  // Discord uses <#CHANNEL_ID> for clickable channel mentions
  const channelMention = ann.gameLinksChannelId ? `<#${ann.gameLinksChannelId}>` : '#game-links';

  const content =
    `${roleMentions}\n\n` +
    `🎮 **Codenames — Game Started!**\n` +
    `Check ${channelMention} for the Game Link.\n` +
    `Join the Voice Channel and hop into ${cfg.twitchUrl || ''}`;

  const body = {
    content: content,
    allowed_mentions: { parse: ['roles'] },
  };

  await postWebhook(ann.webhookUrl, body, 'Discord (announcement)');
}



async function joinRoom(url, opts = {}) {
  const isReconnect = !!opts.isReconnect;  // auto-reconnect path → never re-post to Discord
  if (browser) {
    await browser.close().catch(() => {});
    browser = null; page = null;
  }

  // Restore in-game state if we're rejoining the same room within 30 minutes.
  // This preserves firstTeam, role history, and current card state across
  // bot restarts — so a mid-stream crash doesn't lose your active game.
  const saved = loadStateFromDisk();
  if (saved && saved.roomUrl === url && !saved.gameEnded) {
    firstTeam = saved.firstTeam || null;
    roleHistory = Object.fromEntries(
      Object.entries(saved.roleHistory || {}).map(([k, v]) => [k, new Set(v)])
    );
    prevState.cards = saved.prevCards || {};
    prevState.gameEnded = false;
    sessionStories = saved.sessionStories || [];
    storyGameCounter = saved.storyGameCounter || 0;
    sessionGames   = saved.sessionGames || [];
    sessionStartTs = saved.sessionStartTs || Date.now();
    gameStartTs    = saved.gameStartTs || null;
    sessionStatsPosted = false;   // a resume can still post at the next session end
    consecutivePollErrors = 0;
    consecutiveAllNeutralPolls = 0;
    pendingGameEndCheck = null;
lastBroadcastTurn = null;  // let it re-broadcast on first poll
       sessionIsFresh = true;     // even on resume, verify the first poll isn't a finished board
       log(`🔁 Resumed prior session for this room (firstTeam=${firstTeam || 'unknown'})`);
     } else {
    // Fresh session — reset everything
    firstTeam = null;
    roleHistory = {};
    prevState.cards = {};
    prevState.gameEnded = false;
    sessionGames   = [];
    sessionStartTs = Date.now();
    gameStartTs    = null;
    sessionStatsPosted = false;
    consecutivePollErrors = 0;
    consecutiveAllNeutralPolls = 0;
    pendingGameEndCheck = null;
    lastBroadcastTurn = null;
    sessionIsFresh = true;     // fresh join — suppress any win on the first poll
   }
  log('🎮 Launching browser → ' + url);
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',  });

page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Set a spectator-friendly user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  // ── Seed the bot's lobby identity BEFORE the site's scripts run ──
  // codenames.game stores the player name + identity token in the 'cnd-lobby'
  // localStorage key. We give the bot its OWN name and a stable per-launch
  // credentials token so (a) trusted promoted users recognise it and don't kick
  // it, and (b) it never shares an identity with a real player (which can make
  // one session disconnect the other).
  const botName = (CONFIG.botName || 'StatBot').substring(0, 24);
  const botLobby = {
    state: {
      nickname: botName,
      credentials: BOT_CREDENTIALS,
      image: null,
      rooms: {},
    },
    version: 3,
  };
  await page.evaluateOnNewDocument((lobby) => {
    try { localStorage.setItem('cnd-lobby', JSON.stringify(lobby)); } catch (e) {}
  }, botLobby);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  log('✅ Joined room: ' + url);

  // Post to Discord on start (fire-and-forget — doesn't block polling)
  // Skip Discord post if we just resumed a session (already announced earlier)
  const isResumedSession = saved && saved.roomUrl === url && !saved.gameEnded;
  if (discordPostOnStart && !isResumedSession && !isReconnect) {
    postToDiscord(url).catch(e => log(`⚠️  Discord post error: ${e.message}`));
    postDiscordAnnouncement().catch(e => log(`⚠️  Discord announcement error: ${e.message}`));
  } else if (isReconnect) {
    log('📨 Discord post skipped (auto-reconnect — already announced)');
  } else if (isResumedSession) {
    log('📨 Discord post skipped (resumed session — already announced)');
  } else {
    log('📨 Discord post skipped (toggle off)');
  }

  // Start polling
  startPolling();
}

// ─────────────────────────────────────────────────────────
// GAME STATE POLLING
// ─────────────────────────────────────────────────────────
function startPolling() {
     if (pollTimer) clearInterval(pollTimer);
     polling = true;
     pollsSinceJoin = 0;
     lastSingleReveal = null;
     pollTimer = setInterval(pollGameState, CONFIG.pollInterval);
     log('📡 Polling started');
   }

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  polling = false;
  log('⏹  Polling stopped');
}

// ─────────────────────────────────────────────────────────
// AUTO-RECONNECT — re-runs joinRoom() when the spectator gets
// dropped (room emptied between games / frame detached).
// ─────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (!CONFIG.reconnect || !CONFIG.reconnect.enabled) return;
  if (manualStop || !roomUrl) return;
  if (reconnecting) return;                       // one attempt already in flight
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;
  if (reconnectAttempts > CONFIG.reconnect.maxAttempts) {
    log(`❌ Auto-reconnect gave up after ${CONFIG.reconnect.maxAttempts} attempts. Click Start to retry.`);
    reconnectAttempts = 0;
    return;
  }

  // Exponential backoff, capped at maxDelayMs.
  const delay = Math.min(
    CONFIG.reconnect.baseDelayMs * Math.pow(2, reconnectAttempts - 1),
    CONFIG.reconnect.maxDelayMs
  );
  log(`🔄 Auto-reconnect ${reconnectAttempts}/${CONFIG.reconnect.maxAttempts} in ${Math.round(delay / 1000)}s…`);
  reconnectTimer = setTimeout(attemptReconnect, delay);
}

async function attemptReconnect() {
  reconnectTimer = null;
  if (manualStop || !roomUrl) return;
  reconnecting = true;
  try {
    // isReconnect:true reuses the resume path (restores in-game state when the
    // saved game is still live) and suppresses any duplicate Discord post.
    await joinRoom(roomUrl, { isReconnect: true });
    log('✅ Auto-reconnect succeeded — polling resumed.');
    // reconnectAttempts is cleared by the next successful poll. If the room is
    // still empty the frame will detach again and the counter keeps climbing
    // until maxAttempts, so a permanently dead room won't loop forever.
  } catch (e) {
    log(`⚠️  Auto-reconnect failed: ${e.message}`);
    reconnecting = false;
    scheduleReconnect();   // back off and try again
    return;
  }
  reconnecting = false;
}

async function pollGameState() {
  if (!page || !polling) return;
  try {
    const state = await page.evaluate((colorMap) => {
      // ── Helper ──
      function slotText(slot) {
        const el = document.querySelector(`[data-match-slot="${slot}"]`);
        return el ? el.innerText.trim() : '';
      }

      // ── Active turn — parsed from the instruction text ──
      // The instruction slot names the active team during play, e.g.
      // "BLUE, GIVE A ONE-WORD CLUE" or "RED OPERATIVES, TAP ON CARDS".
      // We ONLY trust it during a real clue/guess step — otherwise activeTurn
      // stays null. This is critical: the old code defaulted to 'blue' whenever
      // it couldn't tell, which locked the wrong starting team. null = "no turn
      // yet", which is a valid and important state (lobby / between games).
      const instruction = slotText('instruction');
      const instrU = instruction.toUpperCase();
      const isSpymasterTurn = instrU.includes('CLUE');
      const isOperativeTurn = instrU.includes('GUESS') || instrU.includes('TAP ON');

      let activeTurn = null;
      if (isSpymasterTurn || isOperativeTurn) {
        const hasBlue = instrU.includes('BLUE');
        const hasRed  = instrU.includes('RED');
        if (hasBlue && !hasRed) activeTurn = 'blue';
        else if (hasRed && !hasBlue) activeTurn = 'red';
      }

      // Fallback ONLY if the instruction was ambiguous: the highlighted team
      // panel. Still allowed to resolve to null (never force a default color).
      if (!activeTurn) {
        const allMains = document.querySelectorAll('main[class*="activeRoleShadow"]');
        if (allMains.length > 0) {
          const mainClass = allMains[0].style?.backgroundImage || '';
          if (mainClass.includes('blue') || allMains[0].className.includes('blue')) {
            activeTurn = 'blue';
          } else if (mainClass.includes('red') || allMains[0].className.includes('red')) {
            activeTurn = 'red';
          }
        }
      }

      // ── Parse players from slot text ──
      function parsePlayers(slot) {
        const text = slotText(slot);
        const lines = text.split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && l.length < 35)
          .filter(l => !['OPERATIVES','SPYMASTERS','JOIN TEAM','JOIN',
                         'HOST','SPECTATOR','TEAM','ADMIN'].some(kw => l.toUpperCase() === kw))
          // Filter out turn timer strings like "00:22", "01:35", "-00:05"
          .filter(l => !/^-?\d{1,2}:\d{2}$/.test(l))
          // Filter out lone numbers (clue counts etc)
          .filter(l => !/^\d+$/.test(l))
          // Filter out placeholders like "-", "—", "...", single punctuation
          .filter(l => l.length >= 2 || /[a-zA-Z0-9]/.test(l))
          .filter(l => !/^[-—.…]+$/.test(l));
        // Clean ® and HOST suffix
        return lines.map(l => l.replace(/®/g,'').replace(/\s*(HOST|SPECTATOR)\s*/gi,'').trim())
                    .filter(l => l.length > 0 && !/^[-—.…]+$/.test(l));
      }

      // ── Cards ──
      // Bot is a spectator. The ONLY reliable color signal is the --CardColor
      // inline CSS var (confirmed against live DOM):
      //   --CardColor: var(--neutral-cardBg) → face-down  (true color hidden)
      //   --CardColor: var(--red-cardBg)     → REVEALED red
      //   --CardColor: var(--blue-cardBg)    → REVEALED blue
      //   --CardColor: var(--black-cardBg)   → REVEALED assassin
      // Revealed cards have NO <img> (the old img test was the bug that made
      // every reveal read as face-down). A card counts as revealed iff its
      // color resolves to red / blue / assassin. Mid-flip animation briefly
      // shows neutral, so counts only ever include fully-settled reveals.
      const articles = document.querySelectorAll('article');
      const cards = {};
      articles.forEach(article => {
        const style = article.getAttribute('style') || '';
        const cardColorMatch = style.match(/--CardColor:\s*var\(--([a-z]+)-cardBg\)/i);
        if (!cardColorMatch) return;

        const colorName = cardColorMatch[1].toLowerCase();
        // Word lives in the backface element of the card.
        const wordEl = article.querySelector('[class*="backface-hidden"]');
        const word = wordEl?.innerText?.trim().split('\n')[0]?.trim();
        if (!word || word.length === 0) return;

        let cardColor;
        if (colorName === 'red')        cardColor = 'red';
        else if (colorName === 'blue')  cardColor = 'blue';
        else if (colorName === 'black' || colorName === 'assassin') cardColor = 'assassin';
        else                            cardColor = 'neutral'; // neutral / unknown → still face-down to us

        // Only red/blue/assassin are knowable reveals. Face-down AND
        // revealed-neutral both look 'neutral' to a spectator, so we treat
        // neutral as not-revealed (neutrals never affect win/remaining math).
        const isRevealed = (cardColor === 'red' || cardColor === 'blue' || cardColor === 'assassin');

        cards[word] = { color: cardColor, revealed: isRevealed };
      });

      // ── Clue ──
      const clueText = slotText('clue');
      const clueLines = clueText.split('\n').map(l => l.trim()).filter(l => l);
      const clue = clueLines.length >= 2
        ? { word: clueLines[0], count: parseInt(clueLines[1]) || 0 }
        : null;

      // ── Game log ──
      const logText = slotText('log');

      // ── Game active ──
      const gameActive = Object.keys(cards).length > 0;

      return {
        activeTurn,
        isOperativeTurn,
        isSpymasterTurn,
        instruction,
        players: {
          blueOp:  parsePlayers('blueOp'),
          blueSpy: parsePlayers('blueSpy'),
          redOp:   parsePlayers('redOp'),
          redSpy:  parsePlayers('redSpy'),
        },
        cards,
        clue,
        logText,
        gameActive,
        cardCount: Object.keys(cards).length,
      };
    }, CONFIG.colors);

    await processState(state);
    consecutivePollErrors = 0;  // reset on successful poll
    reconnectAttempts = 0;      // a healthy poll means we're reconnected — reset the budget
    reconnecting = false;

  } catch(e) {
    const msg = e.message || '';
    const isDetachedFrame = msg.includes('detached Frame') ||
                            msg.includes('Execution context was destroyed') ||
                            msg.includes('Target closed');

    if (isDetachedFrame) {
      consecutivePollErrors++;
      // After 5 consecutive detached-frame errors, pause polling.
      // The page is gone — silent retries waste cycles and spam the log.
      if (consecutivePollErrors === 5) {
        log('⚠️  Browser frame detached (room likely emptied between games).');
        stopPolling();
        if (CONFIG.reconnect && CONFIG.reconnect.enabled && roomUrl && !manualStop) {
          scheduleReconnect();
        } else {
          log('   Auto-reconnect off — click Start to reconnect.');
        }
      } else if (consecutivePollErrors === 1) {
        log('⚠️  Poll error: ' + msg);
      }
      // suppress repeated identical errors
    } else {
      log('⚠️  Poll error: ' + msg);
    }
  }
}

// ─────────────────────────────────────────────────────────
// STATE PROCESSOR — compare to previous, fire events
// ─────────────────────────────────────────────────────────
async function processState(state) {
     pollsSinceJoin++;

  // ── Settled colored reveals (the single source of truth) ──
  // Only red/blue/assassin are knowable; neutrals stay hidden to a spectator.
  const revealedColors = { red: 0, blue: 0, assassin: 0 };
  Object.values(state.cards).forEach(c => {
    if (c.revealed && revealedColors[c.color] !== undefined) revealedColors[c.color]++;
  });
  const coloredRevealTotal = revealedColors.red + revealedColors.blue + revealedColors.assassin;
  const anyColoredReveal = coloredRevealTotal > 0;

  // ── First-team failsafe ──
  // The starting team has 9 cards; the other has 8. If we ever observe a team
  // with MORE than 8 of their color revealed, they MUST be the 9-card team —
  // so self-correct firstTeam regardless of what we guessed earlier.
  if (revealedColors.red > 8 && firstTeam !== 'red') {
    firstTeam = 'red';
    log('🎯 First-team corrected → RED (revealed >8 red cards)');
    saveStateToDisk();
  } else if (revealedColors.blue > 8 && firstTeam !== 'blue') {
    firstTeam = 'blue';
    log('🎯 First-team corrected → BLUE (revealed >8 blue cards)');
    saveStateToDisk();
  }

  // ── Turn changed ──
  // Use lastBroadcastTurn to dedupe (prevents spam when state churns
  // during game-end transitions or rapid state updates).
if (state.activeTurn && state.activeTurn !== lastBroadcastTurn && !prevState.gameEnded) {
      const prev = lastBroadcastTurn;
      const curr = state.activeTurn;
      log(`🔄 Turn changed: ${prev || 'none'} → ${curr}`);
      lastBroadcastTurn = curr;
      await onTurnChange(curr, prev, state.clue);
    }
  // ── Players changed ──
  const playersStr = JSON.stringify(state.players);
  if (playersStr !== JSON.stringify(prevState.players)) {
    log('👥 Players updated: ' + JSON.stringify(state.players));
    await onPlayersUpdate(state.players);
  }

  // ── Always update role history (silent, even when no diff) ──
  // We record every role-team-name combo we ever see during the game so
  // that on game-end we credit each player for every role they played.
  function recordRoles(names, team, role) {
    (names || []).forEach(function(n) {
      if (!roleHistory[n]) roleHistory[n] = new Set();
      roleHistory[n].add(team + ':' + role);
    });
  }
  recordRoles(state.players.blueOp,  'blue', 'OP');
  recordRoles(state.players.blueSpy, 'blue', 'SM');
  recordRoles(state.players.redOp,   'red',  'OP');
  recordRoles(state.players.redSpy,  'red',  'SM');

  // ── New clue ──
  const clueStr = JSON.stringify(state.clue);
  if (clueStr !== JSON.stringify(prevState.clue) && state.clue) {
    log(`💬 Clue: "${state.clue.word}" × ${state.clue.count}`);
    await onClue(state.clue, state.activeTurn);

    // Lock the starting (9-card) team at the FIRST clue of the game.
    // The team that gives the first clue always has 9 cards. We only auto-lock
    // when the board is still fresh (no colored reveals yet) so a mid-game
    // bot restart can't mislabel it — the >8 failsafe above covers that case.
    if (firstTeam === null && state.activeTurn && !anyColoredReveal) {
      firstTeam = state.activeTurn;
      if (!gameStartTs) gameStartTs = Date.now();   // mark game start for duration
      log(`🎯 First team this game: ${firstTeam.toUpperCase()} (gave first clue → has 9 cards)`);
      saveStateToDisk();
    }
  }

  // ── If the game already ended (latched), only watch for a true re-deal ──
  // A new game is declared ONLY when every colored reveal is gone (board fully
  // face-down again) for 2 consecutive polls. Using colored reveals — not the
  // old "any revealed" / instruction text — means a stale lingering win banner
  // over a fresh deal can no longer trigger a phantom reset.
  if (prevState.gameEnded) {
    if (!anyColoredReveal) {
      consecutiveAllNeutralPolls++;
      if (consecutiveAllNeutralPolls >= 2) {
        prevState.gameEnded = false;
        roleHistory = {};
        firstTeam = null;
        gameStartTs = null;          // next first-clue starts a fresh game clock
        lastBroadcastTurn = null;  // allow next turn to broadcast
        consecutiveAllNeutralPolls = 0;
        saveStateToDisk();
        log('🆕 New game detected — board re-dealt, tracker reset');
      }
    } else {
      consecutiveAllNeutralPolls = 0;
    }
    prevState.cards = state.cards;
    prevState.instruction = state.instruction;
    await writeOverlayState(state);
    return;
  }

// ── Win detection ──
  // Card totals follow from firstTeam: the starting team has 9, the other 8.
  const blueTotal = firstTeam === 'blue' ? 9 : firstTeam === 'red' ? 8 : null;
  const redTotal  = firstTeam === 'red'  ? 9 : firstTeam === 'blue' ? 8 : null;
  const blueLeft  = blueTotal !== null ? Math.max(0, blueTotal - revealedColors.blue) : null;
  const redLeft   = redTotal  !== null ? Math.max(0, redTotal  - revealedColors.red)  : null;
  const redCardWin  = redTotal  !== null && redLeft  === 0;
  const blueCardWin = blueTotal !== null && blueLeft === 0;

  // ── Track the DECISIVE move ──
  // Exactly ONE new card flipping = a real click (the move that ends a turn or
  // the game). The end-of-game board flip reveals MANY cards at once, so it can
  // never be mistaken for a single click. This is the key to telling a genuine
  // assassin click from the assassin merely becoming visible on the flip.
  const prevCards = prevState.cards || {};
  const newlyRevealed = Object.entries(state.cards)
    .filter(([w, d]) => d.revealed && (!prevCards[w] || !prevCards[w].revealed))
    .map(([w, d]) => ({ word: w, color: d.color }));
// Ignore the very first poll after (re)joining: prevState.cards may be a
   // stale on-disk snapshot, so a "single new reveal" here is an artifact of
   // the diff, not a real click. Never let poll #1 set the decisive move.
   if (newlyRevealed.length === 1 && pollsSinceJoin > 1) {
     lastSingleReveal = { word: newlyRevealed[0].word, color: newlyRevealed[0].color, ts: Date.now() };
   }
  const decisiveRecent = lastSingleReveal &&
    (Date.now() - lastSingleReveal.ts) <= CONFIG.pollInterval * 2.5;
  const assassinClicked = decisiveRecent && lastSingleReveal.color === 'assassin';
  const sweepByDecisive = decisiveRecent &&
    ((lastSingleReveal.color === 'red'  && redCardWin) ||
     (lastSingleReveal.color === 'blue' && blueCardWin));

  // ── Banner (instruction text) — authoritative winner when present ──
  // "RED TEAM WINS!" / "BLUE TEAM WINS!" is always correct regardless of HOW the
  // game ended. Requires a real colored reveal present (stale-banner guard).
  const instr = (state.instruction || '').toUpperCase();
  let bannerWinner = null;
  if (instr.includes('BLUE TEAM WINS') || instr.includes('BLUE WINS')) bannerWinner = 'blue';
  else if (instr.includes('RED TEAM WINS') || instr.includes('RED WINS')) bannerWinner = 'red';
  else if (instr.includes('OPPOSING TEAM WINS')) bannerWinner = (state.activeTurn === 'blue') ? 'red' : 'blue';
  if (bannerWinner && !anyColoredReveal) bannerWinner = null;

  const assassinVisible = revealedColors.assassin > 0;
  const gameLooksOver = !!bannerWinner || assassinClicked || redCardWin || blueCardWin || assassinVisible;

  // ── Don't count a game we joined too late to witness ──
  // If we connect to a board that's already finished, the first poll would
  // otherwise fire a phantom win. Latch it as ended silently and move on.
  if (gameLooksOver && sessionIsFresh && pollsSinceJoin <= 1) {
    sessionIsFresh = false;
    pendingGameEndCheck = null;
    prevState = { ...prevState, gameEnded: true, cards: state.cards, instruction: state.instruction };
    log('↩️  Joined onto an already-finished game — not counting it.');
    await writeOverlayState(state);
    return;
  }
  sessionIsFresh = false;

  // ── Decide the winner ──
  // Priority: (1) banner, (2) genuine assassin click, (3) decisive sweep,
  // (4) ambiguous full-flip → wait one poll for the banner before deciding.
  let winner = null, reason = '', creditAssassin = false, assassinWord = null;

  if (bannerWinner) {
    winner = bannerWinner;
    reason = `win banner: "${(state.instruction || '').substring(0, 40)}"`;
    // Credit an assassin hit ONLY if a real single-card click was just seen —
    // never just because the flipped board now shows the assassin.
    if (assassinClicked) { creditAssassin = true; assassinWord = lastSingleReveal.word; }
    pendingGameEndCheck = null;
  }
  else if (assassinClicked) {
    // A real assassin click: the clicking team loses, the other team wins.
    const loser = state.activeTurn || lastBroadcastTurn;
    if (loser) {
      winner = loser === 'blue' ? 'red' : 'blue';
      reason = 'assassin';
      creditAssassin = true; assassinWord = lastSingleReveal.word;
    }
    pendingGameEndCheck = null;
  }
  else if (sweepByDecisive) {
    // The decisive click completed a team's colour set — that team won.
    // (Also correctly handles guessing the OTHER team's last card.)
    winner = lastSingleReveal.color;
    reason = `all ${winner} cards revealed`;
    pendingGameEndCheck = null;
  }
  else if (redCardWin || blueCardWin || assassinVisible) {
    // Game looks over but the decisive move is unclear — e.g. the whole board
    // flipped between two polls. Wait one extra poll for the banner to name the
    // winner instead of guessing from activeTurn.
    if (!pendingGameEndCheck) {
      pendingGameEndCheck = { timestamp: Date.now() };
      log('⏳ Game end detected — waiting for the win banner to confirm the winner…');
    } else if (Date.now() - pendingGameEndCheck.timestamp >= CONFIG.pollInterval * 1.5) {
      if (redCardWin && !blueCardWin)      { winner = 'red';  reason = 'all red cards revealed (timeout)'; }
      else if (blueCardWin && !redCardWin) { winner = 'blue'; reason = 'all blue cards revealed (timeout)'; }
      else { log('⚠️  Winner ambiguous (full board flip, no banner) — NOT crediting to avoid a wrong result.'); }
      pendingGameEndCheck = null;
    }
  }
  else {
    pendingGameEndCheck = null;  // nothing end-like this poll
  }

  if (winner) {
    if (creditAssassin) {
      const loser = winner === 'blue' ? 'red' : 'blue';
      log(`💀 ASSASSIN HIT: ${assassinWord || '(assassin)'} — ${loser.toUpperCase()} loses!`);
      await onAssassin(assassinWord || '(assassin)', loser, state.players);
    }
log(`🏆 Game over — ${winner.toUpperCase()} wins! (${reason})`);
       await onGameEnd(winner, state.players, state.cards, {
         byAssassin:   creditAssassin,
         assassinWord: creditAssassin ? (assassinWord || null) : null,
         loser:        winner === 'blue' ? 'red' : 'blue',
         reason:       reason,
       });
    prevState = { ...prevState, gameEnded: true, cards: state.cards, instruction: state.instruction };
    consecutiveAllNeutralPolls = 0;
    pendingGameEndCheck = null;
    lastSingleReveal = null;
    saveStateToDisk();
    await writeOverlayState(state);
    return;
  }

// ── Per-card reveal log (game still active) ──
   // Skip while a game-end is being confirmed so the board flip doesn't spam
   // a dozen "card revealed" lines at once.
   if (!gameLooksOver) Object.entries(state.cards).forEach(([word, data]) => {
    const prev = prevState.cards[word];
    if (data.revealed && (!prev || !prev.revealed)) {
      log(`🃏 Card revealed: ${word} (${data.color})`);
      onCardRevealed(word, data.color, state.activeTurn);
    }
  });

  // Save state
  prevState = {
    activeTurn:  state.activeTurn,
    players:     state.players,
    cards:       state.cards,
    clue:        state.clue,
    gameActive:  state.gameActive,
    instruction: state.instruction,
    gameEnded:   prevState.gameEnded || false,
  };

  // Always write full state to overlay
  await writeOverlayState(state);
}

// ─────────────────────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────────────────────
async function onTurnChange(newTurn, oldTurn, clue) {
  // Tell the v5 overlay to start the correct team's turn timer
  const js = `
    (function() {
      try {
        stopTurnTimer();
        startTurnTimer('${newTurn}');
      } catch(e) {
        // fallback: fire the turn start button
        var btn = document.querySelector('[onclick*="${newTurn}Turn"], [id*="${newTurn}-turn"]');
        if(btn) btn.click();
      }
    })();
  `;
  await obsExec(js);
  broadcast({ type: 'turn', team: newTurn });
}

async function onPlayersUpdate(players) {
  // Build combined player list for overlay
  const teamData = {
    blue: {
      operatives: players.blueOp,
      spymasters: players.blueSpy,
    },
    red: {
      operatives: players.redOp,
      spymasters: players.redSpy,
    }
  };

  // Write to cn_state players array
  const js = `
    (function() {
      try {
        var allPlayers = ${JSON.stringify([
          ...players.blueOp.map(n => ({ name: n, team: 'blue', role: 'operative' })),
          ...players.blueSpy.map(n => ({ name: n, team: 'blue', role: 'spymaster' })),
          ...players.redOp.map(n => ({ name: n, team: 'red', role: 'operative' })),
          ...players.redSpy.map(n => ({ name: n, team: 'red', role: 'spymaster' })),
        ])};
        // Add to roster if not exists
        var roster = JSON.parse(localStorage.getItem('cn_roster') || '[]');
        allPlayers.forEach(function(p) {
          if (!roster.find(function(r) { return r.name === p.name; })) {
            roster.push({ name: p.name, addedAt: Date.now() });
          }
        });
        localStorage.setItem('cn_roster', JSON.stringify(roster));
        localStorage.setItem('cn_bot_teams', JSON.stringify(allPlayers));
      } catch(e) {}
    })();
  `;
  await obsExec(js);
  broadcast({ type: 'players', players });
}

async function onClue(clue, team) {
  broadcast({ type: 'clue', clue, team });
}

async function onCardRevealed(word, color, byTeam) {
  // Write to cn_timing as a card event
  const js = `
    (function() {
      try {
        var timing = JSON.parse(localStorage.getItem('cn_timing') || '{"turns":[],"games":[],"sessionStart":null}');
        if (!timing.cardEvents) timing.cardEvents = [];
        timing.cardEvents.push({ word: '${word}', color: '${color}', byTeam: '${byTeam}', ts: Date.now() });
        localStorage.setItem('cn_timing', JSON.stringify(timing));
      } catch(e) {}
    })();
  `;
  await obsExec(js);
  broadcast({ type: 'card', word, color, byTeam });
}

async function onAssassin(word, losingTeam, players) {
  // Stat crediting (assassinHits + win/loss) happens in the v7 overlay via botApplyAssassin().
  // Bot just broadcasts the event.
  broadcast({ type: 'assassin', word, losingTeam });
}

// ============================================================================
// EDIT S2 — replace your existing onGameEnd() function with this one.
// (Only change: it now accepts and forwards an `endInfo` object.)
// ============================================================================
// ─────────────────────────────────────────────────────────
// #STATS CHANNEL — per-game recaps + end-of-session summary
// ─────────────────────────────────────────────────────────

// Roles played this game, grouped by team. Derived from roleHistory, so a
// player who switched OP↔SM is listed under every role they actually held.
function playersByTeamRole() {
  const out = { blue:{operatives:[],spymasters:[]}, red:{operatives:[],spymasters:[]} };
  Object.keys(roleHistory).forEach(name => {
    [...roleHistory[name]].forEach(combo => {
      const [team, role] = combo.split(':');
      if (!out[team]) return;
      const bucket = role === 'SM' ? 'spymasters' : 'operatives';
      if (!out[team][bucket].includes(name)) out[team][bucket].push(name);
    });
  });
  return out;
}

// Capture a finished game into sessionGames. Returns the entry so the story
// generator can attach its text and then fire the per-game #stats post.
function recordSessionGame(winner, endInfo, cards) {
  endInfo = endInfo || {};
  const byTeam = playersByTeamRole();
  const durationSec = gameStartTs ? Math.max(0, Math.round((Date.now() - gameStartTs) / 1000)) : null;
  const revealed = { red: 0, blue: 0, assassin: 0 };
  Object.values(cards || {}).forEach(c => {
    if (c.revealed && revealed[c.color] !== undefined) revealed[c.color]++;
  });
  const entry = {
    gameNum:    sessionGames.length + 1,
    winner,
    reason:     endInfo.reason || '',
    firstTeam,
    assassin:   endInfo.byAssassin
      ? { word: endInfo.assassinWord || '(assassin)', losingTeam: endInfo.loser || (winner === 'blue' ? 'red' : 'blue') }
      : null,
    revealed,
    players:    byTeam,
    durationSec,
    story:      null,
    ts:         Date.now(),
  };
  sessionGames.push(entry);
  const np = byTeam.blue.operatives.length + byTeam.blue.spymasters.length +
             byTeam.red.operatives.length  + byTeam.red.spymasters.length;
  log(`📊 Session game ${entry.gameNum} recorded (${winner.toUpperCase()} win, ${np} players` +
      (durationSec != null ? `, ${durationSec}s)` : ')'));
  saveStateToDisk();
  return entry;
}

function fmtDur(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}:${String(m%60).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }
  return `${m}:${String(s).padStart(2,'0')}`;
}
function rosterLine(side) {
  const sm = (side.spymasters || []).join(', ') || '—';
  const op = (side.operatives || []).join(', ') || '—';
  return `SM: ${sm}\nOP: ${op}`;
}

// Per-game post — fires from generateGameStory's completion path as each game
// ends. Carries the AI story when there is one; otherwise just the recap.
async function postGameStatsPost(entry) {
  const cfg = CONFIG.discord && CONFIG.discord.stats;
  if (!cfg || !cfg.enabled || !cfg.webhookUrl) return;
  if (cfg.postEachGame === false) return;
  if (!entry) return;

  const winLabel = entry.winner === 'blue' ? '🟦 Blue' : '🟥 Red';
  const via   = entry.assassin ? ` — assassin: "${entry.assassin.word}"` : '';
  const color = entry.winner === 'blue' ? 0x2a7de8 : 0xe8392a;

  const meta = [];
  if (entry.durationSec != null) meta.push(`⏱ ${fmtDur(entry.durationSec)}`);
  meta.push(`🔵 ${entry.revealed.blue}  🔴 ${entry.revealed.red}`);
  if (entry.assassin) meta.push(`☠ ${entry.assassin.losingTeam.toUpperCase()} hit it`);

  const embed = {
    title: `Game ${entry.gameNum} — ${winLabel} win${via}`.slice(0, 256),
    color,
    fields: [
      { name: '🟦 Blue', value: rosterLine(entry.players.blue), inline: true },
      { name: '🟥 Red',  value: rosterLine(entry.players.red),  inline: true },
      { name: 'Result',  value: meta.join('   •   '),           inline: false },
    ],
    footer: { text: `${CONFIG.discord.hostName || 'Streamer'} • ${CONFIG.discord.serverName || ''}` },
    timestamp: new Date(entry.ts || Date.now()).toISOString(),
  };
  if (entry.story) embed.description = String(entry.story).slice(0, 4000);

  await postWebhook(cfg.webhookUrl, { embeds: [embed] }, 'Discord (#stats game)');
}

// Build the end-of-session summary as one or more webhook message bodies.
// Discord caps: 25 fields/embed, 10 embeds/message — so we batch defensively.
function buildSessionStatsMessages() {
  const games = sessionGames;
  const totals = { blue: 0, red: 0, assassin: 0 };
  games.forEach(g => {
    if (g.winner === 'blue') totals.blue++;
    else if (g.winner === 'red') totals.red++;
    if (g.assassin) totals.assassin++;
  });
  const sessionSec = sessionStartTs ? Math.round((Date.now() - sessionStartTs) / 1000) : null;

  const summary = {
    title: '📊 Codenames — Session Stats',
    color: 0xf0c040,
    fields: [
      { name: 'Games',          value: String(games.length), inline: true },
      { name: '🟦 Blue Wins',   value: String(totals.blue),  inline: true },
      { name: '🟥 Red Wins',    value: String(totals.red),   inline: true },
      { name: '☠ Assassin Hits',value: String(totals.assassin), inline: true },
      { name: 'Session Length', value: fmtDur(sessionSec) || '—', inline: true },
    ],
    footer: { text: `${CONFIG.discord.hostName || 'Streamer'} • ${CONFIG.discord.serverName || ''}` },
    timestamp: new Date().toISOString(),
  };

  const gameFields = games.map(g => {
    const wl  = g.winner === 'blue' ? '🟦 Blue' : '🟥 Red';
    const via = g.assassin ? ` (assassin "${g.assassin.word}")` : '';
    const dur = g.durationSec != null ? ` • ⏱ ${fmtDur(g.durationSec)}` : '';
    const blue = `🟦 ${[...(g.players.blue.spymasters||[]), ...(g.players.blue.operatives||[])].join(', ') || '—'}`;
    const red  = `🟥 ${[...(g.players.red.spymasters||[]),  ...(g.players.red.operatives||[])].join(', ')  || '—'}`;
    let value = `${blue}\n${red}`;
    if (value.length > 1000) value = value.slice(0, 1000) + '…';
    return { name: `Game ${g.gameNum} — ${wl} win${via}${dur}`.slice(0, 256), value, inline: false };
  });

  const embeds = [summary];
  for (let i = 0; i < gameFields.length; i += 25) {
    embeds.push({ color: 0x2b2d31, fields: gameFields.slice(i, i + 25) });
  }
  const messages = [];
  for (let i = 0; i < embeds.length; i += 10) messages.push({ embeds: embeds.slice(i, i + 10) });
  return messages;
}

async function postSessionStats(trigger) {
  const cfg = CONFIG.discord && CONFIG.discord.stats;
  if (!cfg || !cfg.enabled || !cfg.webhookUrl) { log('📊 Session stats skipped (disabled or no #stats webhook URL)'); return; }
  if (cfg.postOnSessionEnd === false) return;
  if (sessionStatsPosted) { log('📊 Session stats already posted this session — skipping'); return; }
  if (!sessionGames.length) { log('📊 No games recorded this session — nothing to post'); return; }

  sessionStatsPosted = true;
  const messages = buildSessionStatsMessages();
  log(`📊 Posting session stats → #stats (${sessionGames.length} games, ${messages.length} message(s), trigger=${trigger})`);
  for (const body of messages) {
    await postWebhook(cfg.webhookUrl, body, 'Discord (#stats session)');
  }
}

async function onGameEnd(winner, players, cards, endInfo) {
  // Stat crediting (per-player W/L) happens in the overlay's botCreditGame(),
  // triggered by this broadcast. The bot just broadcasts and records a recap.
  endInfo = endInfo || {};
  log(`🏆 Broadcasting game end → ${winner.toUpperCase()} wins`);
  broadcast({ type: 'gameEnd', winner });

  // Record a factual recap of this game for the #stats posts.
  let gameEntry = null;
  try { gameEntry = recordSessionGame(winner, endInfo, cards || prevState.cards); }
  catch (e) { log(`⚠️  Session-game record error: ${e.message}`); }

  // Generate the comedic AI recap. The per-game #stats post fires from inside
  // generateGameStory's finally block — so it always goes out (with the story
  // when there is one, or just the recap if the story was skipped/failed).
  generateGameStory(winner, players, cards || prevState.cards, endInfo, gameEntry)
    .catch(e => log(`⚠️  Story generation error: ${e.message}`));
}

// ============================================================================
// EDIT S3 — replace your entire existing generateGameStory() function with
// this one. It branches: assassin wins get a "doomed blunder" story; normal
// wins keep the original "brilliant sweep" story.
// ============================================================================
async function generateGameStory(winner, players, cards, endInfo, gameEntry) {
  const cfg = CONFIG.story || {};
  let storyText = null;
  try {
  if (!cfg.enabled) { log('📖 Story disabled — #stats will post the recap only'); return; }
  if (!cfg.apiKey) {
    log('📖 Story skipped (no API key set in CONFIG.story.apiKey)');
    return;
  }
 
  endInfo = endInfo || {};
  const byAssassin   = !!endInfo.byAssassin;
  const loser        = endInfo.loser || (winner === 'blue' ? 'red' : 'blue');
  const assassinWord = endInfo.assassinWord || 'the assassin';
 
  // Words uncovered this game (excluding the assassin itself). On a normal win
  // these are mostly the winner's cards; on an assassin win they're whatever
  // the losing team uncovered on their doomed run.
  const revealedWords = Object.entries(cards || {})
    .filter(([w, d]) => d.revealed && d.color !== 'assassin')
    .map(([w]) => w);
  const winningWords = Object.entries(cards || {})
    .filter(([w, d]) => d.color === winner && d.revealed)
    .map(([w]) => w);
 
  // Players by team, from the role history accumulated during the game.
  function teamPlayers(teamColor) {
    const out = [];
    Object.keys(roleHistory).forEach(name => {
      const combos = [...roleHistory[name]];
      if (combos.some(c => c.startsWith(teamColor + ':'))) {
        const isSpy = combos.some(c => c === teamColor + ':SM');
        out.push({ name, role: isSpy ? 'spymaster' : 'agent' });
      }
    });
    return out;
  }
  const winningPlayers = teamPlayers(winner);
  const losingPlayers  = teamPlayers(loser);
  const winSpymasters = winningPlayers.filter(p => p.role === 'spymaster').map(p => p.name);
  const winAgents     = winningPlayers.filter(p => p.role === 'agent').map(p => p.name);
  const loseAgents    = losingPlayers.filter(p => p.role === 'agent').map(p => p.name);
  const winLabel  = winner === 'blue' ? 'Blue' : 'Red';
  const loseLabel = loser  === 'blue' ? 'Blue' : 'Red';
 
  // A normal sweep win needs a couple of the winner's words to build a story.
  // An assassin win doesn't — the assassin word carries it.
  if (!byAssassin && winningWords.length < 2) {
    log('📖 Story skipped (not enough winning cards captured)');
    return;
  }
 
  storyGameCounter++;
  const gameNum = storyGameCounter;
 
  let promptText;
  if (byAssassin) {
    promptText =
      `You are a comedy writer recapping a game of Codenames for a Twitch stream. ` +
      `The ${loseLabel} team LOST by touching the assassin — the secret kill-word "${assassinWord}" — ` +
      `handing victory to the ${winLabel} team. Write a SHORT (2-3 sentences, max 60 words) absurd, ` +
      `comedic spy-thriller recap of the ${loseLabel} team's catastrophic blunder. ` +
      (revealedWords.length ? `Words uncovered before the disaster: ${revealedWords.join(', ')}. ` : '') +
      (loseAgents.length ? `The doomed agent(s) who hit it: ${loseAgents.join(', ')}. ` : '') +
      ((winSpymasters.length || winAgents.length)
        ? `The lucky ${winLabel} winners: ${[...winSpymasters, ...winAgents].join(', ')}. ` : '') +
      `Make it punchy and funny, like an over-the-top movie trailer narrator. ` +
      `Lean into "${assassinWord}" as the instrument of doom. ` +
      `Use the player names as characters. Do not use hashtags or emoji. ` +
      `Return ONLY the story text, no preamble.`;
    log(`📖 Generating game ${gameNum} recap (assassin win — killed by "${assassinWord}")...`);
  } else {
    promptText =
      `You are a comedy writer recapping a game of Codenames for a Twitch stream. ` +
      `The ${winLabel} team just won. Write a SHORT (2-3 sentences, max 60 words) absurd, ` +
      `comedic spy-thriller recap that weaves in these code words they guessed: ` +
      `${winningWords.join(', ')}. ` +
      (winSpymasters.length ? `The mastermind spymaster(s): ${winSpymasters.join(', ')}. ` : '') +
      (winAgents.length ? `The field agents: ${winAgents.join(', ')}. ` : '') +
      `Make it punchy and funny, like an over-the-top movie trailer narrator. ` +
      `Use the player names as characters. Do not use hashtags or emoji. ` +
      `Return ONLY the story text, no preamble.`;
    log(`📖 Generating game ${gameNum} recap (${winningWords.length} words, ${winningPlayers.length} players)...`);
  }
 
  try {
    const story = await callClaudeAPI(cfg.apiKey, cfg.model, promptText);
    if (!story) {
      log('⚠️  Story came back empty');
      return;
    }
    storyText = story.trim();
 
    const entry = { gameNum, winner, story: storyText, ts: Date.now() };
    sessionStories.push(entry);
    if (sessionStories.length > cfg.maxGames) {
      sessionStories = sessionStories.slice(-cfg.maxGames);
    }
 
log(`📖 Game ${gameNum} recap: "${storyText.substring(0, 80)}..."`);

       // Persist to localStorage so the end-credits roll can read it on load.
       // The credits file reads the 'cn_stories' key (NOT the WebSocket).
       await writeToOverlay('cn_stories', sessionStories);

       // Broadcast to overlay (live listeners) — shape unchanged.
       broadcast({
         type: 'gameStory',
         gameNum,
         winner,
         story: storyText,
         allStories: sessionStories,
       });
  } catch (e) {
    log(`⚠️  Story generation failed: ${e.message}`);
  }
  } catch (outerErr) {
    log(`⚠️  Story routine error: ${outerErr.message}`);
  } finally {
    // Always fire the per-game #stats post — with the story if we got one,
    // otherwise just the factual recap. Runs once per finished game.
    if (gameEntry) {
      if (storyText) gameEntry.story = storyText;
      try { saveStateToDisk(); } catch (_) {}
      postGameStatsPost(gameEntry).catch(e => log(`⚠️  #stats per-game post error: ${e.message}`));
    }
  }
}

// Call Claude API (Anthropic Messages endpoint) — returns the text response
function callClaudeAPI(apiKey, model, promptText) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const payload = JSON.stringify({
      model: model,
      max_tokens: 200,
      messages: [{ role: 'user', content: promptText }],
    });

    const req = https.request({
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`API HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          const text = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function writeOverlayState(state) {
  // Count revealed cards by color
  const revealed = { blue: 0, red: 0, assassin: 0 };
  Object.values(state.cards || {}).forEach(c => {
    if (c.revealed && revealed[c.color] !== undefined) revealed[c.color]++;
  });

  // Count "unrevealed" cards (anything the bot sees as neutral-cardBg).
  // For a spectator this is: actual unrevealed cards + revealed neutral cards,
  // since both render as var(--neutral-cardBg) in the DOM.
  const unrevealedSlots = Object.values(state.cards || {})
    .filter(c => !c.revealed).length;

  // Use the actual firstTeam (tracked from first turn change of the game).
  // First team has 9, second has 8.
  const blueTotal = firstTeam === 'blue' ? 9 : firstTeam === 'red'  ? 8 : 9;
  const redTotal  = firstTeam === 'red'  ? 9 : firstTeam === 'blue' ? 8 : 8;

  // Remaining colored cards face-down
  const blueLeft     = Math.max(0, blueTotal - revealed.blue);
  const redLeft      = Math.max(0, redTotal  - revealed.red);
  const assassinLeft = revealed.assassin > 0 ? 0 : 1;

  // Neutrals remaining = unrevealed slots minus the face-down colored/assassin cards.
  // This works because the bot can count total unrevealed cards in the DOM,
  // and we know exactly how many of those are actually team/assassin cards.
  const neutralLeft = Math.max(0, unrevealedSlots - blueLeft - redLeft - assassinLeft);

  const overlayPayload = {
    type:        'state',
    activeTurn:  state.activeTurn,
    clue:        state.clue,
    instruction: state.instruction,
    players:     state.players,
    cards:       state.cards,
    cardCount:   state.cardCount,
    revealed,
    firstTeam,
    remaining: {
      blue:     blueLeft,
      red:      redLeft,
      neutral:  neutralLeft,
      assassin: assassinLeft,
    },
    ts: Date.now(),
  };

  // Broadcast to all subscribers (overlay WS + control panel SSE)
  broadcast(overlayPayload);
}

// ─────────────────────────────────────────────────────────
// CONTROL PANEL — local web server for the UI
// ─────────────────────────────────────────────────────────
const clients = new Set(); // SSE clients for live log (control panel)
const overlayClients = new Set(); // WebSocket clients for overlay sync

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch(e) {} });
  // Also push to overlay WebSocket clients
  const wsMsg = JSON.stringify(data);
  overlayClients.forEach(ws => {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(wsMsg); } catch(e) {}
  });
}

// Resolved log path (next to bot.js) + one-time rotation check on first write.
const LOG_FILE = path.join(__dirname, CONFIG.logFile || 'bot.log');

function rotateLogIfNeeded() {
  try {
    const max = CONFIG.logMaxBytes || (5 * 1024 * 1024);
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > max) {
      // keep exactly one previous file: bot.log → bot.log.1 (overwrites old .1)
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch (e) { /* rotation problems must never kill the bot */ }
}

function log(msg) {
  const now  = new Date();
  const line = `[${now.toLocaleTimeString()}] ${msg}`;
  console.log(line);
  broadcast({ type: 'log', msg: line });
  // Persist to disk with a full ISO timestamp so multi-day logs stay unambiguous.
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, `[${now.toISOString()}] ${msg}\n`);
  } catch (e) { /* disk write issues shouldn't kill the bot */ }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.controlPort}`);

  // SSE stream for live updates
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: {"type":"connected"}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // API — start bot
  if (url.pathname === '/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      // Parse + validate first; respond immediately so the UI doesn't hang
      let ru = null;
      try {
        const parsed = JSON.parse(body);
        ru = parsed.roomUrl;
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
        return;
      }
      if (!ru || !ru.includes('codenames.game')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid URL' }));
        return;
      }

      // Respond OK to the UI immediately. Browser launch + OBS connect happen
      // asynchronously after this — any errors there are logged but not sent
      // as HTTP response (since the response has already gone out).
      roomUrl = ru;
      manualStop = false;                                  // re-enable auto-reconnect
      reconnectAttempts = 0;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      // Now do the slow work without re-touching the response
      try {
        if (!obsConnected) await connectOBS();
      } catch(e) {
        log(`⚠️  OBS connect error: ${e.message}`);
      }
      try {
        await joinRoom(ru);
      } catch(e) {
        log(`⚠️  Join room error: ${e.message}`);
      }
    });
    return;
  }

  // API — stop bot
  if (url.pathname === '/stop') {
    manualStop = true;                                   // block any auto-reconnect
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    reconnecting = false;
    stopPolling();
    if (browser) { await browser.close().catch(()=>{}); browser = null; page = null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    log('🛑 Bot stopped');
    // End of session → post the summary to #stats (fire-and-forget; process stays up)
    postSessionStats('stop').catch(e => log(`⚠️  Session stats post error: ${e.message}`));
    return;
  }

  // API — manually post current game URL to Discord
  if (url.pathname === '/discord-post' && req.method === 'POST') {
    if (!roomUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active room URL — start the bot first' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    postToDiscord(roomUrl).catch(e => log(`⚠️  Discord post error: ${e.message}`));
    postDiscordAnnouncement().catch(e => log(`⚠️  Discord announcement error: ${e.message}`));
    return;
  }

  // API — toggle Discord-on-start
  if (url.pathname === '/discord-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        discordPostOnStart = !!parsed.enabled;
        log(`📨 Discord-on-start: ${discordPostOnStart ? 'ON' : 'OFF'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: discordPostOnStart }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API — status
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      obsConnected,
      polling,
      roomUrl,
      activeTurn:  prevState.activeTurn,
      players:     prevState.players,
      clue:        prevState.clue,
      cardCount:   prevState.cards ? Object.keys(prevState.cards).length : 0,
      discordPostOnStart,
      discordConfigured: !!(CONFIG.discord && CONFIG.discord.enabled && CONFIG.discord.webhookUrl),
      reconnecting,
      reconnectAttempts,
      autoReconnect: !!(CONFIG.reconnect && CONFIG.reconnect.enabled),
    }));
    return;
  }

  // Serve control panel HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'control.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('control.html not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(CONFIG.controlPort, () => {
  log(`🚀 Codenames Bot control panel → http://localhost:${CONFIG.controlPort}`);
  log(`   Paste your game URL and click Start`);
  connectOBS();
});

// ─────────────────────────────────────────────────────────
// WEBSOCKET SERVER — for the v5 overlay to subscribe to live state
// Overlay connects to ws://localhost:7842/overlay
// ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/overlay' });
wss.on('connection', (ws) => {
  overlayClients.add(ws);
  log(`📺 Overlay connected (${overlayClients.size} total)`);

  // Send full current state immediately so overlay can hydrate
  try {
    ws.send(JSON.stringify({
      type: 'fullState',
      activeTurn:  prevState.activeTurn,
      players:     prevState.players,
      clue:        prevState.clue,
      cards:       prevState.cards,
      cardCount:   prevState.cards ? Object.keys(prevState.cards).length : 0,
    }));
    // Also send any accumulated game stories so end-credits can show them
    if (sessionStories.length > 0) {
      ws.send(JSON.stringify({
        type: 'gameStory',
        allStories: sessionStories,
      }));
    }
  } catch(e) {}

  ws.on('close', () => {
    overlayClients.delete(ws);
    log(`📺 Overlay disconnected (${overlayClients.size} remaining)`);
  });
  ws.on('error', () => {});
});

process.on('SIGINT', async () => {
  manualStop = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPolling();
  // End of session → post the summary, but never let a hung webhook block exit.
  try {
    await Promise.race([
      postSessionStats('shutdown'),
      new Promise(res => setTimeout(res, 6000)),
    ]);
  } catch (e) { /* non-fatal */ }
  if (browser) await browser.close().catch(()=>{});
  server.close();
  process.exit(0);
});
