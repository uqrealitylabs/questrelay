package com.uqrealitylabs.questrelay;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Secret {
    private static final String ALIAS = "questrelay-publisher";
    private static final String STORE = "questrelay-secrets";

    private Secret() { }

    static void save(Context context, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] packed = new byte[cipher.getIV().length + encrypted.length];
        System.arraycopy(cipher.getIV(), 0, packed, 0, cipher.getIV().length);
        System.arraycopy(encrypted, 0, packed, cipher.getIV().length, encrypted.length);
        String encoded = Base64.encodeToString(packed, Base64.NO_WRAP);
        if (!context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
                .edit().putString("key", encoded).commit()) {
            throw new IllegalStateException("Could not save publisher key");
        }
    }

    static String load(Context context) throws Exception {
        String encoded = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
                .getString("key", null);
        if (encoded == null) return "";
        byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
        if (packed.length < 29) throw new IllegalStateException("Saved publisher key is damaged");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, packed, 0, 12));
        byte[] plain = cipher.doFinal(packed, 12, packed.length - 12);
        return new String(plain, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,
                "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }
}
