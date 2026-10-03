package org.passvault.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The two things an Android WebView cannot do for itself.
 *
 * <p><b>Holding a file the user can see.</b> Everything in the app's own
 * storage is invisible to other apps, so a vault kept there could never be
 * opened by KeePassDX — which is the entire point of syncing it. The Storage
 * Access Framework is the only way to work on a document that lives in the
 * user's Documents folder, or on Drive, or anywhere else a provider exposes,
 * and to still be allowed to open it after a reboot. That last part is
 * {@code takePersistableUriPermission}, and there is no web equivalent.
 *
 * <p><b>Protecting the device key.</b> That key is this device's identity:
 * losing it means pairing again, leaking it means another machine can
 * impersonate this one. App-private storage keeps other apps out, but the
 * bytes are still plaintext to anything that can read the data directory. A
 * key generated in the AndroidKeyStore can be used by this app and cannot be
 * extracted from it, which is the same bargain Electron's safeStorage strikes
 * with the desktop keychain.
 */
@CapacitorPlugin(name = "PassVaultNative")
public class PassVaultNativePlugin extends Plugin {

    private static final String KEY_ALIAS = "passvault.device-key";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    /** GCM's standard nonce length. Stored in front of the ciphertext. */
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    // ---- choosing the file ------------------------------------------------

    @PluginMethod
    public void pickVault(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // A .kdbx has no registered type, and providers that filter strictly
        // would hide it. Everything is offered and the file is validated by
        // being opened as a vault, which is the only real check anyway.
        intent.setType("*/*");
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "onDocumentPicked");
    }

    @PluginMethod
    public void createVault(PluginCall call) {
        String suggested = call.getString("suggestedName", "Shared.kdbx");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, suggested);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "onDocumentPicked");
    }

    @ActivityCallback
    private void onDocumentPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        try {
            // Without this the grant dies with the activity, and the vault
            // becomes unreadable the next time the app starts — which would
            // look like the app forgetting the file for no reason.
            getContext()
                .getContentResolver()
                .takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
        } catch (SecurityException error) {
            // Some providers do not offer a lasting grant. The file still works
            // for now, so this is not worth refusing over — the app notices a
            // stale grant later and asks for the file again.
        }

        JSObject picked = new JSObject();
        picked.put("cancelled", false);
        picked.put("uri", uri.toString());
        picked.put("name", displayNameOf(uri));
        call.resolve(picked);
    }

    private String displayNameOf(Uri uri) {
        try (Cursor cursor =
                getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception error) {
            // Fall through to the last path segment.
        }
        String fallback = uri.getLastPathSegment();
        return fallback == null ? "vault.kdbx" : fallback;
    }

    // ---- reading and writing it -------------------------------------------

    @PluginMethod
    public void readVault(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("a uri is required");
            return;
        }
        try (InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
            if (input == null) {
                call.reject("could not open that file");
                return;
            }
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                collected.write(buffer, 0, read);
            }
            JSObject response = new JSObject();
            response.put("data", Base64.encodeToString(collected.toByteArray(), Base64.NO_WRAP));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("could not read that file: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void writeVault(PluginCall call) {
        String uri = call.getString("uri");
        String data = call.getString("data");
        if (uri == null || data == null) {
            call.reject("a uri and data are required");
            return;
        }
        // "wt" truncates. Without the t a shorter vault would leave the tail of
        // the previous one behind and the file would no longer parse.
        try (OutputStream output =
                getContext().getContentResolver().openOutputStream(Uri.parse(uri), "wt")) {
            if (output == null) {
                call.reject("could not open that file for writing");
                return;
            }
            output.write(Base64.decode(data, Base64.NO_WRAP));
            output.flush();
            call.resolve();
        } catch (Exception error) {
            call.reject("could not write that file: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        String uri = call.getString("uri");
        JSObject response = new JSObject();
        if (uri == null) {
            response.put("granted", false);
            call.resolve(response);
            return;
        }
        boolean granted = false;
        for (android.content.UriPermission held :
                getContext().getContentResolver().getPersistedUriPermissions()) {
            if (held.getUri().toString().equals(uri) && held.isWritePermission()) {
                granted = true;
                break;
            }
        }
        response.put("granted", granted);
        call.resolve(response);
    }

    // ---- protecting the device key ----------------------------------------

    @PluginMethod
    public void canProtect(PluginCall call) {
        JSObject response = new JSObject();
        try {
            secretKey();
            response.put("available", true);
        } catch (Exception error) {
            response.put("available", false);
        }
        call.resolve(response);
    }

    @PluginMethod
    public void protect(PluginCall call) {
        String plaintext = call.getString("plaintext");
        if (plaintext == null) {
            call.reject("plaintext is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(plaintext.getBytes("UTF-8"));

            byte[] combined = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(sealed, 0, combined, iv.length, sealed.length);

            JSObject response = new JSObject();
            response.put("ciphertext", Base64.encodeToString(combined, Base64.NO_WRAP));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("could not protect that value: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void unprotect(PluginCall call) {
        String ciphertext = call.getString("ciphertext");
        if (ciphertext == null) {
            call.reject("ciphertext is required");
            return;
        }
        try {
            byte[] combined = Base64.decode(ciphertext, Base64.NO_WRAP);
            byte[] iv = new byte[IV_BYTES];
            System.arraycopy(combined, 0, iv, 0, IV_BYTES);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(TAG_BITS, iv));
            byte[] opened = cipher.doFinal(combined, IV_BYTES, combined.length - IV_BYTES);

            JSObject response = new JSObject();
            response.put("plaintext", new String(opened, "UTF-8"));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("could not read the protected value: " + error.getMessage(), error);
        }
    }

    /**
     * The wrapping key, created once and never leaving the keystore.
     *
     * Deliberately not requiring user authentication: the app has to be able to
     * answer a peer and write an updated vault while the phone is in someone's
     * pocket, and a key that needs a fingerprint first would make background
     * sync impossible.
     */
    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(
            new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }
}
