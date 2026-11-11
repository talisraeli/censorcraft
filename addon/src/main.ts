import { GameMode, Player, system, world } from "@minecraft/server";
import { EVENT_GLYPHTEST, EVENT_NAMESPACE } from "@censorcraft/shared";
import { BOARD_ID, breakBoard, CENSOR_ID, completeBoard, facingOf, hasRoomForBoard, partOf, startBoards, validateSoon } from "./boards";
import { runGlyphTest } from "./glyphtest";
import { link } from "./link";
import { S } from "./strings";
import { openStudy } from "./study";

/**
 * CensorCraft behaviour pack entry point.
 * Uses only stable (non-beta) @minecraft/server and @minecraft/server-ui APIs.
 */

function isCreative(entity: unknown): boolean {
  try {
    return entity instanceof Player && entity.getGameMode() === GameMode.Creative;
  } catch {
    return false;
  }
}

// Block custom components must be registered during startup, before the world loads.
// The whiteboard has NO interaction handler on purpose: it is only Censor's workstation.
system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
  blockComponentRegistry.registerCustomComponent("censor:whiteboard_station", {
    // The board is 3 x 2 blocks: refuse to place it where the other five parts do not fit.
    beforeOnPlayerPlace: (event) => {
      const facing = facingOf(event.permutationToPlace);
      if (!facing || hasRoomForBoard(event.dimension, event.block.location, facing)) return;
      event.cancel = true;
      const player = event.player;
      if (player) {
        system.run(() => {
          try {
            if (player.isValid) player.onScreenDisplay.setActionBar(S.noRoom);
          } catch {
            /* cosmetic */
          }
        });
      }
    },
    // Any placement of the main block (players, /setblock, structures): build the rest and register it.
    onPlace: (event) => {
      const block = event.block;
      system.run(() => {
        try {
          if (block.isValid && block.typeId === BOARD_ID) completeBoard(block);
        } catch {
          /* chunk unloaded again */
        }
      });
    },
    // Any removal of any part: mining, explosions, commands.
    onBreak: (event) => {
      const dimensionId = event.dimension.id;
      const location = event.block.location;
      const permutation = event.brokenBlockPermutation;
      const drop = !isCreative(event.entitySource);
      system.run(() => breakBoard(dimensionId, location, permutation, drop));
    },
  });
});

link.init();

// The same facts again from the world events, in case a custom-component hook does not fire
// for some path. Everything is idempotent, and the periodic validation in boards.ts is the
// final safety net.
world.afterEvents.playerPlaceBlock.subscribe((event) => {
  if (event.block.typeId === BOARD_ID && partOf(event.block.permutation) === 0) completeBoard(event.block);
});
world.afterEvents.playerBreakBlock.subscribe((event) => {
  if (event.brokenBlockPermutation.type.id !== BOARD_ID) return;
  breakBoard(event.dimension.id, event.block.location, event.brokenBlockPermutation, !isCreative(event.player));
});
world.afterEvents.blockExplode.subscribe((event) => {
  if (event.explodedBlockPermutation.type.id !== BOARD_ID) return;
  breakBoard(event.dimension.id, event.block.location, event.explodedBlockPermutation);
});
world.afterEvents.explosion.subscribe(() => validateSoon(2));

// Right-clicking Censor opens the study menu instead of any vanilla interaction.
// Cancel in the before-event (read-only context), then open the form on the next tick.
world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
  if (event.target.typeId !== CENSOR_ID) return;
  event.cancel = true;
  const { player, target } = event;
  system.run(() => void openStudy(player, target));
});

// Dev tool: /scriptevent censor:glyphtest
system.afterEvents.scriptEventReceive.subscribe(
  (event) => {
    if (event.id === EVENT_GLYPHTEST) runGlyphTest(event.sourceEntity);
  },
  { namespaces: [EVENT_NAMESPACE] },
);

world.afterEvents.worldLoad.subscribe(() => {
  link.loadState();
  startBoards();
});
