# CensorCraft

Study real course material inside Minecraft Bedrock. Place a **whiteboard**, a jobless villager becomes **Professor Censor**, right-click him and answer AI-generated questions about your own course files for in-game rewards.

Two parts:

| Part | Folder | What it does |
|---|---|---|
| Add-on (behavior + resource pack, TypeScript Script API) | `addon/` | whiteboard block, Censor, forms, rewards, game state |
| Companion app (Node.js + TypeScript) | `companion/` | reads your course folder, calls the AI, WebSocket server for `/connect` |
| Shared protocol + glyph allowlist | `shared/` | used by both |

## Design decisions and limits

- **Censor is approach A: a custom entity** (`censor:professor`). Bedrock has no stable way to add a villager profession or job-site block. Overriding the vanilla villager (approach B) would mean replacing `villager_v2.json`, which breaks on game updates and conflicts with other packs, and would still try to sleep and seek beds. Instead, "claiming" swaps the nearest jobless villager (`minecraft:variant` 0, adult) for a Censor, and removing the whiteboard swaps him back for a plain jobless villager. Trade-off: the villager's entity id changes, and Censor uses his own generated skin rather than the biome skin. A custom name on the villager is kept and restored.
- **Only stable APIs**: `@minecraft/server` 2.11.0 and `@minecraft/server-ui` 2.3.0 (Minecraft 1.26.60+). **No beta APIs and no experimental toggles are needed.**
- **Uplink carrier**: the add-on talks to the companion by running `tell @s CZ1|...` as the player who typed `/connect`. Known trade-off: **that one player sees "You whisper to yourself" lines** (one per request). If whispers are not acknowledged the add-on automatically retries with `/say` (visible to everyone) and remembers which one works. This could not be verified in a real game.
- **Staying near the board** uses movement behaviors (`move_to_block` toward the whiteboard, short `random_stroll`), supervised by script; a teleport is the last resort after 25 s. `minecraft:home` is not used because its anchor is the spawn position, which is where the villager stood, not the board.
- **The whiteboard is 3 blocks wide and 2 high.** One custom block cannot exceed 30 pixels, so it is six `censor:whiteboard` blocks that differ in a `censor:part` state. You place the bottom-centre block and the script builds the other five; placement is refused when the 3 x 2 space is not free. Breaking any part removes the whole board and drops one item. It cannot be pushed by pistons.
- **Whiteboard removal** is detected by the block custom component `onBreak`, `playerBreakBlock`, `blockExplode` and explosion events, plus a validation of every stored board (all six parts) every 2 s (covers `/setblock`, unloaded chunks, reloads).
- Text fields in Bedrock forms are single-line, so code answers are one line.
- A test's five questions are generated one at a time (a wait between questions).
- Claude requests on `claude-opus-5-5` / `claude-opus-5` / `claude-fable-5-1` / `claude-sonnet-5-5` opt into the server-side refusal fallback (`fallbacks: "default"`, beta) unless `ai.baseUrl` is set.
- Not verified (no game available here): everything in-game. Run [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md).

## Setup (first time)

Requirements: Windows, Minecraft Bedrock 1.26.60+, Node.js 22+, pnpm 12.

1. Install and build:
   ```bash
   pnpm install
   ```
   ```bash
   pnpm build
   ```
2. Double-click `addon/dist/CensorCraft.mcaddon` to import both packs.
3. Create or edit a world: enable **Cheats**, and activate the *CensorCraft* behavior pack (the resource pack follows).
4. In Minecraft **Settings > General**, turn **off** "Require Encrypted WebSockets".
5. Allow the Bedrock app to reach localhost (admin PowerShell, once):
   ```powershell
   CheckNetIsolation LoopbackExempt -a -n="Microsoft.MinecraftUWP_8wekyb3d8bbwe"
   ```
6. Start the companion once; it creates `companion/config.json` and exits:
   ```bash
   pnpm start
   ```
7. Fill in `companion/config.json` (see below), then run `pnpm start` again and leave it running.
8. In the world, as an operator, type `/connect ws://localhost:8765`.
9. Craft a whiteboard (6 paper on top, stick / apple / stick below) or take it from the creative inventory, place it where a space 3 wide and 2 high is free (it grows sideways and upward from the block you place), near a jobless villager, and right-click Prof. Censor.

## Config reference (`companion/config.json`)

There is no settings UI. The file is validated at startup; errors name the field and allowed values.

