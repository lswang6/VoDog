# Signal UI

[Documentation](../../README.md) · [简体中文](README.zh-CN.md)

Signal is the shared interface system for the VoDog Web, iOS, Android and macOS clients. The clients share meaning, hierarchy and section order; each one keeps its platform's native controls. Authoritative values live in [tokens.json](tokens.json).

## Principles

1. **Same five sections, same order:** Calls · Messages · Records · Contacts · Settings. macOS adds a Devices group; Web administrators also see Gateways.
2. **Line first:** every SIM has a fixed line color shown as a small rounded square, never a dot. Connection state is carried by shape, not color alone.
3. **Status in plain words:** three distinct connection problems, each stating the impact and the next step.
4. **One primary action per screen:** green only for call / answer, red only for hang up and destructive actions, brand blue for everything else.
5. **Native first:** navigation, type, materials and gestures use platform controls (iOS Liquid Glass and SF Symbols, Android Material 3, macOS sidebar and popovers). No WebView-style uniformity.

## Semantic color tokens

Light mode uses a tinted ground with soft-white cards, never large pure-white areas. Appearance offers Dark / Light / System.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg` | `#EEEFF3` | `#0B0E13` | Page background |
| `chrome` | `#F6F6F9` | `#141920` | Web sidebar and top bar; macOS window content |
| `surface` | `#FBFBFD` | `#141920` | Cards, list groups, dialogs |
| `surface2` | `#ECEDF1` | `#1B2129` | Keys, inputs, segmented-control track, selected rows |
| `surface3` | `#E1E3E9` | `#252C36` | Avatars, received bubbles, unplayed waveform |
| `line` | `#E2E4EA` | `#28303B` | 1px dividers and card borders |
| `ink` | `#111827` | `#EDF0F5` | Titles, body text |
| `ink2` | `#424B59` | `#BAC2CE` | Secondary text, unselected navigation |
| `ink3` | `#667080` | `#8F99A7` | Timestamps and hints (on surface only) |
| `brand` | `#1F5FD1` | `#7AA7FF` | Selection, links, primary buttons, sent bubbles |
| `onBrand` | `#FFFFFF` | `#0B1730` | Text on solid brand |
| `brandSoft` | `#E9F0FD` | `#1A2945` | Selected navigation and rows |
| `bubbleOut` | `#1F5FD1` | `#2F64D6` | Sent SMS bubble |
| `call` | `#17824B` | `#3DCC85` | Online dot, in-call text |
| `callFill` | `#1E8A50` | `#1E8A50` | Solid call / answer button (white text) |
| `callSoft` | `#E4F4EA` | `#11301F` | Call bar, in-call pill |
| `danger` | `#C2302B` | `#FF7A73` | Missed numbers, destructive text |
| `dangerFill` | `#D33A35` | `#D33A35` | Hang-up / decline button, unread badge |
| `dangerSoft` | `#FCECEB` | `#3A1B1B` | Missed-call icon background |
| `warn` | `#9A5800` | `#F4BA4E` | Pending / queued |
| `warnSoft` | `#FFF4DE` | `#38290D` | "Service unavailable" banner |
| `ai` | `#6941C6` | `#B9A2FF` | AI answering label and speaker |
| `aiSoft` | `#F2EDFD` | `#261F42` | AI summary card, AI badge background |

Line colors follow the existing SIM palette: index by `(slotIndex, id)` rank, unrelated to online state; see `simPalette` in [tokens.json](tokens.json).

## Line chip and status shapes

A line chip is a `surface2` pill: line-color square + line name + optional number tail (tabular digits) + status shape. Selected chips use `brandSoft` with a 1.5px `brand` border.

| Shape | Meaning | Color |
| --- | --- | --- |
| ● filled | Online | `call` |
| ○ hollow | Offline (followed by the word "Offline") | `ink3` |
| ◐ half | Pending / waiting for the device to apply | `warn` |

## Connection banners

Rounded banners with an icon, bold title and one sentence. They sit above content and never replace a list with a full-screen error.

| Banner | Background | Meaning |
| --- | --- | --- |
| This device is offline | `surface2` | Loaded content and drafts still work; refreshes automatically when back online. |
| Service temporarily unavailable | `warnSoft`, `warn` text | Retrying automatically. |
| Number device offline | `surface2` + line chip | Names the offline gateway and which actions are unavailable. |

## AI badge

Calls answered by AI carry a **✦ AI** badge in `ai` on `aiSoft`. AI summaries use an `aiSoft` card; in transcripts the AI speaker uses `ai` while the caller and you use `ink`.

## Call bar

While a call is active, a global call bar stays visible across sections:

- **Web:** 52px `callSoft` bar at the top of the page: ● In call · name · line chip · timer (tabular digits) · Mute · Return to call · End.
- **iOS / Android:** full-width 44pt/dp `callFill` bar below the safe area: ● name, timer, Return to call ›. It never wraps.

The hang-up button uses `dangerFill`; while ending it turns `surface3`, reads "Ending…" and is disabled.

## Platform-native rules

- **Web:** 244px `chrome` sidebar with five sections and a Lines list; 68px top bar with page title and line selector; bottom tab bar at narrow widths. Targets at least 44px.
- **iOS:** large title with round glass buttons; system floating Liquid Glass tab bar; line chips below the title; Dynamic Type; targets at least 44pt.
- **Android:** single-line TopAppBar, Material 3 NavigationBar, FilterChip line selection, Extended FAB for Call; targets at least 48dp.
- **macOS:** labeled sidebar groups, toolbar pop-up for line selection, popovers; controls 28pt, rows at least 44pt.
- **Type:** system fonts everywhere. Tabular digits only for numbers, times, timers and codes.
- **Shape:** spacing in multiples of 4; radii tag 6 · control 12 · card 16 · panel 22 · pill 999.
