# Privacy Policy

**유튜브 요약 (Gemini)** ("this extension") is a browser extension that summarizes YouTube videos using the Google Gemini API. This page explains what data the extension handles and how.

## Data collected by the developer

**None.** This extension has no backend server, no analytics, and no tracking of any kind. The developer does not collect, store, receive, or have access to any of your data.

## Data stored locally

The following data is stored only in your own browser, using the standard `storage.local` extension API:

- Your Gemini API key
- Your selected Gemini model name
- The text and video URL of your most recent summary (so it persists when you close and reopen the sidebar)

This data never leaves your device except as described below, and is never transmitted to the developer.

## Data sent to third parties

When you request a summary, your browser sends the YouTube video URL and a text prompt directly from your browser to **Google's Gemini API** (`generativelanguage.googleapis.com`), using the API key you provided. This request is authenticated with your own API key and is subject to [Google's Privacy Policy](https://policies.google.com/privacy) and the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms).

No other third party receives any data from this extension.

## Permissions

- `storage` — to save your API key, model choice, and last summary locally.
- `sidePanel` (Chrome) / `sidebar_action` (Firefox) — to display the extension's UI as a persistent sidebar.
- Host permission for `generativelanguage.googleapis.com` — to call the Gemini API directly from your browser.
- Host permission for `youtube.com` — to read the active tab's URL so the sidebar can automatically fill in the video address as you switch tabs or navigate to a new video.

## Contact

This is an open-source project. Source code, issue tracker, and contact information are available at:
https://github.com/jeongho3786/gemini-youtube-summarizer
