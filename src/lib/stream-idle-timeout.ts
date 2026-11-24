import type { Request, Response } from "express";

export function abortOnIdleStream(readProgress: () => number, abort: () => void) {
  let progress = readProgress();
  let lastProgressAt = performance.now();
  const timer = setInterval(() => {
    const current = readProgress();
    if (current !== progress) {
      progress = current;
      lastProgressAt = performance.now();
    } else if (performance.now() - lastProgressAt >= 30_000) {
      clearInterval(timer);
      abort();
    }
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function limitUploadIdleTime(req: Request, res: Response) {
  const socket = req.socket;
  if (!socket || req.readableEnded) return;
  const stop = abortOnIdleStream(() => socket.bytesRead, () => req.destroy());
  const cleanup = () => {
    stop();
    req.off("end", cleanup);
    req.off("close", cleanup);
    res.off("finish", cleanup);
    res.off("close", cleanup);
  };
  req.once("end", cleanup);
  req.once("close", cleanup);
  res.once("finish", cleanup);
  res.once("close", cleanup);
}
