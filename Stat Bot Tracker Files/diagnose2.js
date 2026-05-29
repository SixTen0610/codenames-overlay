/**
 * CODENAMES DOM DIAGNOSTIC  v2  (read-only — never clicks anything)
 *
 * Fixes the v1 problems:
 *   - Targets REAL game cards (articles with `--CardColor` in their style),
 *     so it no longer captures player-avatar bubbles by mistake.
 *   - Dumps the blueDeck / redDeck / banner slots — the native remaining-card
 *     counters we'll use for first-team + win detection.
 *   - Summarizes how every card encodes its color (so we can fix the
 *     per-card color log too, if it's cheap).
 *
 * USAGE (in your bot folder, off-air):
 *   node diagnose2.js https://codenames.game/r/your-room
 *
 * ── RUN IT MID-GAME ──
 * Best capture point: a game IN PROGRESS with several cards already revealed
 * for BOTH teams (e.g. blue has flipped 2-3, red has flipped 2-3), and NOT
 * right at the win screen. That lets me see live deck counts AND revealed
 * cards of each color.
 *
 * When you run it, also jot down for me:
 *   - which team STARTED this game (had 9)
 *   - the two remaining numbers showing on the board at capture time
 */

const puppeteer = require('puppeteer');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const roomUrl = process.argv[2];

if (!roomUrl || !roomUrl.includes('codenames.game')) {
  console.error('\n  Usage: node diagnose2.js https://codenames.game/r/your-room\n');
  process.exit(1);
}

(async () => {
  console.log('\n================ CODENAMES DOM DIAGNOSTIC v2 ================');
  console.log('Room:', roomUrl);
  console.log('Launching headless Chrome (read-only spectator)...\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: CHROME_PATH,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  await page.goto(roomUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3500));

  const report = await page.evaluate(() => {
    const out = {};

    const slotEl = (s) => document.querySelector(`[data-match-slot="${s}"]`);
    const slotText = (s) => {
      const el = slotEl(s);
      return el ? el.innerText.trim() : '(slot not found)';
    };
    const slotHTML = (s) => {
      const el = slotEl(s);
      if (!el) return '(slot not found)';
      let h = el.outerHTML || '';
      return h.length > 1500 ? h.slice(0, 1500) + ' …[truncated]' : h;
    };

    // ── 1. THE MONEY: deck counters + banner/instruction ──────────
    out.decks = {
      blueDeck_text: slotText('blueDeck'),
      redDeck_text: slotText('redDeck'),
      blueDeck_html: slotHTML('blueDeck'),
      redDeck_html: slotHTML('redDeck'),
    };
    out.banners = {
      banner_text: slotText('banner'),
      instruction_text: slotText('instruction'),
      clue_text: slotText('clue'),
    };

    // ── 2. REAL game cards only (must have --CardColor in inline style) ──
    const cardArticles = [...document.querySelectorAll('article')].filter((a) =>
      (a.getAttribute('style') || '').includes('--CardColor')
    );

    const colorOf = (a) => {
      const m = (a.getAttribute('style') || '').match(
        /--CardColor:\s*var\(--([a-z]+)-cardBg\)/i
      );
      return m ? m[1].toLowerCase() : '(no --CardColor match)';
    };
    const wordOf = (a) => {
      const el = a.querySelector('[class*="backface-hidden"]');
      return el ? (el.innerText || '').trim().split('\n')[0] : '(none)';
    };
    const imgsOf = (a) =>
      [...a.querySelectorAll('img')].map((i) => {
        const src = i.src || '';
        // just the filename + parent folder, to keep it readable
        const parts = src.split('/');
        return parts.slice(-2).join('/');
      });

    // Per-card compact rows
    out.cardRows = cardArticles.map((a) => ({
      word: wordOf(a),
      cardColor: colorOf(a),
      imgs: imgsOf(a),
      // any data-* attributes that might encode state
      dataAttrs: [...a.attributes]
        .filter((at) => at.name.startsWith('data-'))
        .map((at) => `${at.name}=${at.value}`),
    }));

    // Color tally
    const tally = {};
    out.cardRows.forEach((c) => {
      tally[c.cardColor] = (tally[c.cardColor] || 0) + 1;
    });
    out.cardColorTally = tally;
    out.cardCount = cardArticles.length;

    // ── 3. Two full card samples: one WITH artwork img, one without ──
    const sample = (a) => {
      let h = a.outerHTML || '';
      if (h.length > 1600) h = h.slice(0, 1600) + ' …[truncated]';
      return { word: wordOf(a), cardColor: colorOf(a), imgs: imgsOf(a), outerHTML: h };
    };
    const withArt = cardArticles.filter((a) => a.querySelector('img'));
    const noArt = cardArticles.filter((a) => !a.querySelector('img'));
    out.sampleWithArtwork = withArt.slice(0, 2).map(sample);
    out.sampleWithoutArtwork = noArt.slice(0, 1).map(sample);

    return out;
  });

  console.log(JSON.stringify(report, null, 2));
  console.log('\n============================================================');
  console.log('Copy ALL output above and paste it back to me.');
  console.log('Also tell me: which team STARTED (had 9), and the two');
  console.log('remaining numbers shown on the board right now.');
  console.log('============================================================\n');

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('\nDiagnostic failed:', e.message);
  console.error('If it is a Chrome-path error, run:');
  console.error('  set CHROME_PATH=C:\\path\\to\\chrome.exe && node diagnose2.js <url>\n');
  process.exit(1);
});
