# LEVO Studio — iPad check (manual, ~5 minutes)

**iOS is not verified.** Everything measured so far ran on Chromium in CI. The
iOS behaviour is *designed for* — Apple user agents are classified as
memory-constrained, so they mount without the WASM warm-up and are not sent
the cross-origin isolation headers — but nobody has run it on a real device.
This is the shortest sequence that would expose it if that design is wrong.

Open **https://studio.levonis-iq.com** in **Safari on iPad**. Do the steps in
order; each row is one thing to look at.

| # | Do this | It is fine if | Tell me if |
| --- | --- | --- | --- |
| 1 | Open Studio and wait for the empty bed | It reaches the empty bed and stays responsive | It reloads itself, goes white, or shows *"Worker terminated (likely out of memory)"* |
| 2 | Import a model (any STL) | It appears on the bed | Any out-of-memory message, or the tab reloads |
| 3 | Orbit with one finger, a few seconds | The view follows your finger continuously | It moves in steps, sticks, or lags behind |
| 4 | Pinch to zoom, then two-finger drag to pan | Both follow smoothly | Either stutters or jumps |
| 5 | Duplicate 10 times (Duplicate, ten times) | Every copy lands **on the bed**, next to the others | A copy lands off the bed, or *"Beyond the bed"* appears when it clearly is not |
| 6 | Drag, rotate and scale one object | Each follows your finger | Any of them is slow or jumpy |
| 7 | Slice | It slices and shows the preview | Out of memory, or the tab reloads |
| 8 | Cancel mid-slice | It stops | Cancel does nothing (**this one is expected on iOS — see the note below**) |
| 9 | Slice again | It slices again, no slower than the first time | Out of memory, or noticeably slower each time |
| 10 | Paint (support or material), a few strokes | The strokes appear and stay | The strokes vanish |
| 11 | Press Home / switch to another app, wait ~30s | — | — |
| 12 | Return to Safari | The model, the layout **and the paint strokes** are all still there | Anything is missing, blank, or the page reloaded |
| 13 | Save the project, then open it again | It opens with the same layout **and the same paint strokes** | The layout moved, or the paint is gone |

## Two notes before you start

**Step 8 will probably fail, and that is known.** Cancelling a slice is
signalled through a `SharedArrayBuffer`, which only exists when the page is
cross-origin isolated. iOS is deliberately not sent the isolation headers,
because with them Safari loads the multithreaded WASM core, which reserves
4 GiB of shared memory and starts one worker per CPU — the direct cause of
the out-of-memory crash on phones. So on iPad, Cancel is expected to do
nothing until the slice finishes. If everything else passes and only step 8
fails, that is the current known limit, not a new bug.

**Steps 13 and 12 are the ones I most want the answer to.** Painting lives
only inside the slicing kernel's memory, and a released worker takes it with
it. There is now a latch that refuses to release the worker for the rest of
any session in which you have painted, and steps 10–13 are exactly the
sequence that would catch it if that latch is wrong on iOS. If the strokes
survive backgrounding *and* survive a save-and-reopen, the latch works on
real hardware.

If anything fails, the most useful thing to send is: **which step number**,
and whether the page reloaded itself.
