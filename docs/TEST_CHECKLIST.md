# Manual in-game test checklist

None of this could be run during development. Use a creative world with cheats on, the add-on active, the companion running and `/connect ws://localhost:8765` done. Keep the content log on (Settings > Creator).

## Whiteboard
- [ ] No script or pack errors in the content log when the world loads.
- [ ] Whiteboard is in the creative inventory (Items) and the recipe works: 6 paper over stick / apple / stick.
- [ ] Placed board faces you from all four directions.
- [ ] The board is 3 blocks wide and 2 high, with one continuous frame and writing surface (no seams or misaligned parts), in all four directions.
- [ ] A red apple with stem and green leaf sits on the bottom tray of the centre block, clearly visible from the front.
- [ ] Placing where a 3 x 2 space is not free is refused with an action-bar message.
- [ ] Breaking any of the six parts removes the whole board and drops exactly one whiteboard item (none in creative).
- [ ] Right-clicking the board does nothing.

## Claiming
- [ ] Board placed within 16 blocks of a jobless adult villager: he becomes "Prof. Censor" within about 2 s.
- [ ] Villagers with a profession, nitwits and babies are not claimed.
- [ ] Board placed with no villager around stays unclaimed; spawn a villager nearby and it is claimed within a few seconds.
- [ ] A second jobless villager near a claimed board is left alone.
- [ ] No spawn egg for Censor exists.

## Appearance and behavior
- [ ] Dark brown hair.
- [ ] Glasses on his face, stick in the raised right arm pointing forward, name tag "Prof. Censor" always shown.
- [ ] After claiming far away he walks to the board (teleports after 25 s if he cannot path).
- [ ] He idles within about 6 blocks, faces the board when alone, turns to a nearby player.
- [ ] `/time set night`: he does not sleep or leave. Check again after a full night.
- [ ] Push or lead him 15 blocks away: he walks back.
- [ ] He takes no damage (sword, fire, fall, TNT).

## Removing the whiteboard
- [ ] Break it by hand: Censor becomes a plain jobless villager (no name, glasses or stick) and can take a vanilla job.
- [ ] Same with TNT (one item dropped, not six) and with `/setblock ~ ~ ~ air` on any part.
- [ ] A piston cannot push any part of the board.
- [ ] A villager that had a custom name gets it back.
- [ ] `/summon censor:professor` with no board turns into a villager within 2 s.

## Study flow
- [ ] Companion not running: right-click gives the in-character steps in chat; no trade screen ever opens.
- [ ] Topic menu shows Calculus 1, Linear Algebra, C Fundamentals, Custom topic (text field).
- [ ] Difficulty menu shows reward previews, rewards left today and cooldown.
- [ ] "Censor is thinking…" on the action bar while waiting.
- [ ] Multiple choice (4 buttons), short answer (text field with typing hint) and, for C topics, one-line code questions all appear.
- [ ] Verdict form shows explanation, reward line and stats; Next question / Change topic / Leave work.
- [ ] Correct answer: items, XP, happy particles, nod, chat line. Wrong: angry particles, head shake.
- [ ] ASCII answers such as `sqrt(2)` or `1/2` are accepted.
- [ ] Hard question with a half-right answer gives partial credit and a reduced reward.
- [ ] Test mode: 5 questions, no feedback in between, closing a question asks to confirm quitting, 80% passes, big reward plus title and score summary.
- [ ] Note the chat noise: one "You whisper to yourself" line per request for the connected player only. If the companion log says uplink arrives as "say", whispers were not visible and everyone sees the lines.

## Glyphs
- [ ] `/scriptevent censor:glyphtest` prints all categories. Record which characters show as boxes and remove them from `shared/glyphs.json`.
- [ ] A question with math reads correctly inside a form, no backslashes or `$`.

## Robustness
- [ ] Stop the companion while "thinking": within about 15 s Censor says he lost the connection; no stuck form.
- [ ] Restart the companion and `/connect` again: studying works without reloading the world.
- [ ] Cooldown: two correct answers within 20 s, the second gives "on cooldown" and no items.
- [ ] Daily cap and "already answered" messages appear when triggered.
- [ ] Full inventory: reward items drop at your feet.

## Multiplayer
- [ ] Two boards, two Censors, each stays at his own board.
- [ ] A second player (not the one who ran `/connect`) can study at the same time with separate questions, stats and rewards.
- [ ] The host disconnecting ends the link for everyone with the in-character message.

## World reload
- [ ] Leave and rejoin: every Censor is still linked, named and near his board.
- [ ] Break a board, leave immediately, rejoin: Censor is a villager.
- [ ] Player stats (streak, counts, daily cap) survive the reload.
