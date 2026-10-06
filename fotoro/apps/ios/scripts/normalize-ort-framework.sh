#!/bin/sh
set -eu

# Only the copied, archive-time resource framework is changed. Its runtime is
# statically linked into Fotoro; Xcode generates this empty dylib for packaging.
ort_framework="${TARGET_BUILD_DIR:?}/${FRAMEWORKS_FOLDER_PATH:?}/onnxruntime.framework"
ort_plist="$ort_framework/Info.plist"
test "${PLATFORM_NAME:?}" = iphoneos
test "${TARGET_NAME:?}" = Fotoro
test "${ACTION:?}" = install
test "${CODE_SIGNING_ALLOWED:?}" = YES
test -n "${EXPANDED_CODE_SIGN_IDENTITY:?}"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$ort_plist")" = com.microsoft.onnxruntime
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ort_plist")" = 1.24.2
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ort_plist")" = onnxruntime

/usr/libexec/PlistBuddy -c "Set :MinimumOSVersion ${IPHONEOS_DEPLOYMENT_TARGET:?}" "$ort_plist"
# The implicit copy already signed the framework. Re-sign the corrected bundle
# before Xcode signs the containing app; never leave modified signed metadata.
/usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
  --preserve-metadata=identifier,entitlements,flags --generate-entitlement-der "$ort_framework"
/usr/bin/codesign --verify --strict "$ort_framework"
/usr/bin/touch "${SCRIPT_OUTPUT_FILE_0:?}"
printf 'Normalized ONNX Runtime archive deployment metadata.\n'
