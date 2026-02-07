package com.localspacedetoxfixture;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.rule.ActivityTestRule;
import com.wix.detox.Detox;
import com.wix.detox.config.DetoxConfig;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DetoxTest {
  @Rule
  public ActivityTestRule<MainActivity> activityRule =
      new ActivityTestRule<>(MainActivity.class, false, false);

  @Test
  public void runDetox() {
    DetoxConfig config = new DetoxConfig();
    config.idlePolicyConfig.masterTimeoutSec = 120;
    Detox.runTests(activityRule, config);
  }
}
