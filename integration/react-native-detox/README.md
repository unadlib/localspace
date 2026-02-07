# Localspace React Native Detox Fixture

This is a real React Native fixture app used by:

- `.github/workflows/detox-mobile.yml`

It validates `localspace/react-native` in iOS simulator runtime via Detox.

## What This App Tests

- `createReactNativeInstance()` with real `@react-native-async-storage/async-storage`
- basic write/read smoke path through localspace
- iOS Detox boot + interaction flow in CI
- Android Detox path for local/manual verification

## Detox Configurations

- `ios.sim.release`
- `android.emu.release`

## Local Commands

Build localspace first (from repository root):

```bash
yarn install
yarn build
```

Then in this fixture directory install dependencies:

```bash
yarn install
```

Run iOS:

```bash
bundle install
cd ios && bundle exec pod install && cd ..
yarn build:ios:detox
yarn test:ios:detox
```

Run Android:

```bash
yarn build:android:detox
yarn test:android:detox
```

## CI Notes

- GitHub workflow uses this directory as `DETOX_APP_DIR`.
- CI keeps iOS Detox as the blocking runtime check.
- Android Detox can still be run locally with the commands above.
- iOS job uses `macos-latest` and installs `applesimutils`.
