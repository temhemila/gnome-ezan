import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/temhemila/gnome-ezan/main/data/prayer-times.json';

const REQUIRED_LOCATIONS = ['selcuklu', 'umraniye'];
const MIN_WINDOW_DAYS = 30;

const PRAYERS = [
    ['imsak', 'İmsak'],
    ['gunes', 'Güneş'],
    ['ogle', 'Öğle'],
    ['ikindi', 'İkindi'],
    ['aksam', 'Akşam'],
    ['yatsi', 'Yatsı'],
];

const LOCATION_LABELS = {
    selcuklu: 'Konya • Selçuklu',
    umraniye: 'İstanbul • Ümraniye',
};

const REFRESH_INTERVAL_SECONDS = 12 * 60 * 60;
const REFRESH_MIN_AGE_SECONDS = 24 * 60 * 60;

function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseTime(date, value) {
    const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
    if (!match)
        return null;

    const result = new Date(date);
    result.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return result;
}

function formatCountdown(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function isValidIncomingData(data) {
    if (!data || data.schema !== 3)
        return false;

    if (!Number.isInteger(data.window_days) || data.window_days < MIN_WINDOW_DAYS)
        return false;

    if (!data.locations || typeof data.locations !== 'object' || Array.isArray(data.locations))
        return false;

    const requiredWindow = data.window_days;
    const today = new Date();

    for (const locationKey of REQUIRED_LOCATIONS) {
        const location = data.locations[locationKey];
        if (!location?.days || typeof location.days !== 'object' || Array.isArray(location.days))
            return false;

        const days = location.days;

        if (Object.keys(days).length < requiredWindow)
            return false;

        for (let offset = 0; offset < requiredWindow; offset++) {
            const date = new Date(today);
            date.setDate(date.getDate() + offset);

            const key = dateKey(date);
            const day = days[key];
            if (!day)
                return false;

            const times = [];
            for (const [prayer] of PRAYERS) {
                const val = day[prayer];
                if (!/^\d{2}:\d{2}$/.test(val ?? ''))
                    return false;

                const [h, m] = val.split(':').map(Number);
                if (h > 23 || m > 59)
                    return false;
                times.push(h * 60 + m);
            }

            if (!times.every((val, idx) => idx === 0 || times[idx - 1] < val))
                return false;
        }
    }

    return true;
}

function loadFileAsync(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, res) => {
            try {
                const [ok, bytes] = source.load_contents_finish(res);
                if (!ok)
                    reject(new Error('Dosya okunamadı'));
                else
                    resolve(bytes);
            } catch (err) {
                reject(err);
            }
        });
    });
}

