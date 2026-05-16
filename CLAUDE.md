# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (UUID `claude-code-usage@haletran.com`, GNOME Shell 46–49) that shows Claude Code's 5-hour and 7-day API usage in the top panel. Written in GJS (GNOME JavaScript) using ES modules and `gi://` imports — this is *not* Node.js. Standard npm/Node tooling does not apply.

## Development workflow

There is no build step, no package manager, and no test suite. Iteration is "edit → reinstall into GNOME extensions directory → restart Shell".

The `./update` script handles install + Shell restart:

```bash
./update   # rm -rf the installed copy, cp this repo into ~/.local/share/gnome-shell/extensions/claude-code-usage@haletran.com, compile schemas, run `gnome-session-quit --no-prompt` (LOGS YOU OUT)
```

The logout is required because GNOME Shell on Wayland cannot be restarted in-place. On X11, `Alt+F2` → `r` works instead and avoids the logout.

To compile the GSettings schema manually after editing `schemas/*.gschema.xml`:

```bash
glib-compile-schemas schemas/
```

To watch logs while debugging:

```bash
journalctl -f /usr/bin/gnome-shell        # main extension (extension.js)
journalctl -f -o cat /usr/bin/gjs         # preferences window (prefs.js runs in a separate gjs process)
```

## Architecture

Two entry points, loaded by GNOME Shell at different times and in different processes:

- **`extension.js`** — runs inside `gnome-shell`. Exports a default class with `enable()`/`disable()`. `enable()` instantiates `ClaudeUsageIndicator` (a `PanelMenu.Button`) and adds it to `Main.panel`. `disable()` must tear everything down: stop the GLib timer, abort the Soup session, disconnect the settings signal — leaks here survive `disable()` and break extension reload.
- **`prefs.js`** — runs in a separate `gjs` process when the user opens preferences. Uses Adw/Gtk widgets, not St. It cannot share state with `extension.js`; the two communicate only through GSettings.

Data flow inside `extension.js`:

1. `_refreshUsage()` reads the OAuth access token from `$CLAUDE_CONFIG_DIR/.credentials.json` (defaults to `~/.claude/.credentials.json`) via async `Gio.File.load_contents_async`.
2. `_fetchUsage(token)` does `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer …` and `anthropic-beta: oauth-2025-04-20` headers, via `Soup.Session`.
3. Response shape is `{ five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }`. `_updateDisplay` renders percentages, colored progress bars (low/medium/high/critical thresholds at 40/70/90), and humanized reset times.
4. A `GLib.timeout_add_seconds` timer re-runs `_refreshUsage` every `refresh-interval` seconds.

The Soup session is recreated (not just reconfigured) when `proxy-url` changes, because `Gio.SimpleProxyResolver` is set at session construction. The settings `changed` handler dispatches per-key: only `refresh-interval` restarts the timer; `proxy-url` recreates the session; the rest just update widgets.

## Settings (GSettings)

Schema `org.gnome.shell.extensions.claude-code-usage` in `schemas/org.gnome.shell.extensions.claude-code-usage.gschema.xml`. Keys: `refresh-interval` (i, seconds), `display-mode` (s: `text`|`bar`|`both`), `icon-style` (s: `color`|`monochrome`), `show-icon` (b), `proxy-url` (s). When adding a key:

1. Add it to the gschema.xml with a `<default>`.
2. Recompile schemas (`glib-compile-schemas schemas/`) — the *binary* `gschemas.compiled` is what GNOME reads at runtime, and `.gitignore` excludes it, so it must be regenerated after every schema change.
3. Add a row in `prefs.js`.
4. If `extension.js` should react live, add a branch to the `_settings.connect('changed', …)` dispatcher — otherwise the change only takes effect on next reload.

## Conventions specific to this codebase

- Use `gi://` imports, not npm packages. Available namespaces are whatever ships with the host's GJS — primarily `GLib`, `Gio`, `GObject`, `St`, `Clutter`, `Soup` in `extension.js`, and `Adw`, `Gtk`, `Gio` in `prefs.js`.
- GObject subclasses must go through `GObject.registerClass(...)` and use `_init` instead of `constructor`. See `ClaudeUsageIndicator`.
- Icon style "monochrome" is implemented as Clutter effects (`DesaturateEffect` + `BrightnessContrastEffect`) layered on the `St.Icon`, named so they can be removed when toggling back to color — don't replace this with separate icon files.
- `metadata.json` lists supported `shell-version`s; bump when verified against a new GNOME release. `version` is the extensions.gnome.org submission number and must increment for every store upload.
