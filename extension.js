import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Peak hours: weekdays 13:00–19:00 UTC. Logic mirrored from
// github.com/imajus/promoclock src/app/api/status/route.ts so we can compute
// it locally without a network call.
const PEAK_START_UTC = 13;
const PEAK_END_UTC = 19;

function _peakNextChange(now, dayUTC, hourUTC, isPeak, isWeekend) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const date = now.getUTCDate();
    if (isWeekend) {
        const daysToMonday = dayUTC === 6 ? 2 : 1;
        return new Date(Date.UTC(year, month, date + daysToMonday, PEAK_START_UTC, 0, 0));
    }
    if (isPeak)
        return new Date(Date.UTC(year, month, date, PEAK_END_UTC, 0, 0));
    if (hourUTC < PEAK_START_UTC)
        return new Date(Date.UTC(year, month, date, PEAK_START_UTC, 0, 0));
    const tomorrowDay = (dayUTC + 1) % 7;
    if (tomorrowDay === 6) return new Date(Date.UTC(year, month, date + 3, PEAK_START_UTC, 0, 0));
    if (tomorrowDay === 0) return new Date(Date.UTC(year, month, date + 2, PEAK_START_UTC, 0, 0));
    return new Date(Date.UTC(year, month, date + 1, PEAK_START_UTC, 0, 0));
}

function _peakPrevChange(now, dayUTC, hourUTC, isPeak, isWeekend) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const date = now.getUTCDate();
    if (isPeak)
        return new Date(Date.UTC(year, month, date, PEAK_START_UTC, 0, 0));
    if (isWeekend) {
        // dayUTC: 6 = Saturday, 0 = Sunday. Off-peak began at Friday 19:00 UTC.
        const daysBackToFriday = dayUTC === 6 ? 1 : 2;
        return new Date(Date.UTC(year, month, date - daysBackToFriday, PEAK_END_UTC, 0, 0));
    }
    if (hourUTC < PEAK_START_UTC) {
        // Weekday morning before peak. Off-peak began at the previous weekday's 19:00 UTC.
        // dayUTC 1 (Mon) → Fri (−3 days); otherwise yesterday.
        const daysBack = dayUTC === 1 ? 3 : 1;
        return new Date(Date.UTC(year, month, date - daysBack, PEAK_END_UTC, 0, 0));
    }
    // Weekday evening after peak: off-peak began today at 19:00 UTC.
    return new Date(Date.UTC(year, month, date, PEAK_END_UTC, 0, 0));
}

function _computePeakStatus(now) {
    const dayUTC = now.getUTCDay();
    const hourUTC = now.getUTCHours();
    const isWeekend = dayUTC === 0 || dayUTC === 6;
    const isPeak = !isWeekend && hourUTC >= PEAK_START_UTC && hourUTC < PEAK_END_UTC;
    const nextChange = _peakNextChange(now, dayUTC, hourUTC, isPeak, isWeekend);
    const prevChange = _peakPrevChange(now, dayUTC, hourUTC, isPeak, isWeekend);
    return {
        isPeak,
        label: isPeak ? 'Peak — Drains Faster' : 'Off-Peak — Normal',
        prevChange,
        nextChange,
        minutesUntilChange: Math.floor((nextChange.getTime() - now.getTime()) / 60000),
    };
}

const PER_MODEL_LABEL_MAP = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    oauth_apps: 'OAuth Apps',
    omelette: 'Claude Design',
};

