export function checkedChannel(name) {
  if (name !== 'stable' && name !== 'nightly') throw new Error('APEX_CHANNEL must be stable or nightly');
  return name;
}

export function nightlyIdentity({ buildNumber, commit }) {
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0 ||
      typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Nightly requires a positive build number and full source SHA');
  }
  return { buildNumber, commit };
}
