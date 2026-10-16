// Acknowledging the guide only saves a UI preference; it never starts work.
function dismiss(a) {
  if (a.data.runtime.onboarding?.version >= 2 && a.data.runtime.onboarding?.seenAt) return a.publicState();
  const previous = a.data.runtime.onboarding;
  a.data.runtime.onboarding = { version: 2, seenAt: new Date().toISOString() };
  try { a.save(); }
  catch (error) {
    if (previous === undefined) delete a.data.runtime.onboarding;
    else a.data.runtime.onboarding = previous;
    throw error;
  }
  return a.publicState();
}
module.exports = { dismiss };
