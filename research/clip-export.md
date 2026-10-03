# Research: browser clip export of the knockout

Issue: [#12](https://github.com/troy-johnson/fantasy-draft-order/issues/12), part of #1.
Date: 2026-10-02.

Question: how can the browser record the knockout canvas and its audio as a shareable clip (MP4, WebM, or GIF), and how does the clip get to a group chat?

## Summary

- **Yes, the browser can do it.** All current target browsers (iOS Safari 14.5+, Android Chrome, desktop Chrome/Safari/Firefox) have `MediaRecorder` and `canvas.captureStream()` [1][2][3].
- **Best path: offline render with WebCodecs + Mediabunny to H.264/AAC MP4.** The knockout is a pure function of `elapsedMs`, so the app can draw each frame on demand and encode faster than realtime. WebCodecs is in Chrome 94+, Safari/iOS 26+ (video-only from 16.4), and desktop Firefox 130+ [4][5][6].
- **Fallback: realtime `MediaRecorder`.** Use it where WebCodecs is missing (Firefox for Android) [5]. Ask for `video/mp4` first: Chrome 126+ and Safari can record MP4 (H.264/AAC) [7][8].
- **Send MP4, not WebM or GIF.** WhatsApp's media docs accept only H.264/AAC MP4 or 3GP, 16 MB max [9]. Discord lists MP4 as a video type, 20 MB free limit [10]. GIF has no audio [11]. ffmpeg.wasm is ~31 MB of wasm and about 25x slower than native [12][13].
- **Share with `navigator.share({ files })`** on iOS Safari 14+ and Android Chrome 76+ [6][14]. A Cloudflare Worker cannot render it: no canvas, no WebCodecs, 128 MB memory [15][16].

## How the app renders today (from the code)

- `src/KnockoutRink.tsx` draws a 384x216 logical scene (`VIEW_W`/`VIEW_H` in `src/pixel.ts:6`) with `draw(ctx, scale, scene, elapsedMs, ...)`. The output depends only on the plan and `elapsedMs`. This makes an offline, frame-by-frame render possible.
- The replay picture-in-picture is a **second** canvas (`pipRef`), and the jumbotron headline is a **DOM** `<div>`. `captureStream()` on the main canvas records neither. An export must composite all three onto one export canvas.
- `src/audio.ts:144-161` builds one `AudioContext` graph: `master -> DynamicsCompressor -> ctx.destination`, with music, SFX, PA, and booth buses. A `MediaStreamAudioDestinationNode` connected after the limiter would carry the full mix into a recorder [17].
- Announcer clips come from `/api/rooms/:code/voice/:i` and go through `decodeAudioData` (`src/audio.ts:315-360`). These can play in an `OfflineAudioContext`. The `speechSynthesis` fallback (`src/audio.ts:405`) cannot be captured: the Web Speech API defines no audio stream output [18].
- `src/SoundDirector.tsx` fires cues from the game clock (`cuesBetween(cues, before, elapsedMs)`). An offline audio render needs the same cue list scheduled at absolute times on an `OfflineAudioContext`, which renders "as fast as it can" into an `AudioBuffer` [19].

## Options compared

| | A. MediaRecorder + `captureStream` + `MediaStreamAudioDestinationNode` | B. WebCodecs + Mediabunny (successor to mp4-muxer) | C. ffmpeg.wasm | D. GIF encoder (gifenc, gif.js) |
|---|---|---|---|---|
| iOS Safari | 14.5+ (MediaRecorder) [1]; `captureStream` 11+ [3] | `VideoEncoder` 16.4+, `AudioEncoder` 26+ [5][6]; AAC polyfill `@mediabunny/aac-encoder` for older [20] | Runs as wasm; speed and memory on phones not verified | Pure JS; works anywhere canvas works |
| Android Chrome | Yes [1] | Yes, 94+ [4] | Yes, slow | Yes |
| Firefox for Android | Yes [1] | **No** WebCodecs [4][5] | Yes, slow | Yes |
| Output | Chrome: WebM (VP8/VP9/Opus), MP4 (H.264/AAC) from 126 [7]. Safari: MP4 by default, WebM from 18.4 [8][21] | MP4, WebM, MOV, MKV, and more; you choose codec [22] | Any format FFmpeg builds in | GIF only, 256-colour palette, **no audio** [11] |
| Audio | Yes, mix from Web Audio | Yes, from an `AudioBuffer` (offline) or a track | Yes | No |
| Speed | **Realtime only**: a 60 s knockout takes 60 s and the tab must stay visible | **Faster than realtime**: draw frame N, encode, repeat; hardware encoders where present [22][23] | Far slower than realtime: 10 s 720p WebM→MP4 took 128.8 s single-thread, 60.4 s multi-thread on a laptop [13] | Faster than realtime in a Worker, but quantising each frame costs CPU |
| Size, 60 s 720p | Default video bitrate is 2.5 or 10 Mbps by browser [24]: ~19 MB to ~75 MB. Set `videoBitsPerSecond` ~1 Mbps for ~8 MB (estimate) | Bitrate is set by you; ~1 Mbps H.264 + 96 kbps AAC ≈ 8 MB (arithmetic estimate) | Same as B for the same codec settings | Not measured. Likely larger than MP4 for 60 s at 720p; flat pixel art helps |
| Download cost | 0 (built in) | Tree-shakable, "as small as 5 kB gzipped" [22] | `ffmpeg-core.wasm` is 32,232,419 bytes (npm `@ffmpeg/core@0.12.10`, measured) [12] | Small JS library [25][26] |
| Main risk | Realtime, frame drops on slow phones, captures only one canvas | Code path per browser; must re-drive audio offline | Size, speed, multi-thread needs cross-origin isolation (not verified) | No sound; no announcer, which is half the fun |

## Recommendation

1. **Build an offline exporter on Mediabunny.** Use `CanvasSource` for video and `AudioBufferSource` for audio into `Mp4OutputFormat`, codecs `avc` + `aac` [22][27]. Turn on fast-start (moov before mdat), because WhatsApp asks for it [9].
2. **Render at an integer scale** of 384x216, for crisp pixels: 1152x648 (3x) or 1536x864 (4x). 1280x720 is 3.33x and would blur the pixel art.
3. **Composite** the rink, the PiP replay, and the jumbotron text into one export canvas per frame.
4. **Render audio offline.** Build the same graph from `src/audio.ts` on an `OfflineAudioContext` and schedule every cue from `buildCues()` at its absolute time [19]. Skip clips that only exist as `speechSynthesis`.
5. **Fall back to realtime MediaRecorder** when `VideoEncoder` is missing. Try `video/mp4;codecs=avc1.42E01E,mp4a.40.2` first with `isTypeSupported()`, then `video/webm` [24][28].
6. **Do not ship ffmpeg.wasm or a GIF-only export.** A short, silent GIF of one hit could be a later add-on.
7. Use H.264 **Baseline or Main without B-frames** for the widest client support [9].

## Sharing to group chats

- `navigator.share({ files: [file] })` is the Web Share API Level 2 file path. Call `navigator.canShare({ files })` first [14][29].
- Support for the `files` member: Chrome for Android 76+, Safari and iOS Safari 14+, desktop Chrome 89+ (Windows/ChromeOS), and all desktop Chrome 128+. Desktop Firefox has it only behind a pref [6].
- MDN lists `video/mp4` and `video/webm` as shareable types [14].
- `share()` needs transient activation [14]. Transient activation lasts only a short, implementation-defined time [30]. An encode can take longer than that, so show a second "Share clip" button when the file is ready.
- Fallback: an `<a download>` link where `canShare` is false (desktop Firefox).
- Per app:
  - **WhatsApp**: H.264 video and AAC audio only, MP4 or 3GP, 16 MB max. It warns against H.264 High profile with B-frames on Android [9]. WebM would not work.
  - **Discord**: lists MP4 with H.264, HEVC, or AV1; free upload limit 20 MB (since August 2026) [10].
  - **iMessage**: not verified from an Apple source. H.264/AAC MP4 is the safe choice.
  - **GroupMe**: no primary source found. Not verified.
- Keep the clip under 16 MB to pass every limit found. At ~1 Mbps, 60 s is ~8 MB.

## Server-side render on a Cloudflare Worker

Not practical:

- The Workers runtime lists its web APIs. Canvas, `OffscreenCanvas`, and WebCodecs are not among them [15].
- Memory is 128 MB per isolate. CPU time is 30 s by default and 5 min at most per request on the paid plan [16]. A software H.264 encode of 60 s of 720p in wasm would likely exceed this (not measured).
- Cloudflare **Browser Run** (formerly Browser Rendering) gives a headless Chrome, but its browser timeout is 60 s, and the free plan allows 10 browser-minutes a day [31]. It is also realtime capture inside a remote browser. Whether its Chromium build has an H.264 encoder is not verified.
- **Cloudflare Containers** can run native FFmpeg next to a Worker on the paid plan [32]. This is the only viable server option, but it adds a container, a headless renderer for the canvas, and cost. The client already holds the plan and the seed, so the client is the cheaper place to render.

## Unverified

- Real file sizes. All sizes above are bitrate arithmetic, not measured exports of this game.
- How well iOS Safari's `MediaRecorder` records a `captureStream()` canvas with Web Audio (frame drops, A/V sync).
- Whether WebCodecs `AudioEncoder` supports AAC on Chrome for Android. Mediabunny notes that "in some browsers, AAC encoding is not supported" [20]. Check at runtime with `canEncode('aac')` [20].
- Whether Chrome's MediaRecorder MP4 is fragmented, and whether WhatsApp accepts it as is.
- Inline playback of shared MP4/WebM in iMessage and GroupMe. No Apple or GroupMe document was found.
- WhatsApp limits come from the WhatsApp Cloud API docs [9]. The consumer app may differ.
- Firefox for Android `files` share support. BCD marks it as mirroring desktop Firefox (behind a pref) [6], but caniuse lists Web Share as supported there [29].
- ffmpeg.wasm speed and memory on phones, and its cross-origin isolation needs.
- GIF size for 60 s of this scene.

## Sources

1. caniuse, MediaRecorder API: https://caniuse.com/mediarecorder
2. MDN BCD, `api.MediaRecorder`: https://github.com/mdn/browser-compat-data/blob/main/api/MediaRecorder.json
3. MDN, `HTMLCanvasElement.captureStream()`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream ; BCD: https://github.com/mdn/browser-compat-data/blob/main/api/HTMLCanvasElement.json
4. caniuse, WebCodecs API: https://caniuse.com/webcodecs
5. MDN BCD, `VideoEncoder` and `AudioEncoder`: https://github.com/mdn/browser-compat-data/blob/main/api/VideoEncoder.json , https://github.com/mdn/browser-compat-data/blob/main/api/AudioEncoder.json
6. MDN BCD, `Navigator.share` / `canShare` / `data_files_parameter`: https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json
7. Chrome Platform Status, "MP4 container support for MediaRecorder" (Chrome 126): https://chromestatus.com/feature/5163469011943424 ; "H26x Codec support updates for MediaRecorder" (Chrome 136): https://chromestatus.com/feature/6375884229181440
8. WebKit, "New WebKit Features in Safari 14.1" (MediaRecorder): https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/
9. Meta, WhatsApp Cloud API, Media, "Supported media types": https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
10. Discord, File Attachments FAQ: https://support.discord.com/hc/en-us/articles/25444343291031-File-Attachments-FAQ
11. W3C, GIF89a specification: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
12. npm, `@ffmpeg/core`: https://www.npmjs.com/package/@ffmpeg/core
13. ffmpeg.wasm docs, Performance and FAQ: https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/performance.md , https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/faq.md
14. MDN, `Navigator.share()` (shareable file types, security): https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share
15. Cloudflare, Workers Web standards: https://developers.cloudflare.com/workers/runtime-apis/web-standards/
16. Cloudflare, Workers limits: https://developers.cloudflare.com/workers/platform/limits/
17. MDN, `MediaStreamAudioDestinationNode`: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode
18. W3C CG, Web Speech API: https://webaudio.github.io/web-speech-api/
19. MDN, `OfflineAudioContext`: https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext
20. Mediabunny, Supported formats and codecs (AAC footnote, `canEncode`): https://mediabunny.dev/guide/supported-formats-and-codecs
21. WebKit, "WebKit Features in Safari 18.4" (MediaRecorder WebM): https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ ; "WebKit Features in Safari 26.0" (AudioEncoder): https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
22. Mediabunny repository README: https://github.com/Vanilagy/mediabunny
23. W3C, WebCodecs: https://www.w3.org/TR/webcodecs/
24. MDN, `MediaRecorder()` constructor (default bitrate note): https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/MediaRecorder
25. gifenc: https://github.com/mattdesl/gifenc
26. gif.js: https://github.com/jnordberg/gif.js
27. Mediabunny, Media sources (`CanvasSource`, `AudioBufferSource`): https://mediabunny.dev/guide/media-sources ; mp4-muxer deprecation notice: https://github.com/Vanilagy/mp4-muxer
28. MDN, `MediaRecorder.isTypeSupported()`: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
29. caniuse, Web Share API: https://caniuse.com/web-share ; W3C, Web Share API: https://www.w3.org/TR/web-share/
30. WHATWG HTML, transient activation duration: https://html.spec.whatwg.org/multipage/interaction.html#transient-activation-duration
31. Cloudflare, Browser Run limits: https://developers.cloudflare.com/browser-run/limits/
32. Cloudflare, Containers: https://developers.cloudflare.com/containers/
