import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {backendArguments, blockContextArguments, parseBlockContext, parseTasks, taskPresentation, RefreshController, visibleTasks, hideTask} from './model.js';

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
            else
                this._hidePopup();
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
        button.connect('clicked', () => this._openTask(view.uri));
        const container = new St.BoxLayout({x_expand: true, reactive: true, track_hover: true});
        const preview = new St.Button({reactive: true, track_hover: true, can_focus: true, accessible_name: 'Preview block context',
            child: new St.Icon({icon_name: 'view-more-symbolic', icon_size: 16}), opacity: 0});
        const hide = new St.Button({can_focus: true, accessible_name: 'Hide task',
            child: new St.Icon({icon_name: 'view-conceal-symbolic', icon_size: 16}), opacity: 0});
        const update = () => {
            const visible = container.hover || hide.has_key_focus() || preview.has_key_focus() || button.has_key_focus();
            hide.opacity = preview.opacity = visible ? 255 : 0;
        };
        container.connect('notify::hover', update);
        for (const actor of [button, preview, hide]) {
            actor.connect('key-focus-in', update);
            actor.connect('key-focus-out', update);
        }
        hide.connect('clicked', () => this._confirmHide(task));
        this._bindPreview(preview, task, view.uri);
        container.add_child(button);
        container.add_child(preview);
        container.add_child(hide);
        this._rows.add_child(container);
    }

    _openTask(uri) {
        try {
            if (!uri)
                throw new Error('No Logseq link is available for this task.');
            const app = Gio.AppInfo.get_default_for_uri_scheme('logseq');
            if (!app)
                throw new Error('URI handler registration missing. Install Logseq and register its logseq:// protocol.');
            Gio.AppInfo.launch_default_for_uri_async(uri,
                global.create_app_launch_context(0, -1), null, (_source, result) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(result);
                        this._indicator?.menu.close();
                    } catch (error) {
                        if (this._indicator)
                            this._showMessage(`URI activation failed (${uri}): ${error.message}`);
                    }
                });
        } catch (error) {
            this._showMessage(`Unable to open Logseq: ${error.message}`);
        }
    }

    // One interaction owns the debounce, request and popup. Re-entry keeps the
    // fetched context; changing rows invalidates even already-queued callbacks.
    _bindPreview(preview, task, uri = taskPresentation(task).uri) {
        preview.connect('enter-event', () => this._startPreview(preview, task, false, uri));
        preview.connect('leave-event', () => {
            if (this._preview?.button === preview && !preview.hover)
                this._leavePreview();
        });
        preview.connect('clicked', () => this._startPreview(preview, task, true, uri));
        preview.connect('key-focus-out', () => {
            if (this._preview?.button === preview)
                this._queuePopupClose();
        });
        preview.connect('destroy', () => {
            if (this._preview?.button === preview)
                this._hidePopup();
        });
    }

    _startPreview(preview, task, keyboard, uri) {
        if (this._preview?.button === preview) {
            this._cancelPopupClose();
            if (keyboard) {
                this._preview.keyboard = true;
                if (this._preview.timer) {
                    GLib.Source.remove(this._preview.timer);
                    this._preview.timer = 0;
                    this._fetchPopup(this._preview, task);
                }
            }
            return;
        }
        this._hidePopup();
        const state = {button: preview, keyboard, uri, timer: 0, closeTimer: 0};
        this._preview = state;
        this._popupKeySignal = global.stage.connect('captured-event', (_stage, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._hidePopup();
                if (state.keyboard)
                    preview.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            if (this._popup && event.type() === Clutter.EventType.BUTTON_PRESS) {
                const actor = global.stage.get_event_actor(event);
                if (!this._popup.contains(actor) && !preview.contains(actor)) {
                    this._hidePopup();
                    if (!this._indicator.menu.actor.contains(actor))
                        this._indicator.menu.close();
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._popupFocusSignal = global.stage.connect('notify::key-focus', () => this._queuePopupClose());
        if (keyboard) {
            this._fetchPopup(state, task);
        } else {
            state.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                state.timer = 0;
                if (this._preview === state)
                    this._fetchPopup(state, task);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelPopupClose() {
        if (this._preview?.closeTimer) {
            GLib.Source.remove(this._preview.closeTimer);
            this._preview.closeTimer = 0;
        }
    }

    _leavePreview() {
        if (this._preview.keyboard)
            return;
        if (!this._popup) {
            this._hidePopup(); // Includes a pending debounce or in-flight query.
            return;
        }
        this._queuePopupClose();
    }

    _queuePopupClose() {
        const state = this._preview;
        if (!state)
            return;
        this._cancelPopupClose();
        // Bridge the small gap between the button and the scrollable popup.
        state.closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            state.closeTimer = 0;
            const focus = global.stage.get_key_focus();
            if (this._preview === state && !state.button.hover && !this._popup?.hover &&
                !(state.keyboard && (focus === state.button || (focus && this._popup?.contains(focus)))))
                this._hidePopup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePopup() {
        const state = this._preview;
        this._preview = null;
        for (const timer of [state?.timer, state?.closeTimer]) {
            if (timer)
                GLib.Source.remove(timer);
        }
        if (this._popupKeySignal) {
            global.stage.disconnect(this._popupKeySignal);
            this._popupKeySignal = 0;
        }
        if (this._popupFocusSignal) {
            global.stage.disconnect(this._popupFocusSignal);
            this._popupFocusSignal = 0;
        }
        if (this._popupGrab) {
            const grab = this._popupGrab;
            this._popupGrab = null;
            Main.popModal(grab);
        }
        this._popupCancellable?.cancel();
        this._popupCancellable = null;
        this._popupProcess?.force_exit();
        this._popupProcess = null;
        this._popup?.destroy();
        this._popup = null;
    }

    _fetchPopup(state, task) {
        try {
            const {args, directory} = blockContextArguments(this.path, task);
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
            launcher.set_cwd(directory);
            launcher.setenv('PYTHONPATH', directory, true);
            const process = launcher.spawnv(args);
            this._popupProcess = process;
            const cancellable = new Gio.Cancellable();
            this._popupCancellable = cancellable;
            process.communicate_utf8_async(null, cancellable, (source, result) => {
                if (this._popupProcess === process)
                    this._popupProcess = null;
                try {
                    const [, stdout, stderr] = source.communicate_utf8_finish(result);
                    if (this._preview !== state || cancellable.is_cancelled())
                        return;
                    if (!source.get_successful()) {
                        let message = stderr.trim();
                        try { message = JSON.parse(stderr).error; } catch (_error) { /* plain text */ }
                        throw new Error(message || 'Backend failed.');
                    }
                    this._renderPopup(state.button, {context: parseBlockContext(stdout), page: task.source_page});
                } catch (error) {
                    if (this._preview === state && !cancellable.is_cancelled())
                        this._renderPopup(state.button, {error: error.message});
                }
            });
        } catch (error) {
            this._popupCancellable?.cancel();
            this._popupCancellable = null;
            this._popupProcess?.force_exit();
            this._popupProcess = null;
            if (this._preview === state)
                this._renderPopup(state.button, {error: error.message});
        }
    }

    _bindPopupActivation(box, state, scroll) {
        let press = null;
        const activate = () => {
            this._hidePopup();
            this._openTask(state.uri);
        };
        const moved = event => {
            const [x, y] = event.get_coords();
            const threshold = 8 * St.ThemeContext.get_for_stage(global.stage).scale_factor;
            return Math.hypot(x - press.x, y - press.y) > threshold;
        };
        // Capture descendant events too, including labels and surface padding.
        // Observe presses/motion without consuming them so scrolling and thumb
        // drags still work; only a completed click activates navigation.
        box.connect('captured-event', (_actor, event) => {
            if (this._popup !== box || this._preview !== state)
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_event_actor(event);
            // St.ScrollView owns scrollbar actors alongside its public content
            // child. Use the actor tree: scrollbar getters were removed in 50.
            if (target && scroll.get_children().some(child =>
                child !== scroll.get_child() && child.contains(target))) {
                press = null;
                return Clutter.EVENT_PROPAGATE;
            }
            const type = event.type();
            if (type === Clutter.EventType.SCROLL) {
                press = null;
                return Clutter.EVENT_PROPAGATE;
            }
            if (type === Clutter.EventType.KEY_PRESS &&
                [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(event.get_key_symbol())) {
                activate();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.MOTION && press)
                press.dragged ||= moved(event);
            if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1) {
                const [x, y] = event.get_coords();
                press = {x, y, dragged: false};
            } else if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1 && press) {
                const clicked = !press.dragged && !moved(event);
                press = null;
                if (clicked) {
                    activate();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        box.connect('key-focus-in', () => {
            if (this._preview === state) {
                state.keyboard = true;
                this._cancelPopupClose();
            }
        });
        return () => { press = null; };
    }

    _renderPopup(preview, {context, error, page}) {
        this._popup?.destroy();
        const box = this._verticalBox();
        this._popup = box;
        try {
            // Shell supplies the surface and foreground, including theme changes.
            box.style_class = 'popup-menu popup-menu-boxpointer hud-preview';
            box.reactive = true;
            box.track_hover = true;
            box.can_focus = true;
            box.accessible_name = 'Open task in Logseq';
            const surface = this._verticalBox();
            surface.style_class = 'popup-menu-content hud-preview-surface';
            surface.y_expand = true;
            const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: false});
            scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            const content = this._verticalBox();
            content.style_class = 'hud-preview-content';
            scroll.set_child(content);
            const cancelPress = this._bindPopupActivation(box, this._preview, scroll);
            surface.add_child(scroll);
            box.add_child(surface);
            const addLabel = (text, cls, depth = 0, opacity) => {
                const label = new St.Label({text, style_class: cls, x_expand: true});
                label.clutter_text.line_wrap = true;
                label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                if (opacity !== undefined)
                    label.opacity = opacity;
                // Rows are siblings: apply one 12px step per hierarchy level,
                // independent of each label's font size, without compounding.
                const row = new St.BoxLayout({x_expand: true});
                row.set_style(`padding-left: ${depth * 12}px;`);
                row.add_child(label);
                content.add_child(row);
            };
            if (error) {
                addLabel('• ' + error, 'hud-preview-block');
            } else {
                addLabel('📄 ' + page, 'hud-preview-page');
                const separator = new St.BoxLayout({style_class: 'popup-separator-menu-item hud-preview-separator'});
                separator.add_child(new St.Widget({style_class: 'popup-separator-menu-item-separator', x_expand: true}));
                content.add_child(separator);
                let depth = 0;
                const addBlock = (block, cls, level, opacity) =>
                    addLabel(`${level === 0 ? '•' : '↳'} ${block.content}`, cls, level, opacity);
                for (const block of context.parent)
                    addBlock(block, 'hud-preview-parent', depth++, 190);
                addBlock(context.current, 'hud-preview-current', depth);
                for (const block of context.children)
                    addBlock(block, 'hud-preview-child', depth + 1);
            }
            box.connect('enter-event', () => this._cancelPopupClose());
            box.connect('leave-event', () => {
                if (!box.hover)
                    cancelPress();
                this._queuePopupClose();
            });
            box.connect('key-focus-out', () => this._queuePopupClose());
            Main.layoutManager.uiGroup.add_child(box);
            this._positionPopup(preview, box);
            // The panel menu's modal grab excludes siblings on uiGroup. Widen
            // the grab while previewing so its scrollbar receives real input.
            const focus = global.stage.get_key_focus();
            this._popupGrab = Main.pushModal(Main.layoutManager.uiGroup, {actionMode: Shell.ActionMode.POPUP});
            global.stage.set_key_focus(this._preview.keyboard ? box : focus);
            this._cancelPopupClose();
        } catch (failure) {
            this._hidePopup();
            this._showMessage(`Unable to show block context: ${failure.message}`);
        }
    }

    _positionPopup(preview, box) {
        const extents = preview.get_transformed_extents();
        const buttonX = extents.get_x();
        const buttonY = extents.get_y();
        const buttonWidth = extents.get_width();
        const buttonHeight = extents.get_height();
        const monitor = Main.layoutManager.findMonitorForActor(preview) ?? Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = 4 * scale;
        const margin = Math.min(8 * scale, area.width / 4, area.height / 4);
        const left = area.x + margin, top = area.y + margin;
        const right = area.x + area.width - margin, bottom = area.y + area.height - margin;
        const [, natWidth] = box.get_preferred_width(-1);
        const width = Math.min(natWidth, right - left);
        box.set_width(width);
        const [, natHeight] = box.get_preferred_height(width);
        const below = Math.max(0, bottom - buttonY - buttonHeight - gap);
        const above = Math.max(0, buttonY - top - gap);
        let height = Math.min(natHeight, bottom - top);
        let x = buttonX, y;
        if (height <= below) {
            y = buttonY + buttonHeight + gap;
        } else if (height <= above) {
            y = buttonY - height - gap;
        } else if (right - buttonX - buttonWidth - gap >= width) {
            x = buttonX + buttonWidth + gap;
            y = buttonY;
        } else if (buttonX - left - gap >= width) {
            x = buttonX - width - gap;
            y = buttonY;
        } else {
            height = Math.max(1, Math.min(height, Math.max(above, below)));
            y = below >= above ? buttonY + buttonHeight + gap : buttonY - height - gap;
        }
        box.set_height(height);
        x = Math.max(left, Math.min(x, right - width));
        y = Math.max(top, Math.min(y, bottom - height));
        box.set_position(Math.round(x), Math.round(y));
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
        this._hidePopup();
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
