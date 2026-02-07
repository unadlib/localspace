describe('localspace react-native smoke', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true, delete: true });
  });

  it('runs AsyncStorage smoke operation through localspace', async () => {
    await waitFor(element(by.id('run-smoke-button')))
      .toBeVisible()
      .withTimeout(20000);

    await element(by.id('run-smoke-button')).tap();

    await waitFor(element(by.id('status-value')))
      .toHaveText('ok')
      .withTimeout(30000);
  });
});
