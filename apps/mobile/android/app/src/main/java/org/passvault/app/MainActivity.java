package org.passvault.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts, or the web layer's first call
        // lands before the plugin exists.
        registerPlugin(PassVaultNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
