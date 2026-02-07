# React Native Integration Smoke

This folder provides a dedicated integration smoke suite for:

- `localspace/react-native`
- `@react-native-async-storage/async-storage` (official Jest mock)

It is intentionally isolated from the main unit test pipeline.

## Run

From repository root:

```bash
yarn test:rn:integration
```

If you want to install once and then run test directly:

```bash
yarn test:rn:integration:setup
yarn build
yarn --cwd integration/react-native-jest test
```

## Notes

- This suite validates integration wiring and API compatibility using the official AsyncStorage Jest mock.
- For true device-runtime verification (Hermes/Metro/native bridge), run an app-level E2E workflow in a React Native app/simulator pipeline.
