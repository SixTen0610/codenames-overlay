# codenames-overlay
Codenames.game overlay and stat tracker bots
codenames-combined.html (563kb) - A codenames.game Twitch/OBS overlay that pulls info from the next file for stats tracking
Start-Bot.bat (1kb) - a bot that gets placed inside the codenames.game/r/lobby to track turns/wins/losses etc. it is also dependent on the next 2 files.
bot.js (48kb) - the javascript config file
control.html (22kb) - The file that gets opened by start.bot.bat for entering game room information
codenames-endcreditsv5.0 (35kb)
All of these files work hand in hand. Claude was working on changing #1 from writing a story using game data to having the story play in line with the scrolling text in codenames-endcredits.html 

Here is a summary of what was being worked on before i got cutoff by limiting:
The working overlay.html from our last session isn't on disk anymore. The Linux container resets between conversations, so the file I was editing back then is gone, and there's nothing in /mnt/user-data/uploads in this session either. I can see from past-conversation context what we'd planned (Clear Roster button + event-based suppression to replace the 5-minute timer, ship as v11), but I can't edit a file I don't have.
To make v11, I need you to upload either:

the codenames-combined_v10.html I shipped you last time (cleanest baseline — I'd patch the suppression logic and rename to v11), or
the current overlay.html you have locally if you've been editing it since (so we're working from your real state, not a stale copy)

Once it's attached, here's the plan I'll execute — no guesswork, just the patch we already scoped:

Verify what's actually in the file — read the clearAllRoster / auto-add paths so we're not arguing with a phantom version again
Replace the timer-based suppression (__suppressAutoRosterUntil = Date.now() + 5*60*1000) with event-based — a flag that clears only when the bot signals a fresh session start, so it can't expire mid-prep or get repopulated 5 minutes in
Bump the version string in the HTML header and ship as codenames-combined_v11.html
Syntax-check the inline JS before handing it back, same as v10
 I can't attach the file because i g over my pro limits

Show less
6:47 PM

Architected GitHub-based workflow to bypass token limits entirely
Architected GitHub-based workflow to bypass token limits entirely
You're hitting this exactly where it hurts, and there's a clean fix. The core problem is simple: anything you upload into chat counts against your usage, and a 563 KB file is roughly ~150k tokens every single time it crosses the wire. So the goal isn't to shrink the file (though we can) — it's to stop sending the whole file through chat at all.

Here are the two tracks: a permanent workflow fix, and a way to ship v11 today with zero file upload.

Track A — The permanent fix: let me pull the file instead of you pushing it
My code container has direct network access to GitHub's raw file servers. That means I can curl your file straight into my workspace over the network — it never passes through your chat, so it never touches your Pro limits. I only read the small slices I need to edit; the full 563 KB never enters the conversation.

One-time setup (~5 min):

Create a GitHub account if you don't have one (free).
Create a public repo — call it something like codenames-overlay.
It needs to be public; I can't authenticate to private repos. Nothing in a Twitch overlay is sensitive, so this is fine.
Upload your files to it (drag-and-drop in the GitHub web UI works — no git knowledge needed):
codenames-combined.html
bot.js
control.html
Start-Bot.bat
codenames-endcredits.html
Every session after that:

If you edited anything locally since last time, re-upload the changed file to the repo first (drag-drop, "commit changes").
Paste me the raw URL of the file you want worked on. It looks like:
   https://raw.githubusercontent.com/YOURNAME/codenames-overlay/main/codenames-combined.html
(On GitHub: open the file → click Raw → copy that address.) 3. I pull it, patch it, syntax-check it, and hand you back the finished file to download.

Why this works: the heavy file moves machine-to-machine over the network, not through your message quota. Your only chat cost is the URL plus the small patched snippets — a few KB instead of 563.

Track B — Ship v11 right now, no GitHub, no upload
The v11 change is tiny and surgical. From our last session it touches only three things: the timer-based suppression line, the auto-add path, and the version string. You don't need to send me the whole file — just paste these snippets and I'll hand back drop-in replacements you paste over them locally.

Do this:

Open codenames-combined.html in a text editor (Notepad++, VS Code, anything).
Ctrl+F for: __suppressAutoRosterUntil — copy the ~15 lines around each hit (there are a couple).
Ctrl+F for: Auto-add to roster — copy that block.
Ctrl+F for the version string in the header (search v10) — copy that line.
Paste all of that here.
I'll return the event-based versions plus exact find/replace targets, you swap them in, save as v11, done. That's maybe 2 KB total across the wire.

Worth doing eventually — why is it 563 KB?
That's huge for an overlay. It's almost certainly embedded base64 images, fonts, or an inlined library baked into the HTML. If we externalize those into sibling files referenced by relative path (OBS browser sources load local neighbor files fine), the HTML itself likely drops to 50–100 KB — which makes even direct uploads painless again. I can investigate and split it once it's in the container via Track A.
