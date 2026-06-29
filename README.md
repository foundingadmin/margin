# margin

A Chrome extension.

## Status

This repository is being set up. Project files are loaded via GitHub's web
interface (**Add file → Upload files**) or by pushing from a local clone.

## Project layout

Once the extension files are loaded, a typical Chrome extension layout looks
like:

```
margin/
├── manifest.json        # Extension manifest (required, MV3)
├── background.js        # Service worker / background script
├── content/             # Content scripts
├── popup/               # Popup UI (HTML/CSS/JS)
├── icons/               # Extension icons
└── assets/              # Static assets
```

## Loading the extension locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project's directory (or the build
   output directory, if the extension has a build step).
