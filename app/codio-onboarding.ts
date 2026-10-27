export const CODIO_ONBOARDING_KEY = "codio-onboarding-v1";

export type CodioOnboardingState = {
  version: 1;
  completed: boolean;
  qqSkipped: boolean;
  deepSeekSkipped: boolean;
};

export function readCodioOnboarding(storage: Pick<Storage, "getItem">): CodioOnboardingState {
  try {
    const value = JSON.parse(storage.getItem(CODIO_ONBOARDING_KEY) || "null");
    return value?.version === 1 && value?.completed === true
      ? { version: 1, completed: true, qqSkipped: value.qqSkipped === true, deepSeekSkipped: value.deepSeekSkipped === true }
      : { version: 1, completed: false, qqSkipped: false, deepSeekSkipped: false };
  } catch {
    return { version: 1, completed: false, qqSkipped: false, deepSeekSkipped: false };
  }
}

export function createCompletedOnboarding(qqSkipped: boolean, deepSeekSkipped: boolean): CodioOnboardingState {
  return { version: 1, completed: true, qqSkipped, deepSeekSkipped };
}

export function saveCodioOnboarding(storage: Pick<Storage, "setItem">, qqSkipped: boolean, deepSeekSkipped: boolean) {
  const state = createCompletedOnboarding(qqSkipped, deepSeekSkipped);
  storage.setItem(CODIO_ONBOARDING_KEY, JSON.stringify(state));
  return state;
}

export function onboardingConnectionSummary(qqConnected: boolean, deepSeekConnected: boolean, qqSkipped: boolean, deepSeekSkipped: boolean) {
  return {
    qq: qqConnected ? "connected" : qqSkipped ? "skipped" : "not_connected",
    deepSeek: deepSeekConnected ? "connected" : deepSeekSkipped ? "skipped" : "not_connected",
  } as const;
}
