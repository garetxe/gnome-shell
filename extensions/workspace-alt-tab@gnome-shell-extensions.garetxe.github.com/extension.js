// Make Alt-Tab window-based, rather than app based. This is a simple
// modification of windows-alt-tab (by tglman) adding support for
// windows in other workspaces.
const AltTab = imports.ui.altTab;
const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const ModalDialog = imports.ui.modalDialog;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Tweener = imports.ui.tweener;
const WindowManager = imports.ui.windowManager;

const N_ = function(e) { return e };

const POPUP_FADE_TIME = 0.0; // seconds


function AltTabPopupW() {
    this._init();
}

AltTabPopupW.prototype = {
    __proto__ : AltTab.AltTabPopup.prototype,

    show : function(backward, switch_group) {
        let appSys = Shell.AppSystem.get_default();
        let apps = appSys.get_running ();

        if (!apps.length)
            return false;

        if (!Main.pushModal(this.actor))
            return false;
        this._haveModal = true;

        this.actor.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
        this.actor.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));

        this.actor.connect('button-press-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));

        this._appSwitcher = new WindowSwitcher(apps, this);
        this.actor.add_actor(this._appSwitcher.actor);
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-entered', Lang.bind(this, this._appEntered));

        this._appIcons = this._appSwitcher.icons;

        // Make the initial selection
        if (switch_group) {
            if (backward) {
                this._select(0, this._appIcons[0].cachedWindows.length - 1);
            } else {
                if (this._appIcons[0].cachedWindows.length > 1)
                    this._select(0, 1);
                else
                    this._select(0, 0);
            }
        } else if (this._appIcons.length == 1) {
            this._select(0);
        } else if (backward) {
            this._select(this._appIcons.length - 1);
        } else {
            this._select(1);
        }

        let [x, y, mods] = global.get_pointer();
        if (!(mods & Gdk.ModifierType.MOD1_MASK)) {
            this._finish();
            return false;
        }

        this.actor.opacity = 0;
        this.actor.show();
        Tweener.addTween(this.actor,
                         { opacity: 255,
                           time: POPUP_FADE_TIME,
                           transition: 'easeOutQuad'
                         });
        return true;
    },

    _keyReleaseEvent : function(actor, event) {
        let [x, y, mods] = global.get_pointer();
        if (!(mods & Gdk.ModifierType.MOD1_MASK))
            this._finish();

        return true;
    },

    _finish : function() {
        let app = this._appIcons[this._currentApp];
        Main.activateWindow(app.cachedWindows[0]);
        this.destroy();
    }

};

function AppIcon(app, window) {
    this._init(app, window);
}
        
AppIcon.prototype = {
    __proto__ : AltTab.AppIcon.prototype,

    _init: function(app, window) {
        this.app = app;

        this.cachedWindows = [];
        this.cachedWindows.push(window);

        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                         vertical: true });
        this.icon = null;
        this._iconBin = new St.Bin({ x_fill: true, y_fill: true });

        this.actor.add(this._iconBin, { x_fill: false, y_fill: false } );

        let title = window.get_title();
        if (title) {
            this.label = new St.Label({ text: title });
            let bin = new St.Bin({ x_align: St.Align.MIDDLE });
            bin.add_actor(this.label);
            this.actor.add(bin);
        }
        else {
            this.label = new St.Label({ text: this.app.get_name() });
            this.actor.add(this.label, { x_fill: false });
        }
    }
};

function WindowSwitcher(apps, altTabPopup) {
    this._init(apps, altTabPopup);
}

WindowSwitcher.prototype = {
    __proto__ : AltTab.AppSwitcher.prototype,

    _init : function(apps, altTabPopup) {
        AltTab.SwitcherList.prototype._init.call(this, true);

        let activeWorkspace = global.screen.get_active_workspace();
        let activeWorkspaceIcons = [];
	let otherWorkspacesIcons = [];
        for (let i = 0; i < apps.length; i++) {
            let windows = apps[i].get_windows();
            for(let j = 0; j < windows.length; j++) {
                let appIcon = new AppIcon(apps[i], windows[j]);
                if (this._isWindowOnWorkspace(windows[j], activeWorkspace)) {
                    activeWorkspaceIcons.push(appIcon);
                } else {
		    otherWorkspacesIcons.push(appIcon);
		}
            }
        }

        activeWorkspaceIcons.sort(Lang.bind(this, this._sortAppIcon));
        otherWorkspacesIcons.sort(Lang.bind(this, this._sortAppIcon));

        this.icons = [];
        this._arrows = [];
        for (let i = 0; i < activeWorkspaceIcons.length; i++)
            this._addIcon(activeWorkspaceIcons[i]);
	if (activeWorkspaceIcons.length > 0 && otherWorkspacesIcons.length > 0)
	    this.addSeparator();
	for (let i = 0; i < otherWorkspacesIcons.length; i++)
	    this._addIcon(otherWorkspacesIcons[i]);

        this._curApp = -1;
        this._iconSize = 0;
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;
    },

    highlight: function(index, justOutline) {
        if (this._highlighted != -1) {
            this._items[this._highlighted].remove_style_pseudo_class('outlined');
            this._items[this._highlighted].remove_style_pseudo_class('selected');
        }

        this._highlighted = index;

        if (this._highlighted != -1) {
            if (justOutline)
                this._items[this._highlighted].add_style_pseudo_class('outlined');
            else
                this._items[this._highlighted].add_style_pseudo_class('selected');
        }

        let [absItemX, absItemY] = this._items[index].get_transformed_position();
        let [result, posX, posY] = this.actor.transform_stage_point(absItemX, 0);
        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        
        if (posX + this._items[index].get_width() > containerWidth)
            this._scrollToRight();
        else if (absItemX < 0)
            this._scrollToLeft();

    },

    _isWindowOnWorkspace: function(w, workspace) {
            if (w.get_workspace() == workspace)
                return true;
        return false;
    },

    _sortAppIcon : function(appIcon1, appIcon2) {
        let t1 = appIcon1.cachedWindows[0].get_user_time();
        let t2 = appIcon2.cachedWindows[0].get_user_time();
        if (t2 > t1) return 1;
        else return -1;
    }
};

function init(metadata) {
}

function doAltTab(shellwm, binding, window, backwards) {
    new AltTabPopupW().show();
}

function enable() {
    Main.wm.setKeybindingHandler('switch_windows', doAltTab);
    Main.wm.setKeybindingHandler('switch_group', doAltTab);
    Main.wm.setKeybindingHandler('switch_windows_backward', doAltTab);
    Main.wm.setKeybindingHandler('switch_group_backward', doAltTab);
}

function disable() {
    Main.wm.setKeybindingHandler('switch_windows', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_group', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_windows_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Main.wm.setKeybindingHandler('switch_group_backward', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
}
