/** Optional navigation downloads must not compete with the current screen. */
export function allowsSpeculativeLoads(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '') &&
    !window.matchMedia?.('(prefers-reduced-data: reduce)').matches;
}

/** Wait for the current first-screen images, fonts and document, then yield a
 * painted frame before taking idle time. A JS idle slot alone says nothing
 * about whether the LCP photograph is still downloading. Cancellation also
 * detaches pending image/load listeners when a route is left. */
export function afterCriticalPaint(work: () => void): () => void {
  let active = true;
  let frame = 0;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detach: Array<() => void> = [];
  const waitFor = (target: EventTarget, names: string[]) => new Promise<void>((resolve) => {
    const finish = () => { for (const name of names) target.removeEventListener(name, finish); resolve(); };
    for (const name of names) target.addEventListener(name, finish, { once: true });
    detach.push(finish);
  });
  const loaded = document.readyState === 'complete' ? Promise.resolve() : waitFor(window, ['load']);
  const fonts = Promise.resolve(document.fonts?.ready).catch(() => {});
  // Called after React commits the page's data, so the selected pictures are
  // already in the DOM. Offscreen slides and lazy cards are not a boot gate.
  const images = Array.from(document.images).filter((image) => {
    const box = image.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
  }).map(async (image) => {
    if (!image.complete) await waitFor(image, ['load', 'error']);
    if (active && image.naturalWidth > 0 && image.decode) await image.decode().catch(() => {});
  });
  void Promise.all([loaded, fonts, ...images]).then(() => {
    if (!active) return;
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        if (!active) return;
        const run = () => { if (active) work(); };
        if (window.requestIdleCallback) idle = window.requestIdleCallback(run);
        else timer = setTimeout(run, 500);
      });
    });
  });
  return () => {
    active = false;
    for (const remove of detach) remove();
    window.cancelAnimationFrame(frame);
    if (idle !== undefined) window.cancelIdleCallback?.(idle);
    if (timer !== undefined) clearTimeout(timer);
  };
}
