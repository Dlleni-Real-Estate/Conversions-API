package com.dlleni.agent;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Phone makers' own "let this app run" switches.
 *
 * Xiaomi, Oppo, Realme, Vivo, Huawei, Honor, Infinix, Tecno and OnePlus all
 * kill an app that is not on their private allow-list as soon as it leaves the
 * screen - foreground service or not - and stop it from starting again. No
 * Android API turns that off; the agent has to flip the switch in the maker's
 * screen once. These are those screens, newest first per maker. The list of
 * packages is mirrored in the manifest's <queries>, or Android 11+ hides them.
 */
final class Oem {
    private Oem() {}

    private static final String[][] AUTOSTART = {
            // Xiaomi, Redmi, POCO
            {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
            // Oppo, Realme (ColorOS)
            {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
            {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
            {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
            // Vivo, iQOO
            {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
            {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"},
            {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"},
            // Huawei, Honor
            {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"},
            {"com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"},
            {"com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
            // Infinix, Tecno, itel (Transsion)
            {"com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"},
            // OnePlus
            {"com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"},
            // Asus
            {"com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"},
            {"com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity"},
    };

    /** Xiaomi's "Other permissions": show on lock screen, pop up from the background. */
    private static final String[][] XIAOMI_POPUP = {
            {"com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity"},
            {"com.miui.securitycenter", "com.miui.permcenter.permissions.AppPermissionsEditorActivity"},
    };

    static String maker() {
        return Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
    }

    static boolean isXiaomi() {
        String m = maker();
        return m.contains("xiaomi") || m.contains("redmi") || m.contains("poco");
    }

    private static Intent first(Context c, String[][] list, boolean xiaomiExtras) {
        PackageManager pm = c.getPackageManager();
        for (String[] comp : list) {
            Intent i = new Intent()
                    .setComponent(new ComponentName(comp[0], comp[1]))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (xiaomiExtras) {
                i.setAction("miui.intent.action.APP_PERM_EDITOR");
                i.putExtra("extra_pkgname", c.getPackageName());
            }
            try {
                if (pm.resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY) != null) return i;
            } catch (RuntimeException ignored) {
                // Try the next one.
            }
        }
        return null;
    }

    /** This phone's autostart screen, or null when it has none (stock Android, Samsung, Pixel). */
    static Intent autostart(Context c) {
        return first(c, AUTOSTART, false);
    }

    /** Xiaomi's lock-screen / pop-up permissions, or null on other phones. */
    static Intent popup(Context c) {
        return isXiaomi() ? first(c, XIAOMI_POPUP, true) : null;
    }

    /** Opens it; false if the phone refused (not exported, moved in an update). */
    static boolean open(Context c, Intent i) {
        if (i == null) return false;
        try {
            c.startActivity(i);
            return true;
        } catch (RuntimeException refused) {
            return false;
        }
    }
}