function _formatPerModelLabel(suffix) {
    if (PER_MODEL_LABEL_MAP[suffix])
        return PER_MODEL_LABEL_MAP[suffix];
    return suffix
        .split('_')
        .map(w => w.length === 0 ? w : w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']);
        this._originalGicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: this._originalGicon,
            style_class: 'claude-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._relayoutProgressBars();
                    return GLib.SOURCE_REMOVE;
                });
                if (this._settings.get_boolean('show-peak-hours'))
                    this._updatePeakDisplay();
            }
        });

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'show-per-model-weekly') {
                this._updatePerModelVisibility();
            } else if (key === 'show-peak-hours') {
                this._updatePeakVisibility();
            }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
        this._refreshUsage();
	}
    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _createMenu() {
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            style_class: 'popup-menu-icon',
            icon_size: 16,
        });
        refreshItem.insert_child_at_index(this._refreshIcon, 0);
        refreshItem.connect('activate', () => {
            this._pendingRefreshFeedback = true;
            this._refreshUsage();
        });
        this.menu.addMenuItem(refreshItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'claude-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
            x_expand: true,
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'claude-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
            x_expand: true,
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this._peakSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._peakSeparator);

        const peakBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const peakHeader = new St.BoxLayout({ vertical: false });
        const peakTitleLabel = new St.Label({
            text: 'Peak Hours',
            style_class: 'claude-section-title',
        });
        peakHeader.add_child(peakTitleLabel);
        this._peakStatusLabel = new St.Label({
            text: '…',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        peakHeader.add_child(this._peakStatusLabel);
        peakBox.add_child(peakHeader);

        const peakProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
            x_expand: true,
        });
        this._peakProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        peakProgressBg.add_child(this._peakProgressBar);
        peakBox.add_child(peakProgressBg);

        this._peakChangeLabel = new St.Label({
            text: '…',
            style_class: 'claude-reset-label',
        });
        peakBox.add_child(this._peakChangeLabel);

        this._peakMenuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._peakMenuItem.add_child(peakBox);
        this.menu.addMenuItem(this._peakMenuItem);

        this._updatePeakVisibility();

        this._perModelSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._perModelSeparator);

        this._perModelContainer = new St.BoxLayout({
            style_class: 'claude-per-model-container',
            vertical: true,
        });
        this._perModelMenuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._perModelMenuItem.add_child(this._perModelContainer);
        this.menu.addMenuItem(this._perModelMenuItem);

        this._perModelMenuItem.visible = false;
        this._perModelSeparator.visible = false;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        const settingsIcon = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            style_class: 'popup-menu-icon',
            icon_size: 16,
        });
        settingsItem.insert_child_at_index(settingsIcon, 0);
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _setErrorState(msg) {
        this._label.set_text('Error');
        this._fiveHourPercent.set_text(msg);
    }

    _refreshUsage() {
        if (this._settings.get_boolean('show-peak-hours'))
            this._updatePeakDisplay();
        if (this._fetching) return;
        this._fetching = true;
        const ownToken = this._settings.get_string('access-token');
        if (ownToken) {
            const expiresAt = this._settings.get_int64('expires-at');
            if (Date.now() >= expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
                this._refreshOwnToken();
            } else {
                this._fetchUsage(ownToken);
            }
        } else {
            this._loadCredentialsAndFetch();
        }
    }

    _refreshOwnToken() {
        const refreshToken = this._settings.get_string('refresh-token');
        if (!refreshToken) {
            this._fetching = false;
            this._setErrorState('Not connected');
            return;
        }

        const body = [
            'grant_type=refresh_token',
            `refresh_token=${encodeURIComponent(refreshToken)}`,
            `client_id=${CLIENT_ID}`,
        ].join('&');

        const message = Soup.Message.new('POST', TOKEN_URL);
        message.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
        message.set_request_body_from_bytes(
            null,
            new GLib.Bytes(new TextEncoder().encode(body))
        );

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.status_code !== 200) {
                    this._fetching = false;
                    this._setErrorState('Auth expired');
                    return;
                }
                const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._settings.set_string('access-token', resp.access_token);
                this._settings.set_string('refresh-token', resp.refresh_token);
                this._settings.set_int64('expires-at', Date.now() + (resp.expires_in ?? 28800) * 1000);
                this._fetchUsage(resp.access_token);
            } catch (e) {
                console.error('Claude Usage: Token refresh failed:', e.message);
                this._fetching = false;
                this._setErrorState('Error');
            }
        });
    }

    _loadCredentialsAndFetch() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(null, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._fetching = false;
                    this._label.set_text('No token');
                    this._fiveHourPercent.set_text('No credentials');
                    this._sevenDayPercent.set_text('—');
                    return;
                }

                this._fetchUsage(token);
            } catch (e) {
                console.error('Claude Usage: Failed to read credentials:', e.message);
                this._fetching = false;
                this._label.set_text('No token');
                this._fiveHourPercent.set_text('No credentials');
                this._sevenDayPercent.set_text('—');
            }
        });
    }

    _fetchUsage(token) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code === 429) {
                        this._fetching = false;
                        return; // rate limited — keep last known data
                    }
                    if (message.status_code !== 200) {
                        this._fetching = false;
                        this._setErrorState(`HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateDisplay(data);
                    this._fetching = false;
                } catch (e) {
                    console.error('Claude Usage: Failed to fetch usage:', e.message);
                    this._fetching = false;
                    this._setErrorState('Error');
                }
            }
        );
    }

    _updateDisplay(data) {
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;
        this._lastFiveHour = fiveHour;
        this._lastSevenDay = sevenDay;
        this._lastUsageData = data;

        this._label.set_text(`${Math.round(fiveHour)}%`);

        this._updatePanelProgressBar(fiveHour);

        this._fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour);

        this._sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay);

        if (data.five_hour?.resets_at) {
            this._fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (data.seven_day?.resets_at) {
            this._sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }

        this._renderPerModelSections(data);

        if (this._pendingRefreshFeedback) {
            this._pendingRefreshFeedback = false;
            this._showRefreshSuccess();
        }
    }

    _relayoutProgressBars() {
        if (this._lastFiveHour != null)
            this._updateProgressBar(this._fiveHourProgressBar, this._lastFiveHour);
        if (this._lastSevenDay != null)
            this._updateProgressBar(this._sevenDayProgressBar, this._lastSevenDay);
        if (this._settings.get_boolean('show-peak-hours'))
            this._updatePeakDisplay();
        if (this._lastUsageData)
            this._renderPerModelSections(this._lastUsageData);
    }

    _renderPerModelSections(data) {
        this._perModelEntries = Object.keys(data)
            .filter(k => k.startsWith('seven_day_') && k !== 'seven_day' && data[k] !== null)
            .map(k => ({suffix: k.replace(/^seven_day_/, ''), entry: data[k]}));

        this._perModelContainer.destroy_all_children();

        this._perModelEntries.forEach(({suffix, entry}, idx) => {
            const sectionBox = new St.BoxLayout({
                style_class: 'claude-usage-section',
                vertical: true,
            });
            if (idx > 0)
                sectionBox.set_style('margin-top: 8px;');

            const header = new St.BoxLayout({vertical: false});
            const titleLabel = new St.Label({
                text: `${_formatPerModelLabel(suffix)} (7-Day)`,
                style_class: 'claude-section-title',
            });
            header.add_child(titleLabel);
            const percentLabel = new St.Label({
                text: `${(entry.utilization ?? 0).toFixed(1)}%`,
                style_class: 'claude-percent-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            header.add_child(percentLabel);
            sectionBox.add_child(header);

            const progressBg = new St.Widget({style_class: 'claude-progress-bg', x_expand: true});
            const progressBar = new St.Widget({style_class: 'claude-progress-bar'});
            progressBg.add_child(progressBar);
            sectionBox.add_child(progressBg);
            this._updateProgressBar(progressBar, entry.utilization ?? 0);

            const resetLabel = new St.Label({
                text: entry.resets_at
                    ? `Resets in ${this._formatResetTime(entry.resets_at)}`
                    : 'Not used yet',
                style_class: 'claude-reset-label',
            });
            sectionBox.add_child(resetLabel);

            this._perModelContainer.add_child(sectionBox);
        });

        this._updatePerModelVisibility();
    }

    _updatePerModelVisibility() {
        const showSetting = this._settings.get_boolean('show-per-model-weekly');
        const hasEntries = this._perModelEntries && this._perModelEntries.length > 0;
        const visible = showSetting && hasEntries;
        this._perModelMenuItem.visible = visible;
        this._perModelSeparator.visible = visible;
    }

    _showRefreshSuccess() {
        this._refreshIcon.set_icon_name('emblem-ok-symbolic');

        this._icon.set_gicon(null);
        this._icon.set_icon_name('view-refresh-symbolic');
        this._icon.add_style_class_name('claude-success-flash');
        this._label.add_style_class_name('claude-success-flash');

        this._refreshFeedbackTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => {
                this._refreshIcon.set_icon_name('view-refresh-symbolic');

                this._icon.set_icon_name('');
                this._icon.set_gicon(this._originalGicon);
                this._icon.remove_style_class_name('claude-success-flash');
                this._label.remove_style_class_name('claude-success-flash');

                this._refreshFeedbackTimer = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _updatePanelProgressBar(usage) {
        const parent = this._panelProgressBar.get_parent();
        const maxWidth = parent && parent.get_width() > 0 ? parent.get_width() : 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _progressTrackWidth(progressBar) {
        const parent = progressBar?.get_parent();
        if (!parent)
            return 0;
        const allocated = parent.get_width();
        if (allocated > 0)
            return allocated;
        try {
            const box = parent.get_allocation_box();
            const w = Math.round(box.x2 - box.x1);
            if (w > 0)
                return w;
        } catch (_e) {}
        return 0;
    }

    _updateProgressBar(progressBar, usage) {
        const trackWidth = this._progressTrackWidth(progressBar);
        const maxWidth = trackWidth > 0 ? trackWidth : 200;
        const clampedUsage = Math.min(100, Math.max(0, usage));
        const width = Math.round((clampedUsage / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _updatePeakVisibility() {
        const visible = this._settings.get_boolean('show-peak-hours');
        this._peakMenuItem.visible = visible;
        this._peakSeparator.visible = visible;
        if (visible)
            this._updatePeakDisplay();
    }

    _updatePeakDisplay() {
        const now = new Date();
        const status = _computePeakStatus(now);

        this._peakStatusLabel.set_text(status.label);

        let progress = 0;
        if (status.nextChange > status.prevChange) {
            progress = ((now - status.prevChange) / (status.nextChange - status.prevChange)) * 100;
            progress = Math.min(100, Math.max(0, progress));
        }

        const maxWidth = this._progressTrackWidth(this._peakProgressBar) || 200;
        const peakWidth = Math.round((progress / 100) * maxWidth);
        this._peakProgressBar.set_width(peakWidth);

        this._peakProgressBar.remove_style_class_name('usage-low');
        this._peakProgressBar.remove_style_class_name('usage-medium');
        this._peakProgressBar.remove_style_class_name('usage-high');
        this._peakProgressBar.remove_style_class_name('usage-critical');
        this._peakProgressBar.add_style_class_name(status.isPeak ? 'usage-high' : 'usage-low');

        const nextLabel = status.isPeak ? 'Off-Peak' : 'Peak';
        this._peakChangeLabel.set_text(
            `Switches to ${nextLabel} in ${this._formatMinutes(status.minutesUntilChange)}`
        );
    }

    _formatMinutes(totalMinutes) {
        const mins = Math.max(0, Math.round(totalMinutes));
        const days = Math.floor(mins / 1440);
        const hours = Math.floor((mins % 1440) / 60);
        const minutes = mins % 60;
        if (days > 0)
            return `${days}d ${hours}h`;
        if (hours > 0)
            return `${hours}h ${minutes}m`;
        return `${minutes}m`;
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '—';
        }
    }

    destroy() {
        if (this._refreshFeedbackTimer) {
            GLib.source_remove(this._refreshFeedbackTimer);
            this._refreshFeedbackTimer = null;
        }
        this._stopTimer();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._menuOpenChangedId) {
            this.menu.disconnect(this._menuOpenChangedId);
            this._menuOpenChangedId = null;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