function saveFileAsync(file, contentString) {
    return new Promise((resolve, reject) => {
        const bytes = new GLib.Bytes(new TextEncoder().encode(contentString));
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (source, res) => {
                try {
                    const [ok] = source.replace_contents_finish(res);
                    resolve(ok);
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

const PrayerIndicator = GObject.registerClass(
class PrayerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'GNOME Ezan Vakitleri');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._data = extension.data;
        this._timer = null;
        this._currentKey = null;
        this._timings = null;
        this._lastNotified = null;

        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            text: 'Ezan',
        });
        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._signalIds = [
            this._settings.connect('changed::location', () => {
                this._currentKey = null;
                this._timings = null;
                this._load();
                this._buildMenu();
            }),
            this._settings.connect('changed::show-label', () => this._update()),
            this._settings.connect('changed::notifications', () => this._update()),
        ];

        this._menuSignalId = this.menu.connect('open-state-changed', (m, open) => {
            if (open)
                this._buildMenu();
        });

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._load();
            this._update();
            return GLib.SOURCE_CONTINUE;
        });

        this._load();
        this._update();
    }

    setData(data) {
        this._data = data;
        this._currentKey = null;
        this._timings = null;
        this._load();
        this._update();
        this._buildMenu();
    }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        if (this._menuSignalId) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = null;
        }
        if (this._signalIds) {
            for (const id of this._signalIds)
                this._settings.disconnect(id);
            this._signalIds = null;
        }
        super.destroy();
    }

    _load() {
        const now = new Date();
        const key = dateKey(now);
        if (key === this._currentKey && this._timings)
            return;

        this._currentKey = key;
        const location = this._settings.get_string('location');
        this._timings = this._data?.locations?.[location]?.days?.[key] ?? null;
        this._buildMenu();
    }

    _nextPrayer() {
        if (!this._timings)
            return null;

        const now = new Date();
        for (const [key, label] of PRAYERS) {
            const when = parseTime(now, this._timings[key]);
            if (when && when > now)
                return {key, label, when, time: this._timings[key], tomorrow: false};
        }

        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowKey = dateKey(tomorrow);
        const location = this._settings.get_string('location');
        const tomorrowTimings = this._data?.locations?.[location]?.days?.[tomorrowKey];
        const when = tomorrowTimings?.imsak ? parseTime(tomorrow, tomorrowTimings.imsak) : null;
        if (when)
            return {key: 'imsak', label: 'İmsak', when, time: tomorrowTimings.imsak, tomorrow: true};

        return null;
    }

    _update() {
        const next = this._nextPrayer();
        const showLabel = this._settings.get_boolean('show-label');

        if (!this._timings) {
            const statusText = this._data ? 'Veri yok' : 'Yükleniyor...';
            this._label.text = showLabel ? statusText : '';
            return;
        }

        if (!next) {
            this._label.text = showLabel ? 'Hesaplanıyor' : '';
            return;
        }

        const prefix = next.label;
        const countdown = formatCountdown(next.when.getTime() - Date.now());
        this._label.text = showLabel ? `${prefix} ${countdown}` : countdown;

        this._checkNotification();
    }

    _checkNotification() {
        if (!this._settings.get_boolean('notifications') || !this._timings)
            return;

        const now = new Date();
        for (const [key, label] of PRAYERS) {
            if (key === 'gunes')
                continue;

            const when = parseTime(now, this._timings[key]);
            if (!when)
                continue;

            const nowMs = Date.now();
            const prayerMs = when.getTime();
            const location = this._settings.get_string('location');
            const notificationKey = `${location}-${this._currentKey}-${key}`;

            if (
                nowMs >= prayerMs &&
                nowMs - prayerMs <= 90_000 &&
                this._lastNotified !== notificationKey
            ) {
                this._lastNotified = notificationKey;
                Main.notify('GNOME Ezan Vakitleri', `${label} vakti girdi • ${this._timings[key]}`);
            }
        }
    }

    _buildMenu() {
        if (!this.menu)
            return;

        this.menu.removeAll();

        const location = this._settings.get_string('location');
        const locationLabel = LOCATION_LABELS[location] ?? location;

        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const titleLabel = new St.Label({
            text: locationLabel,
            style: 'font-weight: bold; font-size: 13.5px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        headerItem.add_child(titleLabel);

        const settingsButton = new St.Button({
            can_focus: true,
            reactive: true,
            style_class: 'button icon-button',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'emblem-system-symbolic',
                icon_size: 14,
            }),
        });

        settingsButton.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });

        headerItem.add_child(settingsButton);
        this.menu.addMenuItem(headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._timings) {
            const next = this._nextPrayer();
            for (const [key, label] of PRAYERS) {
                const isNext = next && !next.tomorrow && next.key === key;
                const item = new PopupMenu.PopupMenuItem(label, {reactive: false});
                item.label.x_expand = true;

                const timeLabel = new St.Label({
                    text: this._timings[key] ?? '—',
                    y_align: Clutter.ActorAlign.CENTER,
                });

                if (isNext) {
                    item.label.style = 'font-weight: bold;';
                    timeLabel.style = 'font-weight: bold;';
                }

                item.add_child(timeLabel);
                this.menu.addMenuItem(item);
            }
        } else {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'Bu tarih için yerel veri yok.',
                {reactive: false},
            ));
        }

        if (this._extension.syncStatus) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const statusItem = new PopupMenu.PopupMenuItem(this._extension.syncStatus, {reactive: false});
            statusItem.label.style = 'font-size: 11px; opacity: 0.65;';
            this.menu.addMenuItem(statusItem);
        }
    }
});

