# Agent Web 按需加载与输入区验收

Owner: Agent Terminal Web, CHG-20261009-003. All recordings use isolated synthetic
Sessions, memories, files and a fake Codex backend. No real model, microphone or
production account was used. The tested product code is `4763e96` and Platform
`v0.42.0` (`69da9fa`). Central authorization, deployment and Maintain evidence
remain in the owning Change.

| Recording | Verified behavior |
| --- | --- |
| [Startup](startup/storyboard.md) | Empty drafts load no Markdown/math or auxiliary features; slow lists do not block the selected conversation; both plus buttons avoid navigation; send mode, Enter, queue, upward menu, 44px targets and 320/390/768px layouts |
| [Experience](experience/storyboard.md) | Actual memory citations, in-site file/image previews, local preview retry and background result updates |
| [Features](features/storyboard.md) | First resource failure leaves a visible local error and preserves the draft; retry opens integrations; memory loads on entry and reuses its script |
| [Timing](timing/storyboard.md) | Observable input readiness on cold/cache entry and recent-content readiness after switching |

Videos and ordered frames are included beside each storyboard. Desktop is a
Chromium viewport; mobile is a 390px viewport, with additional width checks.

| Loopback, unthrottled synthetic backend | Desktop | Mobile viewport |
| --- | ---: | ---: |
| Cold draft editable | 229ms | 98ms |
| Cached entry editable | 69ms | 60ms |
| Switch: recent content visible | 101ms | 64ms |

These timings are single local observations, not phone or production latency
promises. The empty draft requested two generated JS files totaling 481397 bytes;
Markdown, formula and auxiliary scripts were absent. The main entry is 471815
bytes versus the pre-change production entry's 913603 bytes.