| Key | Meaning |
|---|---|
| `ai.provider` | `"claude"`, `"gemini"`, `"openai"` (or `"mock"` for offline testing) |
| `ai.model` | model id, e.g. `claude-opus-5-5` |
| `ai.apiKey` | the key, in plaintext |
| `ai.apiKeyEnv` | name of an environment variable holding the key; overrides `ai.apiKey` when set. `CENSOR_AI_API_KEY` overrides both |
| `ai.baseUrl` | optional proxy / compatible endpoint |
| `ai.timeoutMs`, `ai.maxRetries`, `ai.maxOutputTokens` | defaults 60000, 2, 8000 |
| `ai.effort` | optional, Claude only: `low` .. `max` |
| `courseFolder` | folder with `.txt .md .pdf .docx .pptx .c .h` files; `""` uses the model's own knowledge |
| `topicFolders` | optional map of topic name to subfolder; otherwise subfolders are matched by name, then by keywords |
| `websocket.host`, `websocket.port` | default `localhost` (IPv4 + IPv6 loopback), `8765` |
| `limits.*` | requests per minute (global and per player), per day, concurrency, `dailyTokenBudget` (0 = off), `maxMaterialChars` |
| `session.idleTimeoutMinutes`, `logLevel` | |

**The API key sits in plaintext in that file.** It is in `.gitignore`; keep the file out of backups and screenshots, restrict it to your Windows user, or leave `ai.apiKey` empty and use `ai.apiKeyEnv`. The key is never logged (the logger redacts it) and never sent to Minecraft.

Other data files: [addon/config/rewards.json](addon/config/rewards.json) (rewards, cooldown, daily cap; rebuild after editing), [companion/prompts.json](companion/prompts.json), [shared/glyphs.json](shared/glyphs.json), and all player-facing text in [addon/src/strings.ts](addon/src/strings.ts).

## Math notation and the glyph test

Forms show plain text only, so prompts demand linear Unicode math and a deterministic sanitizer converts leftover LaTeX, replaces anything outside the allowlist, and asks the model to regenerate once if that was not enough. Player answers typed in ASCII (`sqrt(2)`, `x^2`, `pi`, `<=`) are normalized before grading.

The default allowlist is conservative but **was not verified in the game**. Debug tool: `/scriptevent censor:glyphtest` prints every allowlisted character in chat. Delete the ones that show as boxes from `shared/glyphs.json`, restart the companion, and run `pnpm build` to refresh the add-on copy.

Placeholder textures and the six whiteboard part models are written by [addon/tools/gen-textures.mjs](addon/tools/gen-textures.mjs). To use your own, replace the PNGs under `addon/packs/RP/textures/` and build with `CENSOR_KEEP_TEXTURES=1`.

## Testing without Minecraft

```bash
pnpm test
```
Runs 118 tests with a mock AI provider: config validation, chunking, protocol (Unicode round trips, retries), reward selection, grader JSON parsing, the LaTeX sanitizer, the add-on link layer, and a full end-to-end cycle through a fake Minecraft client.

Interactive fake client (set `"provider": "mock"` to try it without a key, start the companion, then):
```bash
pnpm fake-client --topic "Calculus 1" --difficulty easy
```

## Protocol

Transport is the Bedrock WebSocket protocol (`/connect`). Everything is ASCII on the wire: `base64url(UTF-8(JSON))`, so Unicode math survives.

- **Frame**: `mid|seq|total|chunk`. Uplink chunks are 360 characters, downlink 1500 (halved automatically if Minecraft rejects a command).
- **Companion to add-on**: `/scriptevent censor:m <frame>`; the command response is the acknowledgement, with retries. `/scriptevent censor:p <session>|1` is a ping every 4 s; the add-on treats 13 s of silence as disconnected. `/scriptevent censor:a mid|seq` acknowledges an uplink frame.
- **Add-on to companion**: `tell @s CZ1|<frame>` seen through the `PlayerMessage` event; resent every 2 s, up to 4 times.
- **Messages**: `hello`, `q.req` -> `q`, `q.ans` -> `v`, `t.start` / `t.ans` -> `t.q` / `t.res`, `cancel`, `err`. Each request carries an id `r`; the add-on waits 60 s (120 s for final exam grading).
- **Security**: reference answers and rubrics never leave the companion. Course files and player answers are passed to the model as delimited untrusted data with a random tag.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/connect` says it could not connect | companion running? loopback exemption (step 5)? "Require Encrypted WebSockets" off? try `ws://127.0.0.1:8765` |
| `/connect` unknown or not allowed | enable cheats; you must be an operator |
| Companion logs "Minecraft refused /scriptevent" | cheats off or the connected player is not an operator |
| Connected, but Censor says he is not connected | add-on not active in this world, or uplink not seen: check the companion log for "add-on linked" |
| Packs fail to load / script module error | game older than 1.26.60. Lower `min_engine_version` and the two module versions in `addon/packs/BP/manifest.json` **and** `addon/package.json` to what your game supports, then rebuild |
| Boxes instead of symbols | run the glyph test and trim `shared/glyphs.json` |
| AI errors | the companion console names the cause (bad key, quota, network, model name) |
| Port in use | change `websocket.port` and use it in `/connect` |
