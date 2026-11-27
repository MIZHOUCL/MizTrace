const externalUrlAllowed = (value) => {
  try {
    const u = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) && !u.username && !u.password && value.length < 4096;
  } catch { return false; }
};
const isAppUrl = (value, origin) => {
  try { return new URL(value).origin === origin; } catch { return false; }
};
module.exports = { externalUrlAllowed, isAppUrl };
