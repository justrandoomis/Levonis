# LEVO Studio Android signing

Official Android releases are signed by the permanent LEVONIS production key.
The private key and its passwords must never be committed to this repository,
included in the application bundle, or printed in CI logs.

## Public signer identity

- Owner: `CN=LEVONIS LEVO Studio, OU=Mobile Engineering, O=LEVONIS, L=Baghdad, ST=Baghdad, C=IQ`
- Key alias: `levonis_levo_studio`
- Certificate SHA-256: `7a1e2f090ca588687070bf90334812e38c7431ba9f6118473f2b1925e81321e1`
- Certificate validity: through August 2056
- APK signature schemes: v2 and v3

The Android updater verifies the package name, version metadata, file SHA-256,
and this certificate fingerprint before it opens the system installer. Android
then independently requires the installed application and its update to share
the same signing identity.

## Required GitHub Actions secrets

Configure these repository secrets before creating an Android release tag:

- `LEVO_KEYSTORE_BASE64`: base64 of the production PKCS#12 keystore
- `LEVO_KEYSTORE_PASSWORD`: keystore password
- `LEVO_KEY_ALIAS`: `levonis_levo_studio`
- `LEVO_KEY_PASSWORD`: private-key password

Never use a debug keystore for a published build. The release workflow rejects
missing secrets, verifies the permanent certificate fingerprint, and publishes
only a verified APK. A release tag must match the Android `versionName`, for
example `v1.1.0`.

## Recovery

LEVONIS maintains a separately encrypted backup named
`LEVONIS-LEVO-Studio-signing-backup.tar.enc`. To recover it, store the encrypted
file and its recovery password in separate secure locations, then run:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -in LEVONIS-LEVO-Studio-signing-backup.tar.enc \
  -out LEVONIS-LEVO-Studio-signing-backup.tar
tar -xf LEVONIS-LEVO-Studio-signing-backup.tar
```

Losing this key prevents Android from accepting future in-place updates for
existing LEVO Studio installations.
