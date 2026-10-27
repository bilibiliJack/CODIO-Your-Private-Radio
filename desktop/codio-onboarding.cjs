const path = require("node:path");
const fs = require("node:fs/promises");

const DEFAULT_ONBOARDING = Object.freeze({
  version: 1,
  completed: false,
  qqSkipped: false,
  deepSeekSkipped: false,
});

function normalizeOnboardingState(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || value.completed !== true) {
    return { ...DEFAULT_ONBOARDING };
  }
  return {
    version: 1,
    completed: true,
    qqSkipped: value.qqSkipped === true,
    deepSeekSkipped: value.deepSeekSkipped === true,
  };
}

function onboardingStatePath(userDataPath) {
  return path.join(userDataPath, "codio-onboarding-v1.json");
}

async function readOnboardingState(userDataPath) {
  try {
    return normalizeOnboardingState(JSON.parse(await fs.readFile(onboardingStatePath(userDataPath), "utf8")));
  } catch {
    return { ...DEFAULT_ONBOARDING };
  }
}

async function saveOnboardingState(userDataPath, value) {
  const normalized = normalizeOnboardingState(value);
  if (!normalized.completed) throw new Error("ONBOARDING_STATE_INVALID");
  await fs.mkdir(userDataPath, { recursive: true });
  const target = onboardingStatePath(userDataPath);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(normalized), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  return normalized;
}

module.exports = {
  DEFAULT_ONBOARDING,
  normalizeOnboardingState,
  onboardingStatePath,
  readOnboardingState,
  saveOnboardingState,
};
