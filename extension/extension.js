import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {backendArguments, parseTasks, taskPresentation, RefreshController, visibleTasks, hideTask} from './model.js';

export default class LogseqHudDo extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new PanelMenu.Button(0.0, 'Logseq HUD->Do');
        const panel = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        panel.add_child(new St.Icon({icon_name: 'checkbox-checked-symbolic', style_class: 'system-status-icon'}));
        this._count = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER});
        panel.add_child(this._count);
        this._indicator.add_child(panel);
        this._message = new PopupMenu.PopupMenuItem('Loading tasks…', {reactive: false});
        this._indicator.menu.addMenuItem(this._message);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: true, can_focus: false, hover: false, activate: false});
        item.track_hover = false;
        const scroll = new St.ScrollView({style_class: 'hud-scroll', overlay_scrollbars: true});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._rows = this._verticalBox();
        scroll.set_child(this._rows);
        item.add_child(scroll);
        this._indicator.menu.addMenuItem(item);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction('Refresh', () => this._controller.refresh());
        this._indicator.menu.addAction('Preferences', () => this.openPreferences());
        this._controller = new RefreshController(() => this._runBackend(), data => {
            this._data = data;
            this._render();
        }, message => {
            this._data = null;
            this._rows.destroy_all_children();
            this._count.text = '';
            this._showMessage(message);
        });
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._controller.refresh();
        });
        this._settingsSignal = this._settings.connect('changed', (_settings, key) => {
            if (key === 'hidden-tasks-v2' || key === 'show-today-unscheduled') {
                this._render();
                return;
            }
            this._render();
            this._schedule();
            this._controller.refresh(true);
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._schedule();
        this._controller.refresh();
    }

    _verticalBox() {
        // St's vertical property was replaced by orientation in Shell 48.
        return new St.BoxLayout({x_expand: true,
            ...('orientation' in St.BoxLayout.prototype
                ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true})});
    }

    _showMessage(message) {
        this._message.label.text = message;
        this._message.label.clutter_text.line_wrap = true;
        this._message.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._message.show();
    }

    _schedule() {
        this._removeTimers();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._controller.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        const now = GLib.DateTime.new_now_local();
        const midnight = now.add_days(1);
        const next = GLib.DateTime.new_local(midnight.get_year(), midnight.get_month(), midnight.get_day_of_month(), 0, 0, 0);
        this._midnight = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(next.difference(now) / 1000000)), () => {
                this._midnight = 0;
                this._schedule();
                this._controller.refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _removeTimers() {
        for (const key of ['_timer', '_midnight']) {
            if (this[key])
                GLib.Source.remove(this[key]);
            this[key] = 0;
        }
    }

    _runBackend() {
        const {args, directory} = backendArguments(this.path,
            this._settings.get_value('graphs').deep_unpack(), this._settings.get_int('horizon'));
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
        launcher.set_cwd(directory);
        launcher.setenv('PYTHONPATH', directory, true);
        const process = launcher.spawnv(args);
        this._process = process;
        this._cancellable = new Gio.Cancellable();
        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(null, this._cancellable, (source, result) => {
                if (this._process === process)
                    this._process = null;
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (!source.get_successful()) {
                        let message = stderr.trim();
                        try { message = JSON.parse(stderr).error; } catch (_error) { /* argparse emits plain text. */ }
                        throw new Error(message || 'Backend failed.');
                    }
                    resolve(parseTasks(stdout));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _render() {
        if (!this._data)
            return;
        const data = visibleTasks(this._data, this._settings);
        const scheduledToday = data.today.filter(task => task.scheduled !== null);
        const unscheduledToday = this._settings.get_boolean('show-today-unscheduled')
            ? data.today.filter(task => task.scheduled === null) : [];
        this._message.hide();
        this._count.text = this._settings.get_boolean('show-today-count')
            ? String(scheduledToday.length + unscheduledToday.length) : '';
        this._rows.destroy_all_children();
        for (const [title, tasks, enabled] of [
            ['Today', scheduledToday, true],
            ['Today — Unscheduled', unscheduledToday, true],
            ['Overdue', data.overdue, this._settings.get_boolean('show-overdue')],
            ['Upcoming', data.upcoming, this._settings.get_boolean('show-upcoming')],
        ]) {
            if (!enabled || !tasks.length)
                continue;
            this._rows.add_child(new St.Label({text: `${title} (${tasks.length})`, style_class: 'hud-heading'}));
            for (const task of tasks)
                this._addTask(task);
        }
    }

    _addTask(task) {
        const view = taskPresentation(task, this._settings.get_strv('task-text-filters'),
            this._settings.get_value('task-block-filters').deep_unpack());
        const button = new St.Button({style_class: 'hud-task', x_expand: true, can_focus: true,
            accessible_name: [view.content, view.doing ? 'Doing' : '', view.priority?.[0] ?? '', view.context].filter(Boolean).join(', ')});
        const row = this._verticalBox();
        const label = new St.Label({text: view.content, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        row.add_child(label);
        if (view.doing || view.priority) {
            const badges = new St.BoxLayout({style_class: 'hud-badges'});
            if (view.priority)
                badges.add_child(new St.Label({text: view.priority[0], style_class: `hud-badge hud-${view.priority[1]}`}));
            if (view.doing)
                badges.add_child(new St.Label({text: 'Doing', style_class: 'hud-badge hud-doing'}));
            row.add_child(badges);
        }
        row.add_child(new St.Label({text: view.context, style_class: 'hud-context', opacity: 170}));
        button.set_child(row);
        button.connect('clicked', () => {
            try {
                if (!view.uri)
                    throw new Error('No Logseq link is available for this task.');
                const app = Gio.AppInfo.get_default_for_uri_scheme('logseq');
                if (!app)
                    throw new Error('URI handler registration missing. Install Logseq and register its logseq:// protocol.');
                Gio.AppInfo.launch_default_for_uri_async(view.uri,
                    global.create_app_launch_context(0, -1), null, (_source, result) => {
                        try {
                            Gio.AppInfo.launch_default_for_uri_finish(result);
                            this._indicator?.menu.close();
                        } catch (error) {
                            if (this._indicator)
                                this._showMessage(`URI activation failed (${view.uri}): ${error.message}`);
                        }
                    });
            } catch (error) {
                this._showMessage(`Unable to open Logseq: ${error.message}`);
            }
        });
        const container = new St.BoxLayout({x_expand: true, reactive: true, track_hover: true});
        const hide = new St.Button({can_focus: true, accessible_name: 'Hide task',
            child: new St.Icon({icon_name: 'view-conceal-symbolic', icon_size: 16}), opacity: 0});
        const update = () => { hide.opacity = container.hover || hide.has_key_focus() || button.has_key_focus() ? 255 : 0; };
        container.connect('notify::hover', update);
        for (const actor of [button, hide]) {
            actor.connect('key-focus-in', update);
            actor.connect('key-focus-out', update);
        }
        hide.connect('clicked', () => this._confirmHide(task));
        container.add_child(button);
        container.add_child(hide);
        this._rows.add_child(container);
    }

    _confirmHide(task) {
        if (this._dialog)
            return;
        const dialog = new ModalDialog.ModalDialog();
        this._dialog = dialog;
        const content = new Dialog.MessageDialogContent({
            title: 'Hide Task?', description: task.content,
        });
        dialog.contentLayout.add_child(content);
        dialog.setButtons([
            {label: 'Cancel', default: true, key: Clutter.KEY_Escape, action: () => dialog.close()},
            {label: 'Hide Task', action: () => {
                try {
                    hideTask(this._settings, task);
                    dialog.close();
                    this._render();
                } catch (error) {
                    content.description = error.message;
                    this._showMessage(error.message);
                }
            }},
        ]);
        dialog.connect('closed', () => { this._dialog = null; });
        dialog.open();
    }

    disable() {
        this._dialog?.destroy();
        this._dialog = null;
        this._controller.close();
        this._removeTimers();
        this._settings.disconnect(this._settingsSignal);
        this._cancellable?.cancel();
        this._process?.force_exit();
        this._process = null;
        this._indicator.destroy();
        this._indicator = null;
        this._data = null;
        this._settings = null;
    }
}
