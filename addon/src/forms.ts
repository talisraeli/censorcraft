import { Player, system } from "@minecraft/server";
import { FormCancelationReason } from "@minecraft/server-ui";

interface Showable<T> {
  show(player: Player): Promise<T>;
}

interface Cancelable {
  canceled: boolean;
  cancelationReason?: FormCancelationReason;
}

/**
 * Show a form, retrying while the player is busy (chat open, another screen,
 * the interaction that triggered us still closing). Returns undefined when the
 * player closed the form, left the game, or stayed busy for too long.
 */
export async function showForm<T extends Cancelable>(player: Player, form: Showable<T>, maxBusyTicks = 600): Promise<T | undefined> {
  let waited = 0;
  for (;;) {
    if (!player.isValid) return undefined;
    let response: T;
    try {
      response = await form.show(player);
    } catch {
      return undefined; // player left while the form was open
    }
    if (!response.canceled) return response;
    if (response.cancelationReason !== FormCancelationReason.UserBusy) return undefined;
    if (waited >= maxBusyTicks) return undefined;
    await system.waitTicks(10);
    waited += 10;
  }
}

/** Animated action-bar message ("Censor is thinking...") until the returned function is called. */
export function startIndicator(player: Player, text: (dots: string) => string): () => void {
  let frame = 0;
  const draw = () => {
    if (!player.isValid) return;
    try {
      player.onScreenDisplay.setActionBar(text(".".repeat((frame++ % 3) + 1)));
    } catch {
      /* player is changing dimension */
    }
  };
  draw();
  const handle = system.runInterval(draw, 10);
  return () => {
    system.clearRun(handle);
    if (!player.isValid) return;
    try {
      player.onScreenDisplay.setActionBar(" ");
    } catch {
      /* ignore */
    }
  };
}
