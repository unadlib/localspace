import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { LocalSpace } from 'localspace';
import { createReactNativeInstance } from 'localspace/react-native';
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

async function runSmokeOperation(): Promise<string> {
  const base = new LocalSpace();
  const store = await createReactNativeInstance(base, {
    name: 'localspace-detox',
    storeName: 'kv',
    reactNativeAsyncStorage: AsyncStorage,
  });

  await store.setItem('token', 'detox-ok');
  const value = await store.getItem<string>('token');

  if (value !== 'detox-ok') {
    return `mismatch:${String(value)}`;
  }

  return `ok`;
}

function App() {
  const [status, setStatus] = useState<string>('idle');
  const [busy, setBusy] = useState(false);

  const onRunSmoke = useCallback(async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setStatus('running');

    try {
      const result = await runSmokeOperation();
      setStatus(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown runtime error';
      setStatus(`error:${message.slice(0, 80)}`);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.container}>
        <Text style={styles.title}>Localspace RN Detox Fixture</Text>
        <Text style={styles.subtitle}>Status</Text>
        <Text testID="status-value" style={styles.statusValue}>
          {status}
        </Text>
        <Pressable
          testID="run-smoke-button"
          accessibilityRole="button"
          onPress={onRunSmoke}
          style={({ pressed }) => [
            styles.button,
            pressed ? styles.buttonPressed : null,
            busy ? styles.buttonDisabled : null,
          ]}
          disabled={busy}
        >
          <Text style={styles.buttonText}>
            {busy ? 'Running...' : 'Run Storage Smoke'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f6f8fb',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0b1f34',
  },
  subtitle: {
    fontSize: 16,
    color: '#44556b',
  },
  statusValue: {
    fontSize: 20,
    fontWeight: '600',
    color: '#0d3b66',
    minHeight: 28,
  },
  button: {
    marginTop: 20,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#0d6efd',
  },
  buttonPressed: {
    backgroundColor: '#0a58ca',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default App;
