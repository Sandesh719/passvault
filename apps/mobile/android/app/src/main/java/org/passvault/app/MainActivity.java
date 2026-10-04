package org.passvault.app;

import android.os.Bundle;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts, or the web layer's first call
        // lands before the plugin exists.
        registerPlugin(PassVaultNativePlugin.class);
        super.onCreate(savedInstanceState);

        // From Android 15 the system draws its clock and icons over the app
        // rather than beside it. They default to dark, which on this app's
        // header means invisible — so ask for the light set. How much room
        // they take is reported by the plugin's `insets`, which the web layer
        // asks for once it is ready to use the answer.
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
    }
}
