# Localspace React Native Detox Fixture

This is a real React Native fixture app used by the manual workflow:

- `.github/workflows/detox-mobile.yml`

It validates `localspace/react-native` in iOS simulator runtime via Detox.

## What This App Tests

- `createReactNativeInstance()` with real `@react-native-async-storage/async-storage`
- basic write/read smoke path through localspace
- iOS Detox boot + interaction flow when manually dispatched
- Android Detox path for local/manual verification

## Detox Configurations

- `ios.sim.release`
- `android.emu.release`

## Local Commands

Build localspace first (from repository root):

```bash
pnpm install
pnpm run build
```

Then install fixture dependencies (from repository root):

```bash
pnpm --filter localspace-detox-fixture install --prod=false
```

Run iOS:

```bash
bundle install
cd ios && bundle exec pod install && cd ..
pnpm run build:ios:detox
pnpm run test:ios:detox
```

Run Android:

```bash
pnpm run build:android:detox
pnpm run test:android:detox
```

## Workflow Notes

- GitHub workflow uses this directory as `DETOX_APP_DIR`.
- The iOS Detox workflow is manually dispatched and is not part of blocking CI.
- Android Detox can still be run locally with the commands above.
- iOS job uses `macos-latest` and installs `applesimutils`.
