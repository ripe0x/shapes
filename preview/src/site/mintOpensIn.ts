/** Whether minting is open yet, computed from the contract's immutable `mintStart()` (unix
 *  seconds; 0 means open at deploy) and the current time. Pure so the gate on the mint button and
 *  the landing's inline mint slot agree without either holding its own clock logic. */
export interface MintOpenState {
  open: boolean;
  /** 0 once open. */
  secondsLeft: number;
}

export function mintOpensIn(nowMs: number, mintStartSeconds: bigint): MintOpenState {
  const startMs = Number(mintStartSeconds) * 1000;
  const secondsLeft = Math.max(0, Math.ceil((startMs - nowMs) / 1000));
  return {open: secondsLeft <= 0, secondsLeft};
}

/** "H:MM:SS" for a countdown line; drops the hours place under an hour. */
export function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
