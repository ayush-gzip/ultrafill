# UltraFill

Chrome extension that removes the side black bars when 16:9 video plays on an ultrawide screen, without cropping burned-in subtitles.

Works on YouTube, Netflix, Crunchyroll and any site with a normal `<video>` player, including DRM-protected video.

## Modes

| Mode | What it does | Crops? |
|------|--------------|--------|
| **Elastic** (default) | Fills the width. The center keeps its true shape, the edges take the stretch. | No |
| **Stretch** | Fills the width with an even stretch. | No |
| **Zoom** | Scales up until the screen is full. Use for movies with black bars baked into the video. | Top and bottom |
| **Off** | Original picture. | No |

Pick a mode in the toolbar popup, or press **Alt+Shift+F** to cycle (change it at `chrome://extensions/shortcuts`).

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. If ZoomToFill or a similar extension is installed, turn it off. Two extensions that both move the video will fight.

## How Elastic works

The video gets a CSS `scale` so the picture fills the player box, then an SVG `feDisplacementMap` filter squeezes the center back to its true shape and moves the stretch to the edges. Everything runs in the GPU compositor, so it also works on DRM video, which a canvas/WebGL approach cannot read.

The displacement map is coded in the **alpha** channel: Chrome passes filter colors through the display's tone curve, which skews a color-coded map, but it never touches alpha.

## Limits

- Only touches players at least 60% of the window width, so small inline videos are left alone.
- Videos inside closed shadow DOM are not found.
- Elastic and Stretch only widen. Video that is already wider than the screen is left alone (use Zoom).