export default class PrayerTimesExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._refreshInFlight = false;
        this._dataReady = false;
        this._forceRefreshPending = false;
        this._lastSyncEpoch = 0;
        this.data = null;
        this.syncStatus = 'Yükleniyor...';

        this._settings = this.getSettings();
        this._refreshRequestId = this._settings.connect('changed::refresh-request', () => {
            this.refreshNow();
        });
        this._settings.get_int64('refresh-request');

        this._session = new Soup.Session();
        this._session.timeout = 20;

        this._indicator = new PrayerIndicator(this);
        Main.panel.addToStatusArea('prayer-times', this._indicator, 0, 'right');

        this._initDataAsync();

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect('network-changed', () => {
            if (this._indicator && this._dataReady)
                this._maybeRefresh(false);
        });

        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
            this._maybeRefresh(false);
            return GLib.SOURCE_CONTINUE;
        });

        this._startupTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._startupTimer = null;
            this._maybeRefresh(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    refreshNow() {
        this._forceRefreshPending = true;
        this._maybeRefresh(true);
    }

    disable() {
        this._generation = (this._generation ?? 0) + 1;
        this._refreshInFlight = false;
        this._dataReady = false;
        this._forceRefreshPending = false;

        if (this._startupTimer) {
            GLib.Source.remove(this._startupTimer);
            this._startupTimer = null;
        }
        if (this._refreshTimer) {
            GLib.Source.remove(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._networkMonitor && this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = null;
        }
        this._networkMonitor = null;

        if (this._settings && this._refreshRequestId) {
            this._settings.disconnect(this._refreshRequestId);
            this._refreshRequestId = null;
        }
        this._settings = null;

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this.data = null;
    }

    _cachePath() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-ezan']);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, 'prayer-times.json']);
    }

    async _initDataAsync() {
        const generation = this._generation;

        try {
            // 1. Paket içi statik snapshot'ı oku (Fallback #1)
            const bundledPath = GLib.build_filenamev([this.path, 'data', 'prayer-times.json']);
            const bundledBytes = await loadFileAsync(Gio.File.new_for_path(bundledPath));

            if (generation !== this._generation)
                return;

            let data = JSON.parse(new TextDecoder('utf-8').decode(bundledBytes));
            if (!isValidIncomingData(data))
                throw new Error('Paket içi bundled veri şemadan geçemedi');

            // 2. Diskteki cache'i oku (Fallback #2)
            const cacheFile = Gio.File.new_for_path(this._cachePath());
            if (cacheFile.query_exists(null)) {
                try {
                    const cacheBytes = await loadFileAsync(cacheFile);
                    if (generation !== this._generation)
                        return;

                    const cached = JSON.parse(new TextDecoder('utf-8').decode(cacheBytes));
                    if (isValidIncomingData(cached?.data)) {
                        data = cached.data;
                        const epoch = Number(cached?.updated_at ?? 0);
                        const nowEpoch = Math.floor(Date.now() / 1000);
                        this._lastSyncEpoch = (epoch > 0 && epoch <= nowEpoch) ? epoch : 0;
                    }
                } catch (e) {
                    console.error('GNOME Ezan: Cache okuma hatası', e);
                }
            }

            if (generation !== this._generation)
                return;

            this.data = data;
            this._dataReady = true;
            this.syncStatus = this._formatSyncStatus();
            this._indicator?.setData(this.data);

            if (this._forceRefreshPending)
                this._maybeRefresh(true);
        } catch (error) {
            console.error('GNOME Ezan: Başlangıç verisi yüklenemedi', error);
        }
    }

    _queueCacheSave(data) {
        const generation = this._generation;
        const previous = this._cacheWritePromise ?? Promise.resolve();

        const current = previous
            .then(() => {
                if (generation !== this._generation)
                    return null;
                return this._saveCacheAsync(data);
            })
            .catch(error => {
                console.error('GNOME Ezan: Cache yazma hatası', error);
            });

        this._cacheWritePromise = current;

        current.finally(() => {
            if (this._cacheWritePromise === current)
                this._cacheWritePromise = null;
        });

        return current;
    }

    async _saveCacheAsync(data) {
        const payload = JSON.stringify({
            updated_at: Math.floor(Date.now() / 1000),
            data,
        });
        const cacheFile = Gio.File.new_for_path(this._cachePath());
        await saveFileAsync(cacheFile, payload);
    }

    _formatSyncStatus() {
        if (!this._lastSyncEpoch)
            return 'Yerel veri devrede';

        try {
            return `Son başarılı eşitleme: ${new Date(this._lastSyncEpoch * 1000).toLocaleString('tr-TR')}`;
        } catch {
            return `Son başarılı eşitleme: ${new Date(this._lastSyncEpoch * 1000).toISOString()}`;
        }
    }

    _maybeRefresh(force = false) {
        if (this._refreshInFlight || !this._dataReady)
            return;
        if (!this._networkMonitor?.get_network_available())
            return;

        const requestedForce = force || this._forceRefreshPending;
        const now = Math.floor(Date.now() / 1000);

        if (!requestedForce && this._lastSyncEpoch && now - this._lastSyncEpoch < REFRESH_MIN_AGE_SECONDS)
            return;

        this._forceRefreshPending = false;
        this._fetchFromGitHub();
    }

    _fetchFromGitHub() {
        if (!this._session)
            return;

        this._refreshInFlight = true;
        const generation = this._generation;

        const message = Soup.Message.new('GET', GITHUB_RAW_URL);
        message.request_headers.append('User-Agent', 'gnome-ezan-extension/1.0');

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            if (generation !== this._generation)
                return;

            this._refreshInFlight = false;

            try {
                const bytes = session.send_and_read_finish(result);
                const status = message.get_status();
                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);

                const raw = bytes?.get_data ? bytes.get_data() : bytes;
                const jsonText = new TextDecoder('utf-8').decode(raw);
                const incoming = JSON.parse(jsonText);

                if (!isValidIncomingData(incoming))
                    throw new Error('İndirilen JSON şema kontrolünden geçemedi');

                this.data = incoming;
                this._lastSyncEpoch = Math.floor(Date.now() / 1000);
                this._queueCacheSave(this.data);
                this.syncStatus = this._formatSyncStatus();
                this._indicator?.setData(this.data);
            } catch (error) {
                console.error('GNOME Ezan: Uzak veri güncellemesi başarısız, mevcut veri korunuyor:', error);
            }

            if (this._forceRefreshPending)
                this._maybeRefresh(true);
        });
    }
}
