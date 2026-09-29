import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class PrayerTimesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Genel',
            icon_name: 'alarm-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Ayarlar',
            description: 'Namaz vakitleri ve görünüm tercihlerini yapılandırın.',
        });
        page.add(group);

        // Konum Seçimi
        const locationModel = new Gtk.StringList();
        locationModel.append('Konya • Selçuklu');
        locationModel.append('İstanbul • Ümraniye');

        const locationKeys = ['selcuklu', 'umraniye'];
        const currentLoc = settings.get_string('location');
        const selectedIdx = Math.max(0, locationKeys.indexOf(currentLoc));

        const locationRow = new Adw.ComboRow({
            title: 'Konum',
            subtitle: 'Vakitleri gösterilecek il/ilçe',
            model: locationModel,
            selected: selectedIdx,
        });

        locationRow.connect('notify::selected', () => {
            const key = locationKeys[locationRow.selected];
            if (key)
                settings.set_string('location', key);
        });
        group.add(locationRow);

        // Panelde Etiketi Göster
        const labelRow = new Adw.SwitchRow({
            title: 'Panelde Vakit Adını Göster',
            subtitle: 'Geri sayımın yanında vakit adını görüntüler',
        });
        settings.bind('show-label', labelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(labelRow);

        // Bildirimler
        const notifyRow = new Adw.SwitchRow({
            title: 'Vakit Bildirimleri',
            subtitle: 'Namaz vakti girdiğinde masaüstü bildirimi gönderir',
        });
        settings.bind('notifications', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(notifyRow);

        // Senkronizasyon Grubu
        const syncGroup = new Adw.PreferencesGroup({
            title: 'Veri Eşitleme',
            description: 'Uzak GitHub deposundan vakitleri yeniden çek',
        });
        page.add(syncGroup);

        const syncActionRow = new Adw.ActionRow({
            title: 'Şimdi Eşitle',
            subtitle: 'En güncel 30 günlük veriyi GitHub deposundan hemen indirir',
        });

        const syncButton = new Gtk.Button({
            label: 'Eşitle',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        syncButton.connect('clicked', () => {
            settings.set_int64('refresh-request', GLib.get_real_time());
        });

        syncActionRow.add_suffix(syncButton);
        syncGroup.add(syncActionRow);
    }
}
